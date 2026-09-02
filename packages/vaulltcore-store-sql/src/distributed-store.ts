/**
 * Phase 1D SQL-backed distributed-control-plane services: durable idempotency,
 * job dispatcher, worker registry/heartbeats, and snapshot lifecycle.
 *
 * These sit behind the neutral {@link JobDispatcher} / {@link SnapshotRegistry}
 * seams in `@vaulltcore/runner`. They share the same database + migration set
 * as {@link SqlJobStore} so that job creation and idempotency-record fulfillment
 * can be transactional, and so the supervisor's reconciliation queries see the
 * same fencing tokens the lease store uses.
 *
 * Invariants preserved:
 * - Exactly one outstanding dispatch claim per job (PRIMARY KEY on job_id).
 * - Claiming acquires the fenced job lease; a claim whose lease has expired is
 *   stealable by the next worker with a fresh generation.
 * - Idempotency: UNIQUE(tenant_id, idempotency_key) is the linearization point.
 *   Same key + same request hash ⇒ return the original job; same key + changed
 *   request ⇒ explicit conflict. Different tenants never collide.
 * - Snapshot GC never deletes the last valid recovery artifact before its
 *   replacement is durably committed.
 */

import { createHash } from "node:crypto"
import {
  JobNotFoundError,
  VaulltcoreError,
  newLeaseToken,
  type DispatchClaim,
  type IdempotencyClaim,
  type IdempotencyClaimResult,
  type IdempotencyRecord,
  type LeaseRenewalResult,
  type RecoveryCandidate,
  type SnapshotGcDecision,
  type SnapshotLifecycleState,
  type SnapshotRecord,
  type WorkerHeartbeat,
  type WorkerIdentity,
  type WorkerLease,
  ACTIVE_SNAPSHOT_STATES,
} from "@vaulltcore/runner"
import type { SqlDatabase, SqlDialect, SqlStatement } from "./driver"
import { sqliteDialect } from "./driver"

const GC_BUFFER_MS = 60_000

export interface DistributedSqlStoreOptions {
  readonly dialect?: SqlDialect
}

/** SQL-backed Phase 1D services over a single {@link SqlDatabase}. */
export class DistributedSqlStore {
  private readonly dialect: SqlDialect

  constructor(
    private readonly db: SqlDatabase,
    options: DistributedSqlStoreOptions = {},
  ) {
    this.dialect = options.dialect ?? sqliteDialect
  }

  /** Prepare a parameterized statement. Public so co-located drivers (e.g.
   *  SnapshotGcDriver) can access the GC-attempt table without duplicating the
   *  dialect/parameterize seam. */
  prepare(sql: string): SqlStatement {
    return this.db.prepare(this.dialect.parameterize(sql))
  }

  /** Run `fn` inside an immediate transaction with rollback on error. */
  atomic<T>(fn: () => T): T {
    this.db.exec(this.dialect.beginImmediateStatement())
    try {
      const result = fn()
      this.db.exec("COMMIT")
      return result
    } catch (error) {
      try {
        this.db.exec("ROLLBACK")
      } catch {
        // rollback after a failed BEGIN is harmless
      }
      throw error
    }
  }

  // -------------------------------------------------------------------------
  // Durable idempotency
  // -------------------------------------------------------------------------

  /** Canonical request hash: SHA-256 over a stable JSON encoding. */
  static requestHash(body: unknown): string {
    return createHash("sha256").update(stableString(body)).digest("hex")
  }

