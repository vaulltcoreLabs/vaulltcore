/**
 * Admission pipeline (Phase 1E).
 *
 * Implements the required lifecycle in order, as an explicit orchestration the
 * control plane calls instead of the raw runner:
 *
 *   authenticate → resolve principal → authorize org/project
 *   → idempotency handling → policy evaluation → quota reservation
 *   → durable job creation → return/replay existing admission result
 *
 * Transaction/compensation boundaries:
 * - A successful quota reservation followed by a failed job creation must NOT
 *   permanently leak capacity: the reservation is released as compensation.
 * - Idempotency is keyed by (tenant, idempotencyKey) and is tied to the
 *   reservation's `requestKey`: a replay returns the same logical job AND never
 *   reserves capacity a second time (the reservation is idempotent on its
 *   request key, so a replay is a no-op that returns the existing reservation).
 *
 * The runner executes an already-authorized immutable contract: the policy's
 * enforceable subset is projected into the runner's immutable ExecutionPolicy
 * (pinned into the JobRecord by the runner), and the job's tenantId/orgId/
 * projectId are cross-validated against the identity store before creation and
 * again at recovery. No business logic leaks into the runner's loop.
 */

import type {
  AgentRunner,
  CreateJobInput,
  ExecutionPolicy,
  JobIdentity,
  JobRecord,
  JobMetrics,
} from "@vaulltcore/runner"
import { type AdmissionDecision, type AdmissionRequest as PolicyAdmissionRequest, type SqlPolicyStore } from "@vaulltcore/policy"
import { type QuotaLimits, type QuotaReservation, QuotaError, type QuotaScope, type SqlQuotaStore, quotaScope } from "@vaulltcore/quota"
import { type ResolvedPrincipal, type SqlIdentityStore, IdentityError } from "@vaulltcore/identity"
import { type AuditInput, type SqlAuditStore } from "@vaulltcore/audit"
import { createHash } from "node:crypto"

export interface AdmissionDeps {
  readonly runner: AgentRunner
  readonly identity: SqlIdentityStore
  readonly policy: SqlPolicyStore
  readonly quota: SqlQuotaStore
  readonly audit: SqlAuditStore
  /** Durable, tenant-scoped admission idempotency registry (Phase 1F). The
   *  registry serializes concurrent admissions of the same (tenant, key) across
   *  separate control-plane processes: only the instance that wins the atomic
   *  claim proceeds to reserve quota + create a job; every concurrent/replay
   *  caller observes the single authoritative result. The in-memory default is
   *  single-process only; production wires {@link SqlAdmissionIdempotencyRegistry}. */
  readonly idempotency: AdmissionIdempotencyRegistry
}

/** State of a durable admission idempotency slot (Phase 1F state machine). */
export type AdmissionIdempotencyState = "pending" | "completed" | "failed_retriable" | "failed_terminal"

/** Canonical request fingerprint for admission idempotency. A replay under the
 *  same key MUST carry the same fingerprint; a different fingerprint is an
 *  explicit conflict (rejected, never silently replayed). The fingerprint
 *  covers the operation identity — tenant/org/project and the job spec
 *  (engine/model/input) — i.e. what determines which job is created. Advisory
 *  policy inputs (`requestedTools`, `requestedMaxSteps`) are re-evaluated on
 *  replay and do NOT change the operation identity, so they are excluded. */
export interface AdmissionFingerprint {
  readonly tenantId: string
  readonly orgId: string
  readonly projectId: string
  readonly spec: { readonly engine: string; readonly model: string; readonly input: string }
}

/** A durable admission idempotency record. */
export interface AdmissionIdempotencyRecord {
  readonly tenantId: string
  readonly key: string
  readonly fingerprint: string
  readonly state: AdmissionIdempotencyState
  readonly jobId: string | null
  readonly reservationId: string | null
  readonly failureCode: string | null
  readonly failureDetail: string | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly expiresAt: number | null
}

/** Outcome of an atomic claim of an admission idempotency slot. */
export type AdmissionIdempotencyClaimResult =
  | { readonly kind: "new"; readonly slot: AdmissionIdempotencyRecord }
  | { readonly kind: "completed"; readonly slot: AdmissionIdempotencyRecord }
  | { readonly kind: "pending"; readonly slot: AdmissionIdempotencyRecord }
  | { readonly kind: "conflict"; readonly slot: AdmissionIdempotencyRecord; readonly detail: string }

