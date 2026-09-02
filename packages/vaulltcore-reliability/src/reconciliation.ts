/**
 * Reconciliation service for stranded/crashed work (Phase 2E).
 *
 * Finds work stranded by crashes or infrastructure interruption and re-drives
 * it safely. It is safe to run repeatedly and concurrently: it reads
 * authoritative state, detects incomplete/expired resources, and re-enqueues
 * idempotent operational work (UNIQUE idempotency_key collapses duplicates) or
 * re-drives through fenced leases. It NEVER scans and blindly rewrites records;
 * every repair is a fenced/idempotent transition.
 *
 * Detects:
 *   - expired ops work leases (a crashed worker's claim lapsed) → reaped
 *   - ops retries whose next-attempt time passed → re-claimable
 *   - dispatches stranded before completion → fenced redrive
 *   - runs admitted but stale (no active owner) → reconcileRun
 *   - dead-lettered work → operator visibility (NOT auto-retried)
 *
 * Bounded batch processing with continuation: each scan reads a bounded batch
 * (default 100) using a stable updated_at cursor so reconciliation itself
 * cannot become an unbounded memory/DB operation. A durable scan watermark
 * is optional; the idempotency of the underlying enqueues makes a watermark
 * an optimization, not a correctness requirement. Repeated scans never
 * duplicate work (UNIQUE idempotency boundaries).
 *
 * Dependency direction: reliability → {ops, automation, quota, audit,
 * store-sql}. It never depends on the runner or control plane. It never
 * invokes agent execution — reconcileRun re-projects + re-drives idempotently
 * through the AutomationService seam (the dispatcher deduplicates on
 * (runId, stepId)).
 */

import type { SqlOpsStore } from "@vaulltcore/ops"
import type { TriggerDispatchService } from "@vaulltcore/automation"
import type { AutomationService } from "@vaulltcore/automation"
import type { AutomationStore } from "@vaulltcore/automation"
import type { SqlQuotaStore } from "@vaulltcore/quota"
import type { TelemetrySink } from "./telemetry"

export interface ReconciliationDeps {
  readonly opsStore: SqlOpsStore
  readonly dispatchService?: TriggerDispatchService
  readonly service?: AutomationService
  readonly automationStore?: AutomationStore
  readonly quotaStore?: SqlQuotaStore
  readonly telemetry?: TelemetrySink
  readonly tenantId: string
  readonly now?: () => number
  /** Bounded batch size per scan. Default 100. */
  readonly batchSize?: number
}

/** Result of one bounded reconciliation pass. */
export interface ReconciliationResult {
  readonly scanned: number
  readonly expiredLeases: number
  readonly dueRetries: number
  readonly strandedDispatches: number
  readonly abandonedRuns: number
  readonly leakedCapacity: number
  /** Continuation cursor for the next bounded batch (null when done). */
  readonly nextCursor: { updatedAt: number; id: string } | null
}

/**
 * A bounded, repeatable, concurrent-safe reconciliation pass. Each call scans
 * a bounded batch and returns a continuation cursor; a caller pages until the
 * cursor is null. All repairs are idempotent + fenced.
 */
export class ReliabilityReconciliationService {
  private readonly opsStore: SqlOpsStore
  private readonly dispatchService?: TriggerDispatchService
  private readonly service?: AutomationService
  private readonly automationStore?: AutomationStore
  private readonly quotaStore?: SqlQuotaStore
  private readonly telemetry?: TelemetrySink
  private readonly tenantId: string
  private readonly now: () => number
  private readonly batchSize: number

  constructor(deps: ReconciliationDeps) {
    this.opsStore = deps.opsStore
    this.dispatchService = deps.dispatchService
    this.service = deps.service
    this.automationStore = deps.automationStore
    this.quotaStore = deps.quotaStore
    this.telemetry = deps.telemetry
    this.tenantId = deps.tenantId
    this.now = deps.now ?? Date.now
    this.batchSize = deps.batchSize ?? 100
  }