  /**
   * Atomically claim an idempotency slot. UNIQUE(tenant_id, idempotency_key)
   * serializes concurrent attempts; the request_hash distinguishes a legitimate
   * retry from a conflicting reuse of the same key.
   */
  claimIdempotency(claim: IdempotencyClaim): IdempotencyClaimResult {
    const now = Date.now()
    return this.atomic(() => {
      const existing = this.prepare(
        "SELECT request_hash, job_id, response_status, expires_at FROM idempotency_records WHERE tenant_id = ? AND idempotency_key = ?",
      ).get(claim.tenantId, claim.key) as
        | { request_hash: string; job_id: string | null; response_status: number | null; expires_at: number | null }
        | undefined
      if (existing) {
        // Expired records are reclaimable: a new claim is permitted.
        if (existing.expires_at !== null && existing.expires_at < now) {
          this.prepare("DELETE FROM idempotency_records WHERE tenant_id = ? AND idempotency_key = ?").run(claim.tenantId, claim.key)
        } else if (existing.request_hash !== claim.requestHash) {
          return {
            kind: "conflict" as const,
            jobId: existing.job_id,
            detail: `idempotency key reused with a different request body`,
          }
        } else if (existing.job_id !== null && existing.response_status !== null) {
          return { kind: "fulfilled" as const, jobId: existing.job_id, responseStatus: existing.response_status }
        } else {
          // Same request, mid-fulfillment (creator crashed): re-attempt safe.
          return { kind: "pending" as const, slotId: slotId(claim) }
        }
      }
      // No prior record: insert a pending slot. The slotId is deterministic so a
      // re-attempt after a crash finds the same row.
      const sid = slotId(claim)
      this.prepare(
        "INSERT INTO idempotency_records (tenant_id, idempotency_key, request_hash, job_id, response_status, response_body, created_at, expires_at) VALUES (?, ?, ?, NULL, NULL, NULL, ?, NULL)",
      ).run(claim.tenantId, claim.key, claim.requestHash, now)
      return { kind: "new" as const, slotId: sid }
    })
  }

  /** Fulfill a claimed slot with the created job id + response status. */
  fulfillIdempotency(claim: IdempotencyClaim, jobId: string, responseStatus: number, responseBody?: unknown): void {
    this.atomic(() => {
      const existing = this.prepare(
        "SELECT request_hash FROM idempotency_records WHERE tenant_id = ? AND idempotency_key = ?",
      ).get(claim.tenantId, claim.key) as { request_hash: string } | undefined
      if (!existing) {
        // Slot vanished (expired+reclaimed between claim and fulfill): re-insert
        // as fulfilled so the result is durable.
        this.prepare(
          "INSERT INTO idempotency_records (tenant_id, idempotency_key, request_hash, job_id, response_status, response_body, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
        ).run(claim.tenantId, claim.key, claim.requestHash, jobId, responseStatus, responseBody === undefined ? null : JSON.stringify(responseBody), Date.now())
        return
      }
      this.prepare(
        "UPDATE idempotency_records SET job_id = ?, response_status = ?, response_body = ? WHERE tenant_id = ? AND idempotency_key = ?",
      ).run(jobId, responseStatus, responseBody === undefined ? null : JSON.stringify(responseBody), claim.tenantId, claim.key)
    })
  }

  /** Read a durable idempotency record (or null). */
  getIdempotencyRecord(tenantId: string, key: string): IdempotencyRecord | null {
    const row = this.prepare(
      "SELECT tenant_id, idempotency_key, request_hash, job_id, response_status, created_at, expires_at FROM idempotency_records WHERE tenant_id = ? AND idempotency_key = ?",
    ).get(tenantId, key) as
      | {
          tenant_id: string
          idempotency_key: string
          request_hash: string
          job_id: string | null
          response_status: number | null
          created_at: number
          expires_at: number | null
        }
      | undefined
    if (!row) return null
    return {
      tenantId: row.tenant_id,
      key: row.idempotency_key,
      requestHash: row.request_hash,
      jobId: row.job_id,
      responseStatus: row.response_status,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }
  }

  /** Delete an idempotency record (admin/cleanup; also used when createJob fails
   * after a pending claim so a retry isn't stuck pending forever). */
  deleteIdempotencyRecord(tenantId: string, key: string): void {
    this.atomic(() => {
      this.prepare("DELETE FROM idempotency_records WHERE tenant_id = ? AND idempotency_key = ?").run(tenantId, key)
    })
  }

  /** Read an idempotency record by its deterministic slot id (sha256). */
  getIdempotencyRecordBySlotId(slotId: string): IdempotencyRecord | null {
    // The slot id is sha256(tenant|key|requestHash) and isn't stored as a
    // column, so scan the (small, tenant-scoped) table and match by digest.
    const rows = this.prepare(
      "SELECT tenant_id, idempotency_key, request_hash, job_id, response_status, created_at, expires_at FROM idempotency_records",
    ).all() as Array<{
      tenant_id: string
      idempotency_key: string
      request_hash: string
      job_id: string | null
      response_status: number | null
      created_at: number
      expires_at: number | null
    }>
    for (const r of rows) {
      const sid = createHash("sha256")
        .update(stableString({ tenantId: r.tenant_id, key: r.idempotency_key, requestHash: r.request_hash }))
        .digest("hex")
      if (sid === slotId) {
        return {
          tenantId: r.tenant_id,
          key: r.idempotency_key,
          requestHash: r.request_hash,
          jobId: r.job_id,
          responseStatus: r.response_status,
          createdAt: r.created_at,
          expiresAt: r.expires_at,
        }
      }
    }
    return null
  }

