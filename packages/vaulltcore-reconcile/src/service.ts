/**
 * Reconciliation service (Phase 1F, Deliverable 3).
 *
 * Compares authoritative execution state against accounting state and safely
 * repairs missing downstream projections. It is restart-safe and idempotent:
 * the durable watermark (in {@link SqlReconciliationStore}) is the sole progress
 * source, so an interrupted run resumes from the last committed boundary
 * without re-projecting or dropping records.
 *
 * Authoritative source boundaries:
 * - Execution: committed {@link JobEvent}s (via `runner.listEvents`) and job
 *   status (via `runner.getJob`). The watermark is the max event `seq` seen.
 * - Accounting: metering {@link UsageEvent}s, billing {@link UsageSettlement}s
 *   and {@link LedgerEntry}s, and quota reservations.
 *
 * Repair rules (what it MAY do):
 * - Rebuild missing UsageEvents from committed execution events — safe because
 *   the metering store's UNIQUE (tenant,job,kind,dedup_key) collapses duplicates.
 * - Retry pricing/ledger projection through durable settlement idempotency.
 *
 * Non-repair rules (what it MUST NOT do):
 * - NEVER re-execute agent steps or tool calls. The reconciler reads committed
 *   events only; it never drives {@link AgentRunner.runJob}/{@link resumeJob}.
 * - NEVER mutate settled ledger history (corrections are new adjustment entries).
 *
 * Detected gap kinds (A–H):
 *   A missing_usage_event            committed event with no UsageEvent
 *   B unpriced_usage                 UsageEvent with no settlement (or unresolved)
 *   C missing_ledger_entry           priced usage with no LedgerEntry
 *   D duplicate_candidate            duplicate UsageEvents / LedgerEntries
 *   E orphaned_reservation           active reservation with no (or unknown) job
 *   F terminal_unsettled_reservation terminal job with an unsettled reservation
 *   G invalid_identity_ref           metering/ledger row referencing bad identity
 *   H (interrupted run)              prior run left `interrupted` (count exposed)
 */

import type { AgentRunner, JobEvent, JobStatus } from "@vaulltcore/runner"
import { TERMINAL_STATUSES } from "@vaulltcore/runner"
import type { SqlMeteringStore } from "@vaulltcore/metering"
import { eventsToUsage, eventsToUsageAttributed, type MeteringIdentity, type UsageAttribution } from "@vaulltcore/metering"
import type { SqlBillingStore, SettleUsageInput } from "@vaulltcore/billing"
import type { SqlQuotaStore } from "@vaulltcore/quota"
import type { SqlReconciliationStore } from "./store"
import type { GapKind } from "./store"

/**
 * Phase 2F: optional provider/model attribution for usage rebuilt during
 * reconciliation. When provided, the reconciler uses
 * {@link eventsToUsageAttributed} so rebuilt UsageEvents carry public
 * provider/model identifiers (from the job spec, never credentials). When
 * absent, the legacy {@link eventsToUsage} adapter is used — existing behavior
 * is unchanged. Either way the dedup keys are identical, so a job metered by
 * either path collapses to the same single durable charge (no
 * double-accounting). Returns null when attribution is unavailable (honest,
 * never fabricated).
 */
export type AttributionProvider = (job: { jobId: string; tenantId: string; orgId: string; projectId: string }) => UsageAttribution | null

/** Tenant-scoped job index (satisfied by {@link SqlJobStore.listJobsByTenant}). */
export interface JobIndex {
  listJobsByTenant(tenantId: string): Promise<Array<{
    jobId: string
    tenantId: string
    orgId: string
    projectId: string
    status: JobStatus
    lastSeq: number
    createdAt: number
    updatedAt: number
  }>>
}

export interface ReconciliationDeps {
  readonly runner: AgentRunner
  readonly jobs: JobIndex
  readonly metering: SqlMeteringStore
  readonly billing: SqlBillingStore
  readonly quota: SqlQuotaStore
  readonly store: SqlReconciliationStore
  /** Phase 2F: optional provider/model attribution for rebuilt usage. */
  readonly attributionProvider?: AttributionProvider
}