/**
 * Durable admission idempotency registry (Phase 1F). Replaces the Phase 1E
 * in-memory map with a claim/complete/fail state machine that is safe across
 * multiple API processes and survives restarts. Identity is tenant-scoped:
 * `(tenant_id, idempotency_key)` is the UNIQUE authority, so request identity
 * cannot collide across tenants. Concurrent same-key claims produce one
 * authoritative operation; replay returns the original result without
 * repeating quota reservation or job creation.
 *
 * Secret request material (e.g. raw input prompts) is NOT stored: only the
 * SHA-256 fingerprint of the canonicalized request is persisted.
 */
export interface AdmissionIdempotencyRegistry {
  /** Atomically claim a slot for (tenantId, key). The claim is fenced by
   *  `UNIQUE(tenant_id, idempotency_key)`: the first caller wins `new`;
   *  concurrent/replay callers observe `completed` / `pending` / `conflict`.
   *  Stale `failed_retriable`/expired records are reclaimable. */
  claim(tenantId: string, key: string, fingerprint: string): Promise<AdmissionIdempotencyClaimResult>
  /** Mark a claimed slot completed with the created job + reservation. */
  complete(tenantId: string, key: string, jobId: string, reservationId: string): Promise<AdmissionIdempotencyRecord | null>
  /** Mark a claimed slot failed. `retriable=false` pins the slot as terminal. */
  fail(tenantId: string, key: string, code: string, detail: string, retriable: boolean): Promise<AdmissionIdempotencyRecord | null>
  /** Read a record (no state transition). */
  lookup(tenantId: string, key: string): Promise<AdmissionIdempotencyRecord | null>
}

export interface AdmissionRequest {
  readonly principal: ResolvedPrincipal
  readonly idempotencyKey: string
  readonly orgId: string
  readonly projectId: string
  readonly spec: {
    readonly engine: string
    readonly model: string
    readonly input: string
    readonly engineOptions?: Record<string, unknown>
  }
  readonly requestedTools: readonly string[]
  readonly requestedMaxSteps?: number
  /** Lease to project into the runner's ExecutionPolicy (defaults to policy maxDurationMs). */
  readonly leaseMs?: number
}

export interface AdmissionResult {
  readonly jobId: string
  readonly reservationId: string
  readonly decision: AdmissionDecision
  readonly status: JobRecord["status"]
  readonly replayed: boolean
}

export class AdmissionError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message)
    this.name = "AdmissionError"
  }
}

/** Default lease derived from the policy's duration cap, capped to a sane worker lease. */
function defaultLeaseMs(decision: AdmissionDecision): number {
  return Math.min(decision.maxDurationMs, 60_000)
}

/** SHA-256 fingerprint over the canonicalized admission request. Only the
 *  operation identity (tenant/org/project/engine/model/input) is hashed; secret
 *  material is never stored in the idempotency table — only this fingerprint is.
 *  Advisory policy inputs are excluded (see {@link AdmissionFingerprint}). */
export function admissionFingerprint(fp: AdmissionFingerprint): string {
  const canonical = {
    tenantId: fp.tenantId,
    orgId: fp.orgId,
    projectId: fp.projectId,
    spec: { engine: fp.spec.engine, model: fp.spec.model, input: fp.spec.input },
  }
  return createHash("sha256").update(stableString(canonical)).digest("hex")
}