  // -------------------------------------------------------------------------
  // Worker registry + heartbeats
  // -------------------------------------------------------------------------

  registerWorker(worker: WorkerIdentity, label?: string): void {
    const now = Date.now()
    this.atomic(() => {
      this.prepare(
        `INSERT INTO workers (worker_id, boot_token, label, status, last_seen_at, created_at) VALUES (?, ?, ?, 'active', ?, ?)
         ON CONFLICT (worker_id) DO UPDATE SET boot_token = excluded.boot_token, label = excluded.label, status = 'active', last_seen_at = excluded.last_seen_at`,
      ).run(worker.workerId, worker.bootToken, label ?? worker.label ?? null, now, now)
    })
  }

  recordHeartbeat(hb: WorkerHeartbeat): void {
    this.atomic(() => {
      this.prepare("UPDATE workers SET last_seen_at = ?, status = 'active' WHERE worker_id = ?").run(hb.at, hb.worker.workerId)
      this.prepare("INSERT OR IGNORE INTO worker_heartbeats (worker_id, at, active_jobs) VALUES (?, ?, ?)").run(
        hb.worker.workerId,
        hb.at,
        JSON.stringify(hb.activeJobs),
      )
    })
  }

  /** Mark a worker departed (graceful shutdown). */
  departWorker(workerId: string): void {
    this.atomic(() => {
      this.prepare("UPDATE workers SET status = 'departed', last_seen_at = ? WHERE worker_id = ?").run(Date.now(), workerId)
    })
  }

  listWorkers(): Array<{ workerId: string; bootToken: string; status: string; lastSeenAt: number }> {
    const rows = this.prepare("SELECT worker_id, boot_token, status, last_seen_at FROM workers").all() as Array<{
      worker_id: string
      boot_token: string
      status: string
      last_seen_at: number
    }>
    return rows.map((r) => ({ workerId: r.worker_id, bootToken: r.boot_token, status: r.status, lastSeenAt: r.last_seen_at }))
  }

  // -------------------------------------------------------------------------
  // Job dispatcher (fenced claim/acknowledge/heartbeat/release)
  // -------------------------------------------------------------------------

  /** Enqueue a job for claiming. Idempotent. A `suspended` job is re-queued
   * (recovery re-dispatch): status suspended→queued and its stale dispatch
   * claim is cleared so a fresh worker can claim it. Already-queued/leased/
   * running jobs are no-ops. */
  enqueue(jobId: string): void {
    this.atomic(() => {
      const row = this.prepare("SELECT status, attempt FROM jobs WHERE job_id = ?").get(jobId) as { status: string; attempt: number } | undefined
      if (!row) throw new JobNotFoundError(jobId)
      if (row.status === "suspended") {
        this.prepare("UPDATE jobs SET status = 'queued', updated_at = ? WHERE job_id = ?").run(Date.now(), jobId)
        this.prepare("DELETE FROM dispatch_claims WHERE job_id = ?").run(jobId)
        this.prepare("DELETE FROM job_leases WHERE job_id = ?").run(jobId)
        return
      }
      if (row.status !== "queued") return // already dispatched/leased/running
    })
  }