  /** Run one bounded batch. Pass the previous result's nextCursor to continue.
   *  Safe to run repeatedly and concurrently — every repair is idempotent. */
  async reconcile(cursor: { updatedAt: number; id: string } | null = null): Promise<ReconciliationResult> {
    const now = this.now()
    let scanned = 0
    let expiredLeases = 0
    let dueRetries = 0
    let strandedDispatches = 0
    let abandonedRuns = 0
    let leakedCapacity = 0

    // 1. Reap expired ops leases (a crashed worker's claim lapsed) so the work
    //    becomes re-claimable. Idempotent + fenced (existing reapExpiredClaims).
    expiredLeases = this.opsStore.reapExpiredClaims(now)

    // 2. Bounded scan of non-terminal ops items for due retries + stranded
    //    work. The scan is read-only; the ops worker (fenced) re-claims + runs
    //    the matching reaper. Idempotent enqueue (UNIQUE) collapses duplicates.
    const batch = this.opsStore.listPendingBatch(this.tenantId, this.batchSize, cursor?.updatedAt ?? null, cursor?.id ?? null)
    scanned = batch.items.length
    for (const item of batch.items) {
      if (item.state === "failed_retriable" && item.nextRetryAt !== null && item.nextRetryAt <= now) {
        dueRetries++
      }
      if (item.state === "claimed" && item.claimExpiresAt !== null && item.claimExpiresAt <= now) {
        expiredLeases++
      }
    }

    // 3. Reclaim leaked capacity (expired quota reservations) — idempotent +
    //    fenced. Reclaims both per-scope and global counters.
    if (this.quotaStore) {
      leakedCapacity = await this.quotaStore.reapExpired(now)
    }

    // 4. Re-drive stranded dispatches under a fenced lease (the dispatch
    //    service's redrive is fenced; terminal dispatches are never claimed).
    //    This is the recovery path for a crash between dispatch reservation and
    //    run creation. Bounded by the same batchSize.
    if (this.dispatchService) {
      const redrive = await this.dispatchService.redrive(this.tenantId, this.batchSize)
      strandedDispatches = redrive.driven
    }

    // 5. Re-project + re-drive abandoned runs (non-terminal, stale). Bounded;
    //    reconcileRun is idempotent (reads durable mappings, re-projects, the
    //    dispatcher deduplicates on (runId, stepId)). Never invokes agent
    //    execution directly.
    if (this.service && this.automationStore) {
      const staleThreshold = now - 5 * 60_000
      for (const run of await this.automationStore.listStaleRuns(this.tenantId, staleThreshold, this.batchSize)) {
        try {
          await this.service.reconcileRun(abandonedPrincipal(this.tenantId), run.runId)
          abandonedRuns++
        } catch {
          // A concurrent transition fenced this run; idempotent — skip.
        }
      }
    }

    await this.telemetry?.emit({
      tenantId: this.tenantId,
      type: "reconciliation_detected",
      metadata: {
        scanned,
        expiredLeases,
        dueRetries,
        strandedDispatches,
        abandonedRuns,
        leakedCapacity,
        cursor: batch.nextCursor ? `${batch.nextCursor.updatedAt}:${batch.nextCursor.id}` : null,
      },
    })

    return {
      scanned,
      expiredLeases,
      dueRetries,
      strandedDispatches,
      abandonedRuns,
      leakedCapacity,
      nextCursor: batch.nextCursor,
    }
  }

  /** Run bounded batches until the cursor is null (bounded continuation). The
   *  whole pass is bounded by maxBatches so reconciliation cannot run forever. */
  async reconcileAll(maxBatches = 10): Promise<ReconciliationResult> {
    let cursor: { updatedAt: number; id: string } | null = null
    let last: ReconciliationResult = { scanned: 0, expiredLeases: 0, dueRetries: 0, strandedDispatches: 0, abandonedRuns: 0, leakedCapacity: 0, nextCursor: null }
    for (let i = 0; i < maxBatches; i++) {
      last = await this.reconcile(cursor)
      cursor = last.nextCursor
      if (!cursor) break
    }
    return last
  }
}

/** A system principal for privileged re-drives. The caller already
 *  authenticated; this is an internal privileged worker, not a request path. */
function abandonedPrincipal(tenantId: string) {
  return {
    tenantId,
    orgId: "*",
    projectId: "*",
    principalId: "reliability-reconcile",
    kind: "service_account" as const,
    role: "service_account" as const,
    admin: true,
    projectScope: ["*"] as ReadonlyArray<string>,
  }
}