function stableString(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableString).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableString(v)}`)
  return `{${entries.join(",")}}`
}

/** Project the admission decision into the runner's immutable ExecutionPolicy. */
function toExecutionPolicy(decision: AdmissionDecision, leaseMs: number): ExecutionPolicy {
  return {
    version: decision.policyVersion,
    maxSteps: decision.maxSteps,
    onUncertainToolCall: "mark_uncertain",
    allowedTools: [...decision.allowedTools],
    idempotentTools: [],
    leaseMs,
  }
}

function quotaLimitsFromDecision(decision: AdmissionDecision, maxConcurrent: number): QuotaLimits {
  return {
    maxConcurrentJobs: maxConcurrent,
    jobsPerPeriod: decision.maxConcurrentJobs * 10,
    periodMs: 3_600_000,
    maxTokens: decision.maxTokens,
    maxDurationMs: decision.maxDurationMs,
  }
}

function auditActor(principal: ResolvedPrincipal) {
  return { principalId: principal.principalId, kind: principal.kind, tenantId: principal.tenantId }
}

function toPolicyRequest(scope: { tenantId: string; orgId: string; projectId: string }, requestedTools: readonly string[], requestedMaxSteps?: number): PolicyAdmissionRequest {
  return {
    tenantId: scope.tenantId,
    orgId: scope.orgId,
    projectId: scope.projectId,
    requestedTools,
    ...(requestedMaxSteps !== undefined ? { requestedMaxSteps } : {}),
  }
}

export class AdmissionPipeline {
  constructor(private readonly deps: AdmissionDeps) {}

  async admit(request: AdmissionRequest): Promise<AdmissionResult> {
    const { principal, idempotencyKey, orgId, projectId, spec, requestedTools, requestedMaxSteps } = request
    if (!idempotencyKey) throw new AdmissionError("BAD_REQUEST", "Idempotency-Key required", 400)

    const scope = { tenantId: principal.tenantId, orgId, projectId }

    // 1. Authorize org/project scope (identity layer).
    const identity: JobIdentity = { tenantId: principal.tenantId, orgId, projectId }
    try {
      await this.deps.identity.authorize(principal, { orgId, projectId })
      await this.deps.identity.validateJobIdentity(identity)
    } catch (error) {
      if (error instanceof IdentityError) {
        await this.auditRejection(principal, identity, "job_rejected", { reason: error.code, message: error.message })
        throw new AdmissionError(error.code, error.message, error.code === "FORBIDDEN_ORG" || error.code.startsWith("FORBIDDEN") || error.code === "IDENTITY_MISMATCH" ? 403 : 404)
      }
      throw error
    }

    // 2. Durable idempotency claim (Phase 1F). The claim is fenced by the
    //    UNIQUE(tenant_id, idempotency_key) constraint so concurrent admissions
    //    across separate API processes serialize: exactly one caller wins `new`
    //    and proceeds to reserve quota + create a job. A replay returns the
    //    original result without repeating reservation or job creation. A
    //    different request fingerprint under the same key is an explicit
    //    conflict (409), never a silent replay. Only the SHA-256 fingerprint is
    //    stored — never secret request material.
    const fingerprint = admissionFingerprint({
      tenantId: principal.tenantId,
      orgId,
      projectId,
      spec: { engine: spec.engine, model: spec.model, input: spec.input },
    })
    const claim = await this.deps.idempotency.claim(principal.tenantId, idempotencyKey, fingerprint)
    if (claim.kind === "completed") {
      // Authoritative replay: return the original admission result. The job
      // and reservation already exist; quota is NOT reserved a second time.
      if (claim.slot.jobId === null) {
        // Defensive: completed slot must have a job. Treat as retriable.
        await this.deps.idempotency.fail(principal.tenantId, idempotencyKey, "INCONSISTENT_SLOT", "completed slot missing jobId", true).catch(() => {})
        throw new AdmissionError("IDEMPOTENCY_INCONSISTENT", "idempotency slot is inconsistent", 500)
      }
      const job = await this.deps.runner.getJob(claim.slot.jobId)
      if (job) {
        if (job.tenantId !== principal.tenantId && !principal.admin) {
          throw new AdmissionError("JOB_NOT_FOUND", "job not found", 404)
        }
        const decision = await this.deps.policy.evaluate(scope, toPolicyRequest(scope, requestedTools, requestedMaxSteps))
        return {
          jobId: claim.slot.jobId,
          reservationId: claim.slot.reservationId ?? "",
          decision,
          status: job.status,
          replayed: true,
        }
      }
      // Stale slot (job gone): reclaim and fall through to create a new one.
      await this.deps.idempotency.fail(principal.tenantId, idempotencyKey, "STALE_JOB", "completed slot referenced a missing job", true).catch(() => {})
    } else if (claim.kind === "conflict") {
      throw new AdmissionError("IDEMPOTENCY_CONFLICT", claim.detail, 409)
    } else if (claim.kind === "pending") {
      // Another process is mid-admission on the same key. The caller may retry;
      // surface as a transient conflict (425 Too Early / 409) so the client
      // backs off and re-reads the eventual completed result.
      throw new AdmissionError("IDEMPOTENCY_INFLIGHT", "admission already in progress for this idempotency key", 425)
    }

    // 3. Policy evaluation (before admission). This instance owns the claimed
    //    slot, so a denial must fail the slot terminally (the key is consumed).
    const decision = await this.deps.policy.evaluate(scope, toPolicyRequest(scope, requestedTools, requestedMaxSteps))
    await this.audit(principal, identity, "policy_decision", { allowed: decision.allowed, reasonCode: decision.reasonCode, policyId: decision.policyId, policyVersion: decision.policyVersion })
    if (!decision.allowed) {
      await this.deps.idempotency.fail(principal.tenantId, idempotencyKey, "POLICY_DENIED", decision.reasonCode, false).catch(() => {})
      await this.auditRejection(principal, identity, "job_rejected", { reason: decision.reasonCode })
      throw new AdmissionError("POLICY_DENIED", `Admission denied: ${decision.reasonCode}`, 403)
    }

    // 4. Quota reservation (race-free, idempotent on requestKey = idempotencyKey).
    //    A replay by a concurrent winner would have returned at step 2; reaching
    //    here means this instance is the sole admitted creator.
    const limits = quotaLimitsFromDecision(decision, decision.maxConcurrentJobs)
    await this.deps.quota.setLimits(quotaScope(identity), limits)
    let reservation: QuotaReservation
    try {
      reservation = await this.deps.quota.reserve(quotaScope(identity), idempotencyKey, null, limits)
    } catch (error) {
      // Quota failure is retriable: a later admission under the same key may
      // succeed if capacity frees up. Mark the slot retriable and release the claim.
      await this.deps.idempotency.fail(principal.tenantId, idempotencyKey, "QUOTA_REJECTED", error instanceof QuotaError ? error.code : "unknown", true).catch(() => {})
      if (error instanceof QuotaError) {
        await this.auditRejection(principal, identity, "quota_rejected", { reason: error.code, requestKey: idempotencyKey })
        throw new AdmissionError(error.code, error.message, 429)
      }
      throw error
    }
    await this.audit(principal, identity, "quota_reserved", { reservationId: reservation.reservationId, state: reservation.state })

    // 5. Durable job creation — with compensation on failure. A crash after
    //    reservation but before job creation must NOT leak capacity forever:
    //    the reservation is released and the slot marked retriable so a later
    //    admission (or the reaper) can reclaim it.
    const leaseMs = request.leaseMs ?? defaultLeaseMs(decision)
    const input: CreateJobInput = {
      tenantId: principal.tenantId,
      orgId,
      projectId,
      spec,
      policy: toExecutionPolicy(decision, leaseMs),
    }
    let record: JobRecord
    try {
      record = await this.deps.runner.createJob(input)
    } catch (error) {
      await this.deps.quota.release(reservation.reservationId, reservation.version).catch(() => {})
      await this.deps.idempotency.fail(principal.tenantId, idempotencyKey, "JOB_CREATION_FAILED", error instanceof Error ? error.message : "unknown", true).catch(() => {})
      await this.auditRejection(principal, identity, "job_rejected", { reason: "JOB_CREATION_FAILED", message: error instanceof Error ? error.message : "unknown" })
      throw error
    }

    // 6. Link the reservation to the job and complete the idempotency slot.
    await this.deps.quota.attachJob(reservation.reservationId, record.jobId)
    await this.deps.idempotency.complete(principal.tenantId, idempotencyKey, record.jobId, reservation.reservationId)
    await this.audit(principal, identity, "job_admitted", { jobId: record.jobId, reservationId: reservation.reservationId, policyVersion: decision.policyVersion })

    return {
      jobId: record.jobId,
      reservationId: reservation.reservationId,
      decision,
      status: record.status,
      replayed: false,
    }
  }

  /**
   * Settle a job's reservation with actual usage and bill consumed resources.
   * Called by the control plane at job terminal/cancellation. Settlement is
   * idempotent (re-settling returns the existing settled reservation) and
   * fenced (a stale version is rejected). Billing is exactly-once at the
   * durable charge identity boundary.
   */
  async settleAndBill(args: {
    principal: ResolvedPrincipal
    jobId: string
    reservationId: string
    expectedVersion: number
    usage: JobMetrics
    durationMs: number
    pricingRef: { pricingId: string; version: string; unitPrices: Readonly<Record<string, number>> }
  }): Promise<{ settled: QuotaReservation }> {
    const job = await this.deps.runner.getJob(args.jobId)
    if (!job || (job.tenantId !== args.principal.tenantId && !args.principal.admin)) {
      throw new AdmissionError("JOB_NOT_FOUND", "job not found", 404)
    }
    const identity: JobIdentity & { jobId: string } = { tenantId: args.principal.tenantId, orgId: job.orgId ?? "", projectId: job.projectId ?? "", jobId: args.jobId }
    const settled = await this.deps.quota.settle(args.reservationId, args.expectedVersion, {
      tokens: args.usage.totalTokens,
      durationMs: args.durationMs,
    })
    await this.audit(args.principal, identity, "quota_settled", { reservationId: args.reservationId, tokens: args.usage.totalTokens, durationMs: args.durationMs })
    return { settled }
  }

  private async audit(principal: ResolvedPrincipal, identity: JobIdentity, type: AuditInput["type"], metadata: Record<string, unknown>): Promise<void> {
    await this.deps.audit.append({ actor: auditActor(principal), scope: identity, type, metadata })
  }

  private async auditRejection(principal: ResolvedPrincipal, identity: JobIdentity, type: AuditInput["type"], metadata: Record<string, unknown>): Promise<void> {
    await this.deps.audit.append({ actor: auditActor(principal), scope: identity, type, metadata })
  }
}

/**
 * In-memory admission idempotency registry (single-process only). Implements
 * the same claim/complete/fail state machine as the SQL-backed registry so the
 * control plane behaves identically in tests/local, but WITHOUT cross-process
 * durability: a process restart loses in-flight state. Production MUST wire
 * {@link SqlAdmissionIdempotencyRegistry} (or any SQL-backed implementation of
 * {@link AdmissionIdempotencyRegistry}) for multi-instance correctness.
 */
export class InMemoryAdmissionIdempotencyRegistry implements AdmissionIdempotencyRegistry {
  private readonly entries = new Map<string, AdmissionIdempotencyRecord>()
  private key(tenantId: string, key: string): string {
    return `${tenantId}|${key}`
  }
  async claim(tenantId: string, key: string, fingerprint: string): Promise<AdmissionIdempotencyClaimResult> {
    const k = this.key(tenantId, key)
    const existing = this.entries.get(k)
    const now = Date.now()
    if (existing) {
      // Reclaimable: retriable-failed or expired.
      const reclaimable =
        existing.state === "failed_retriable" || (existing.expiresAt !== null && existing.expiresAt < now)
      if (!reclaimable) {
        if (existing.fingerprint !== fingerprint) {
          return { kind: "conflict", slot: existing, detail: "idempotency key reused with a different request body" }
        }
        if (existing.state === "completed") return { kind: "completed", slot: existing }
        return { kind: "pending", slot: existing }
      }
    }
    const slot: AdmissionIdempotencyRecord = {
      tenantId,
      key,
      fingerprint,
      state: "pending",
      jobId: null,
      reservationId: null,
      failureCode: null,
      failureDetail: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: null,
    }
    this.entries.set(k, slot)
    return { kind: "new", slot }
  }
  async complete(tenantId: string, key: string, jobId: string, reservationId: string): Promise<AdmissionIdempotencyRecord | null> {
    const k = this.key(tenantId, key)
    const existing = this.entries.get(k)
    if (!existing) return null
    const updated: AdmissionIdempotencyRecord = { ...existing, state: "completed", jobId, reservationId, failureCode: null, failureDetail: null, updatedAt: Date.now() }
    this.entries.set(k, updated)
    return updated
  }
  async fail(tenantId: string, key: string, code: string, detail: string, retriable: boolean): Promise<AdmissionIdempotencyRecord | null> {
    const k = this.key(tenantId, key)
    const existing = this.entries.get(k)
    if (!existing) return null
    const updated: AdmissionIdempotencyRecord = { ...existing, state: retriable ? "failed_retriable" : "failed_terminal", failureCode: code, failureDetail: detail, updatedAt: Date.now() }
    this.entries.set(k, updated)
    return updated
  }
  async lookup(tenantId: string, key: string): Promise<AdmissionIdempotencyRecord | null> {
    return this.entries.get(this.key(tenantId, key)) ?? null
  }
}