  /**
   * Claim the next available queued job for a worker. This is ASSIGNMENT, not
   * execution-lease acquisition: it atomically reserves the job for exactly
   * one worker (UNIQUE on job_id in dispatch_claims is the linearization
   * point) so two competing workers never both start the same job. It does
   * NOT bump the ownership generation or write job_leases — the runner's
   * controller.acquire takes the fenced execution lease when the worker begins
   * running, and that lease is what gates every appendEvents/saveCheckpoint.
   *
   * The dispatch token recorded here is the assignment fencing token: a stale
   * worker's heartbeat against an old assignment token is rejected (the job
   * was re-assigned or recovered under a fresh generation). Resolves to null
   * when no unassigned queued job is available.
   */
  claim(worker: WorkerIdentity, leaseMs: number): DispatchClaim | null {
    const now = Date.now()
    return this.atomic(() => {
      // Select queued jobs that are not currently assigned (no active
      // dispatch_claims row, or an expired one that is reclaimable).
      const candidate = this.prepare(
        `SELECT j.job_id, j.attempt FROM jobs j
         LEFT JOIN dispatch_claims d ON d.job_id = j.job_id
         WHERE j.status = 'queued'
           AND (d.job_id IS NULL OR d.expires_at <= ?)
         ORDER BY j.created_at ASC LIMIT 1`,
      ).get(now) as { job_id: string; attempt: number } | undefined
      if (!candidate) return null
      const jobId = candidate.job_id
      const token = newLeaseToken()
      const expiresAt = now + leaseMs
      // UNIQUE(job_id) is the assignment fence: exactly one INSERT succeeds.
      const ins = this.prepare(
        `INSERT INTO dispatch_claims (job_id, worker_id, boot_token, generation, token, expires_at, claimed_at, acknowledged)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT (job_id) DO UPDATE SET
           worker_id = excluded.worker_id,
           boot_token = excluded.boot_token,
           generation = excluded.generation,
           token = excluded.token,
           expires_at = excluded.expires_at,
           claimed_at = excluded.claimed_at,
           acknowledged = 0
         WHERE dispatch_claims.expires_at <= ?`,
      ).run(jobId, worker.workerId, worker.bootToken, candidate.attempt, token, expiresAt, now, now)
      if (ins.changes === 0) return null // lost the race to another worker
      return { jobId, worker, generation: candidate.attempt, token, expiresAt }
    })
  }

  /** Acknowledge the claim (worker has begun processing). Fenced on token. */
  acknowledge(claim: DispatchClaim): void {
    this.atomic(() => {
      const r = this.prepare("UPDATE dispatch_claims SET acknowledged = 1 WHERE job_id = ? AND token = ?").run(claim.jobId, claim.token)
      if (r.changes === 0) throw new VaulltcoreError("DISPATCH_FENCED", `acknowledge rejected: stale claim for job ${claim.jobId}`)
    })
  }

  /** Fenced heartbeat renewal of the dispatch claim + lease. */
  heartbeat(claim: DispatchClaim, leaseMs: number): LeaseRenewalResult {
    const now = Date.now()
    return this.atomic(() => {
      const row = this.prepare("SELECT token, expires_at FROM dispatch_claims WHERE job_id = ?").get(claim.jobId) as
        | { token: string; expires_at: number }
        | undefined
      if (!row) return { renewed: false as const, reason: "not_found" as const }
      if (row.token !== claim.token) return { renewed: false as const, reason: "fenced" as const }
      if (row.expires_at <= now) return { renewed: false as const, reason: "expired" as const, expiresAt: row.expires_at }
      const expiresAt = now + leaseMs
      const r1 = this.prepare("UPDATE dispatch_claims SET expires_at = ? WHERE job_id = ? AND token = ?").run(expiresAt, claim.jobId, claim.token)
      const r2 = this.prepare("UPDATE job_leases SET expires_at = ? WHERE job_id = ? AND token = ?").run(expiresAt, claim.jobId, claim.token)
      if (r1.changes === 0 || r2.changes === 0) return { renewed: false as const, reason: "fenced" as const }
      return { renewed: true as const, expiresAt }
    })
  }

  /** Fenced release of the dispatch claim + lease. */
  release(claim: DispatchClaim): void {
    this.atomic(() => {
      this.prepare("DELETE FROM dispatch_claims WHERE job_id = ? AND token = ?").run(claim.jobId, claim.token)
      this.prepare("DELETE FROM job_leases WHERE job_id = ? AND token = ?").run(claim.jobId, claim.token)
    })
  }

  // -------------------------------------------------------------------------
  // Worker-loss reconciliation
  // -------------------------------------------------------------------------