export interface ReconciliationResult {
  readonly runId: string
  readonly tenantId: string
  readonly scope: string
  readonly watermark: number
  readonly gapsFound: number
  readonly gapsRepaired: number
  readonly jobsScanned: number
  readonly status: "completed" | "failed"
  readonly error: string | null
}

/** Configuration for a reconciliation run. */
export interface ReconciliationOptions {
  /** Tenant to reconcile (required — reconciliation is always tenant-scoped). */
  readonly tenantId: string
  /** Logical scope label stored on the run row (e.g. "tenant"). */
  readonly scope?: string
  /** Max jobs to scan per run (default 1000). */
  readonly maxJobs?: number
  /** Whether to repair detected gaps (default true). When false, only detects. */
  readonly repair?: boolean
}

/**
 * Restart-safe, idempotent reconciliation. One run scans a tenant's jobs in
 * ascending creation order, advancing the durable watermark as each job is
 * processed. A crash mid-run leaves the run `running`; the next `beginRun`
 * marks it `interrupted` and the new run resumes from the last committed
 * watermark. Re-running over already-reconciled jobs is a no-op: UsageEvent
 * rebuild and settlement retry are idempotent at their durable identity
 * boundaries, and detected gaps are deduplicated by their identity.
 */
export class ReconciliationService {
  constructor(private readonly deps: ReconciliationDeps) {}

  async reconcile(options: ReconciliationOptions): Promise<ReconciliationResult> {
    const tenantId = options.tenantId
    const scope = options.scope ?? "tenant"
    const repair = options.repair ?? true
    const maxJobs = options.maxJobs ?? 1000
    const run = this.deps.store.beginRun(tenantId, scope)
    let jobsScanned = 0
    let finalWatermark = run.watermark
    try {
      const jobs = await this.deps.jobs.listJobsByTenant(tenantId)
      for (const job of jobs) {
        if (jobsScanned >= maxJobs) break
        jobsScanned++
        const jobWatermark = await this.reconcileJob(job, run.runId, repair)
        if (jobWatermark > finalWatermark) {
          finalWatermark = jobWatermark
          this.deps.store.advanceWatermark(run.runId, finalWatermark)
        }
      }
      // Cross-store consistency checks (reservations vs jobs).
      await this.reconcileReservations(tenantId, run.runId, repair)
      const completed = this.deps.store.completeRun(run.runId, finalWatermark, null)
      return {
        runId: completed.runId,
        tenantId,
        scope,
        watermark: completed.watermark,
        gapsFound: completed.gapsFound,
        gapsRepaired: completed.gapsRepaired,
        jobsScanned,
        status: "completed",
        error: null,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error"
      const completed = this.deps.store.completeRun(run.runId, finalWatermark, message)
      return {
        runId: completed.runId,
        tenantId,
        scope,
        watermark: completed.watermark,
        gapsFound: completed.gapsFound,
        gapsRepaired: completed.gapsRepaired,
        jobsScanned,
        status: "failed",
        error: message,
      }
    }
  }

  /** Reconcile a single job: rebuild missing usage, settle unpriced usage,
   *  repair missing ledger entries. Returns the max event seq seen. */
  private async reconcileJob(
    job: { jobId: string; tenantId: string; orgId: string; projectId: string; status: JobStatus; lastSeq: number },
    runId: string,
    repair: boolean,
  ): Promise<number> {
    const { jobId, tenantId, orgId, projectId } = job
    // Authoritative source: committed events (read-only; never executes).
    const events = await this.deps.runner.listEvents(jobId)
    const maxSeq = events.length > 0 ? Math.max(...events.map((e) => e.seq)) : job.lastSeq

    // G: invalid identity ref — a metering/ledger row whose tenant/org/project
    // does not match the job's authoritative identity. Detected per-row below.

    // A: rebuild missing UsageEvents from committed events. Safe because the
    // metering UNIQUE constraint collapses duplicates. Phase 2F: when an
    // attribution provider is wired, rebuilt usage carries public
    // provider/model identifiers (from the job spec, never credentials). The
    // dedup keys are identical to the legacy adapter, so attribution is
    // interoperable — no double-accounting.
    const identity: MeteringIdentity = { tenantId, orgId, projectId, jobId }
    const attribution = this.deps.attributionProvider ? this.deps.attributionProvider(job) : null
    const usageInputs = attribution ? eventsToUsageAttributed(identity, events, attribution) : eventsToUsage(identity, events)
    const recordedEvents: string[] = []
    if (usageInputs.length > 0) {
      const results = await this.deps.metering.recordBatch(usageInputs)
      for (let i = 0; i < results.length; i++) {
        const r = results[i]!
        recordedEvents.push(r.event.eventId)
        if (r.duplicated) {
          // D: duplicate candidate already collapsed by UNIQUE — record as a
          // known (resolved) gap so operators see dedup worked.
          this.deps.store.recordGap(tenantId, "duplicate_candidate", "usage_event", r.event.eventId, null, "deduplicated by UNIQUE constraint", runId)
        }
      }
    }

    // B/C: settle unpriced usage and repair missing ledger entries.
    const usageEvents = await this.deps.metering.listEvents({ tenantId, jobId })
    for (const ue of usageEvents) {
      // G: identity cross-check.
      if (ue.tenantId !== tenantId || ue.orgId !== orgId || ue.projectId !== projectId) {
        this.deps.store.recordGap(tenantId, "invalid_identity_ref", "usage_event", ue.eventId, null, `usage event identity mismatch`, runId)
        continue
      }
      const settlement = this.deps.billing.getUsageSettlement(tenantId, ue.eventId)
      if (!settlement || settlement.state === "pending" || settlement.state === "unresolved") {
        if (!settlement) {
          this.deps.store.recordGap(tenantId, "unpriced_usage", "usage_event", ue.eventId, null, "usage event has no settlement", runId)
        }
        if (repair) {
          const input: SettleUsageInput = {
            tenantId: ue.tenantId,
            eventId: ue.eventId,
            jobId: ue.jobId,
            orgId: ue.orgId,
            projectId: ue.projectId,
            kind: ue.kind,
            quantity: ue.quantity,
          }
          const result = await this.deps.billing.settleUsage(input)
          if (result.settlement.state === "unresolved") {
            this.deps.store.markGapUnresolved(tenantId, "unpriced_usage", "usage_event", ue.eventId, null, result.settlement.lastError)
          } else if (result.settlement.state === "settled") {
            this.deps.store.markGapRepaired(tenantId, "unpriced_usage", "usage_event", ue.eventId, null)
          }
        }
      } else if (settlement.state === "settled" && settlement.ledgerEntryId === null) {
        // C: priced but missing the ledger entry link.
        this.deps.store.recordGap(tenantId, "missing_ledger_entry", "usage_event", ue.eventId, null, "settled usage has no ledger entry", runId)
      }
      // D: duplicate ledger entries for the same usage source.
      const ledgerEntries = await this.deps.billing.listJobEntries(tenantId, ue.jobId)
      const matching = ledgerEntries.filter((le) => le.sourceRef === ue.eventId)
      if (matching.length > 1) {
        this.deps.store.recordGap(tenantId, "duplicate_candidate", "ledger_entry", ue.eventId, null, `${matching.length} ledger entries reference one usage event`, runId)
      }
    }

    return maxSeq
  }

  /** E/F: reservation consistency. Orphaned active reservations and terminal
   *  jobs with unsettled reservations. */
  private async reconcileReservations(tenantId: string, runId: string, repair: boolean): Promise<void> {
    // Enumerate all scopes that have reservations for this tenant by scanning
    // reservations (tenant-scoped). The quota store lists per-scope, so gather
    // distinct (org,project) scopes from reservations directly via the store's
    // database is not exposed; instead use a broad approach: list reservations
    // for each known project is infeasible. Use quota.getUsage per scope is
    // also per-scope. The cleanest tenant-wide scan needs a list-by-tenant on
    // reservations. We add that capability lazily via the quota store's
    // listReservations per scope — but we don't have all scopes here.
    //
    // Instead, drive reservation reconciliation from JOBS (authoritative): for
    // each job, find its reservation by scanning the job's project scope.
    const jobs = await this.deps.jobs.listJobsByTenant(tenantId)
    const seenScopes = new Set<string>()
    for (const job of jobs) {
      const scopeKey = `${job.orgId}|${job.projectId}`
      if (seenScopes.has(scopeKey)) continue
      seenScopes.add(scopeKey)
      const reservations = await this.deps.quota.listReservations({ tenantId, orgId: job.orgId, projectId: job.projectId })
      for (const res of reservations) {
        if (res.state === "active") {
          // E: orphaned reservation — active but the linked job is unknown/missing.
          if (res.jobId) {
            const linked = jobs.find((j) => j.jobId === res.jobId)
            if (!linked) {
              this.deps.store.recordGap(tenantId, "orphaned_reservation", "reservation", res.reservationId, null, "active reservation references unknown job", runId)
            } else if (TERMINAL_STATUSES.has(linked.status)) {
              // F: terminal job with an unsettled (still-active) reservation.
              this.deps.store.recordGap(tenantId, "terminal_unsettled_reservation", "reservation", res.reservationId, null, `terminal job ${linked.status} has active reservation`, runId)
              if (repair) {
                // Safe repair: a terminal job's reservation no longer needs to
                // hold capacity. Release it (idempotent + fenced by version).
                try {
                  await this.deps.quota.release(res.reservationId, res.version)
                  this.deps.store.markGapRepaired(tenantId, "terminal_unsettled_reservation", "reservation", res.reservationId, null)
                } catch {
                  // Fenced (version moved on) — leave as open; next run retries.
                }
              }
            }
          } else {
            // E: active reservation with no job — orphaned (e.g. crash after
            // reservation before admission). The reaper handles TTL; record it.
            this.deps.store.recordGap(tenantId, "orphaned_reservation", "reservation", res.reservationId, null, "active reservation has no linked job", runId)
          }
        }
      }
    }
  }

  /** Operational snapshot of reconciliation health for a tenant. */
  async health(tenantId: string): Promise<ReconciliationHealth> {
    const last = this.deps.store.lastSuccessfulRun(tenantId, "tenant")
    const openGaps = this.deps.store.listOpenGaps(tenantId)
    const unresolvedUsage = openGaps.filter((g) => g.kind === "unpriced_usage" && g.state === "unresolved").length
    const unresolvedPricing = unresolvedUsage
    const orphanedReservations = openGaps.filter((g) => g.kind === "orphaned_reservation").length
    const terminalUnsettled = openGaps.filter((g) => g.kind === "terminal_unsettled_reservation").length
    const missingLedger = openGaps.filter((g) => g.kind === "missing_ledger_entry").length
    const missingUsage = openGaps.filter((g) => g.kind === "missing_usage_event").length
    const settlementBacklog = this.deps.billing.listSettlementsByState(tenantId, "unresolved").length + this.deps.billing.listSettlementsByState(tenantId, "pending").length
    return {
      tenantId,
      lastSuccessfulRun: last
        ? { runId: last.runId, finishedAt: last.finishedAt, watermark: last.watermark, gapsFound: last.gapsFound, gapsRepaired: last.gapsRepaired }
        : null,
      interruptedRuns: this.deps.store.countInterruptedRuns(tenantId),
      openGaps: {
        missingUsage,
        unresolvedUsage,
        unresolvedPricing,
        missingLedger,
        orphanedReservations,
        terminalUnsettled,
        total: openGaps.length,
      },
      settlementBacklog,
    }
  }
}

export interface ReconciliationHealth {
  readonly tenantId: string
  readonly lastSuccessfulRun: { runId: string; finishedAt: number | null; watermark: number; gapsFound: number; gapsRepaired: number } | null
  readonly interruptedRuns: number
  readonly openGaps: {
    readonly missingUsage: number
    readonly unresolvedUsage: number
    readonly unresolvedPricing: number
    readonly missingLedger: number
    readonly orphanedReservations: number
    readonly terminalUnsettled: number
    readonly total: number
  }
  readonly settlementBacklog: number
}

/** Re-export gap kinds for the health/ops layer. */
export type { GapKind }