  /**
   * Identify jobs that need recovery: non-terminal with an expired lease.
   * Transient worker loss becomes recovery-eligible, never silently failed.
   */
  findRecoveryCandidates(now: number = Date.now()): RecoveryCandidate[] {
    const rows = this.prepare(
      `SELECT j.job_id, j.status, j.attempt, l.token, l.generation, l.expires_at, l.acquired_at, d.worker_id, d.boot_token
       FROM jobs j
       LEFT JOIN job_leases l ON l.job_id = j.job_id
       LEFT JOIN dispatch_claims d ON d.job_id = j.job_id
       WHERE j.status IN ('leased','preparing','running','checkpointing','resuming')`,
    ).all() as Array<{
      job_id: string
      status: string
      attempt: number
      token: string | null
      generation: number | null
      expires_at: number | null
      acquired_at: number | null
      worker_id: string | null
      boot_token: string | null
    }>
    const candidates: RecoveryCandidate[] = []
    for (const row of rows) {
      // A non-terminal job with NO live lease (the worker released it on
      // crash, or never acquired it) is an orphan — it is eligible for
      // recovery. A job with a live (unexpired) lease is left to its owner.
      const leaseExpired = row.expires_at === null || row.expires_at <= now
      if (!leaseExpired) continue
      const lease: WorkerLease | null =
        row.token !== null && row.worker_id !== null
          ? {
              jobId: row.job_id,
              worker: { workerId: row.worker_id, bootToken: row.boot_token ?? "" },
              generation: row.generation ?? row.attempt,
              token: row.token,
              expiresAt: row.expires_at ?? 0,
              lastHeartbeatAt: row.acquired_at ?? row.expires_at ?? 0,
            }
          : null
      const reason = row.expires_at === null ? "orphaned" : "lease_expired"
      candidates.push({ jobId: row.job_id, reason, lease })
    }
    return candidates
  }

  // -------------------------------------------------------------------------
  // Snapshot lifecycle
  // -------------------------------------------------------------------------

  recordSnapshotCreated(record: Omit<SnapshotRecord, "state" | "supersededBy" | "updatedAt">): void {
    const now = Date.now()
    this.atomic(() => {
      this.prepare(
        `INSERT INTO snapshot_lifecycle
         (snapshot_id, tenant_id, job_id, provider, size_bytes, integrity_hash, attempt, state, superseded_by, created_at, expires_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'created', NULL, ?, ?, ?)
         ON CONFLICT (snapshot_id) DO UPDATE SET state = 'active', updated_at = excluded.updated_at`,
      ).run(
        record.snapshotId,
        record.tenantId,
        record.jobId,
        record.provider,
        record.sizeBytes,
        record.integrityHash,
        record.attempt,
        record.createdAt,
        record.expiresAt,
        now,
      )
    })
  }

  /** Mark a snapshot active (it is now the latest committed recovery artifact). */
  activateSnapshot(snapshotId: string): void {
    this.atomic(() => {
      this.prepare("UPDATE snapshot_lifecycle SET state = 'active', updated_at = ? WHERE snapshot_id = ?").run(Date.now(), snapshotId)
    })
  }

  /**
   * Mark a snapshot superseded by a newer committed artifact. The superseded
   * snapshot is retained until the replacement is durably committed; this method
   * only flips state (it does not delete).
   */
  supersedeSnapshot(snapshotId: string, replacementId: string): void {
    this.atomic(() => {
      this.prepare("UPDATE snapshot_lifecycle SET state = 'superseded', superseded_by = ?, updated_at = ? WHERE snapshot_id = ?").run(
        replacementId,
        Date.now(),
        snapshotId,
      )
    })
  }

  markSnapshotState(snapshotId: string, state: SnapshotLifecycleState): void {
    this.atomic(() => {
      this.prepare("UPDATE snapshot_lifecycle SET state = ?, updated_at = ? WHERE snapshot_id = ?").run(state, Date.now(), snapshotId)
    })
  }

  /** Read a single snapshot record by id (or null). */
  getSnapshotRecord(snapshotId: string): SnapshotRecord | null {
    const row = this.prepare(
      "SELECT snapshot_id, tenant_id, job_id, provider, size_bytes, integrity_hash, attempt, state, superseded_by, created_at, expires_at, updated_at FROM snapshot_lifecycle WHERE snapshot_id = ?",
    ).get(snapshotId) as unknown as SnapshotRow | undefined
    return row ? toSnapshotRecord(row) : null
  }

  /** Latest active (or created) snapshot for a job, or null. */
  latestSnapshotForJob(jobId: string): SnapshotRecord | null {
    const all = this.listJobSnapshots(jobId)
    const active = all.filter((r) => ACTIVE_SNAPSHOT_STATES.has(r.state))
    return active.length === 0 ? null : active[active.length - 1]!
  }

  listJobSnapshots(jobId: string): SnapshotRecord[] {
    const rows = this.prepare(
      "SELECT snapshot_id, tenant_id, job_id, provider, size_bytes, integrity_hash, attempt, state, superseded_by, created_at, expires_at, updated_at FROM snapshot_lifecycle WHERE job_id = ? ORDER BY created_at ASC",
    ).all(jobId) as unknown as SnapshotRow[]
    return rows.map(toSnapshotRecord)
  }

  /**
   * Conservative GC decision: a snapshot is deletable only when (a) it has
   * expired AND (b) it is superseded by an ACTIVE replacement that is durably
   * committed, OR it is in a terminal failed/deleted state. The LAST valid
   * (active) recovery artifact for a non-terminal job is never deletable until a
   * replacement is durably committed.
   */
  gcDecision(now: number = Date.now()): SnapshotGcDecision {
    const all = this.prepare(
      "SELECT snapshot_id, tenant_id, job_id, provider, size_bytes, integrity_hash, attempt, state, superseded_by, created_at, expires_at, updated_at FROM snapshot_lifecycle",
    ).all() as unknown as SnapshotRow[]
    const records: SnapshotRecord[] = all.map(toSnapshotRecord)
    // Index active snapshots per job.
    const activePerJob = new Map<string, SnapshotRecord[]>()
    for (const r of records) {
      if (ACTIVE_SNAPSHOT_STATES.has(r.state)) {
        const list = activePerJob.get(r.jobId) ?? []
        list.push(r)
        activePerJob.set(r.jobId, list)
      }
    }
    const deletable: SnapshotRecord[] = []
    const retained: SnapshotRecord[] = []
    const reasons = new Map<string, string>()
    for (const r of records) {
      if (r.state === "deleted") {
        retained.push(r)
        reasons.set(r.snapshotId, "already deleted")
        continue
      }
      if (r.state === "failed") {
        deletable.push(r)
        reasons.set(r.snapshotId, "snapshot in failed state; safe to delete")
        continue
      }
      const expired = r.expiresAt !== null && r.expiresAt + GC_BUFFER_MS < now
      // A replacement counts as "durably committed" only once it has been
      // promoted to `active` — a merely `created` snapshot has not yet been
      // validated as the recovery artifact, so superseding it is not safe to
      // collect. This is the "never delete the last valid recovery artifact
      // before its replacement is durably committed" invariant.
      const hasActiveReplacement =
        r.supersededBy !== null && records.some((x) => x.snapshotId === r.supersededBy && x.state === "active")
      const activeForJob = activePerJob.get(r.jobId) ?? []
      const isLastActive = activeForJob.length === 1 && activeForJob[0]!.snapshotId === r.snapshotId
      if (expired && hasActiveReplacement && !isLastActive) {
        deletable.push(r)
        reasons.set(r.snapshotId, "expired and superseded by a durably-committed active replacement")
      } else if (r.state === "superseded" && hasActiveReplacement && !isLastActive) {
        deletable.push(r)
        reasons.set(r.snapshotId, "superseded by an active replacement; retention no longer required")
      } else {
        retained.push(r)
        reasons.set(r.snapshotId, isLastActive ? "last valid recovery artifact for a non-terminal job; retained until replacement commits" : "not yet eligible")
      }
    }
    return { deletable, retained, reasons }
  }

  /** Physically delete a snapshot lifecycle row (after GC decision). */
  deleteSnapshotRecord(snapshotId: string): void {
    this.atomic(() => {
      this.prepare("DELETE FROM snapshot_lifecycle WHERE snapshot_id = ?").run(snapshotId)
    })
  }
}

function slotId(claim: IdempotencyClaim): string {
  return createHash("sha256").update(stableString({ tenantId: claim.tenantId, key: claim.key, requestHash: claim.requestHash })).digest("hex")
}

interface SnapshotRow {
  snapshot_id: string
  tenant_id: string
  job_id: string
  provider: string
  size_bytes: number | null
  integrity_hash: string
  attempt: number
  state: string
  superseded_by: string | null
  created_at: number
  expires_at: number | null
  updated_at: number
}

function toSnapshotRecord(r: SnapshotRow): SnapshotRecord {
  return {
    snapshotId: r.snapshot_id,
    tenantId: r.tenant_id,
    jobId: r.job_id,
    provider: r.provider,
    sizeBytes: r.size_bytes,
    integrityHash: r.integrity_hash,
    attempt: r.attempt,
    state: r.state as SnapshotLifecycleState,
    supersededBy: r.superseded_by,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    updatedAt: r.updated_at,
  }
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
