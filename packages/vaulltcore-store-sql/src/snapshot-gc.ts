/**
 * Retry-safe snapshot GC driver (Phase 1F, Deliverable 7).
 *
 * State machine per snapshot:
 *
 *   active → eligible_for_gc → deleting → deleted
 *                                    ↘ (provider failure: stays deleting, retryable)
 *
 * A snapshot becomes eligible ONLY when the conservative {@link gcDecision}
 * marks it deletable (expired-and-superseded-by-active, or superseded-by-active
 * and not the last active artifact). The driver NEVER deletes a snapshot
 * required by an active recovery path — that invariant lives in `gcDecision`.
 *
 * Provider deletion is confirmed before claiming success: a snapshot is marked
 * `deleted` only after the provider callback resolves. A failed deletion leaves
 * the snapshot in `deleting` with `last_error`/`attempts` bumped — it remains
 * retryable on the next run. If the provider supports idempotent deletion (e.g.
 * returns success for an already-deleted id), the callback should return true
 * and the snapshot is marked deleted regardless of prior attempts.
 *
 * GC is conservative and idempotent: re-running over already-`deleted` or
 * already-`eligible` snapshots is a no-op; the (snapshot_id) PRIMARY KEY on
 * `snapshot_gc_attempts` prevents duplicate GC records.
 */

import type { DistributedSqlStore } from "./distributed-store"
import type { SnapshotRecord, SnapshotGcDecision } from "@vaulltcore/runner"

export type SnapshotGcAttemptState = "eligible" | "deleting" | "deleted" | "failed"

export interface SnapshotGcAttempt {
  readonly snapshotId: string
  readonly tenantId: string
  readonly state: SnapshotGcAttemptState
  readonly attempts: number
  readonly lastError: string | null
  readonly lastAttemptAt: number | null
  readonly eligibleAt: number
  readonly deletedAt: number | null
}

interface GcAttemptRow {
  snapshot_id: string
  tenant_id: string
  state: string
  attempts: number
  last_error: string | null
  last_attempt_at: number | null
  eligible_at: number
  deleted_at: number | null
}

function toAttempt(r: GcAttemptRow): SnapshotGcAttempt {
  return {
    snapshotId: r.snapshot_id,
    tenantId: r.tenant_id,
    state: r.state as SnapshotGcAttemptState,
    attempts: r.attempts,
    lastError: r.last_error,
    lastAttemptAt: r.last_attempt_at,
    eligibleAt: r.eligible_at,
    deletedAt: r.deleted_at,
  }
}

/**
 * Provider deletion callback. Returns true if the snapshot was deleted (or was
 * already absent — idempotent delete). Throws/returns false on a failure that
 * should leave the snapshot retryable. The callback receives the snapshot
 * record (with provider + storage pointer) so it can issue the right call.
 */
export type SnapshotProviderDeleter = (snapshot: SnapshotRecord) => Promise<boolean>

export interface SnapshotGcResult {
  readonly processed: number
  readonly deleted: number
  readonly failed: number
  readonly skipped: number
  readonly stillEligible: number
}

/**
 * Drives retry-safe snapshot GC over a {@link DistributedSqlStore}. Reconciles
 * the conservative `gcDecision` (what is SAFE to collect) against the durable
 * GC-attempt table (what has been ATTEMPTED), then invokes the provider deleter
 * for each eligible snapshot, confirming deletion before marking success.
 */
export class SnapshotGcDriver {
  constructor(
    private readonly dist: DistributedSqlStore,
    private readonly deleter: SnapshotProviderDeleter,
  ) {}

  /** Compute the conservative GC decision (delegates to the registry). */
  decision(now: number = Date.now()): SnapshotGcDecision {
    return this.dist.gcDecision(now)
  }

  /**
   * Run one GC pass. For each deletable snapshot from the conservative
   * decision:
   * 1. Ensure a durable GC-attempt row exists (idempotent on snapshot_id).
   * 2. Skip snapshots already `deleted`.
   * 3. Transition `eligible`/`failed` → `deleting`.
   * 4. Call the provider deleter. On success → `deleted` + mark the snapshot
   *    lifecycle row `deleted`. On failure → bump attempts, record last_error,
   *    stay `deleting` (retryable on the next run).
   *
   * Returns aggregate counts. Safe to call repeatedly; a crashed run mid-delete
   * leaves the snapshot in `deleting` and the next pass retries it.
   */
  async runGc(now: number = Date.now()): Promise<SnapshotGcResult> {
    const decision = this.dist.gcDecision(now)
    const deletable = decision.deletable
    let processed = 0
    let deleted = 0
    let failed = 0
    let skipped = 0
    let stillEligible = 0
    for (const snapshot of deletable) {
      processed++
      // Ensure a GC-attempt row (idempotent).
      this.dist.atomic(() => {
        this.dist.prepare(
          `INSERT INTO snapshot_gc_attempts (snapshot_id, tenant_id, state, attempts, last_error, last_attempt_at, eligible_at, deleted_at)
           VALUES (?, ?, 'eligible', 0, NULL, NULL, ?, NULL)
           ON CONFLICT (snapshot_id) DO NOTHING`,
        ).run(snapshot.snapshotId, snapshot.tenantId, now)
      })
      const attempt = this.getAttempt(snapshot.snapshotId)!
      if (attempt.state === "deleted") {
        skipped++
        continue
      }
      // Transition to deleting (claim). Idempotent: eligible/failed/deleting → deleting.
      this.dist.atomic(() => {
        this.dist.prepare(
          "UPDATE snapshot_gc_attempts SET state = 'deleting', last_attempt_at = ?, attempts = attempts + 1 WHERE snapshot_id = ? AND state IN ('eligible','failed','deleting')",
        ).run(now, snapshot.snapshotId)
      })
      // Invoke the provider deleter.
      try {
        const ok = await this.deleter(snapshot)
        if (ok) {
          this.dist.atomic(() => {
            this.dist.prepare("UPDATE snapshot_gc_attempts SET state = 'deleted', deleted_at = ?, last_error = NULL WHERE snapshot_id = ?").run(now, snapshot.snapshotId)
            // Mark the lifecycle row deleted (provider confirmed). The physical
            // row is retained for audit/provenance; state=deleted is the tombstone.
            // Inlined (not markSnapshotState) to avoid a nested transaction.
            this.dist.prepare("UPDATE snapshot_lifecycle SET state = 'deleted', updated_at = ? WHERE snapshot_id = ?").run(now, snapshot.snapshotId)
          })
          deleted++
        } else {
          this.dist.atomic(() => {
            this.dist.prepare("UPDATE snapshot_gc_attempts SET state = 'failed', last_error = ? WHERE snapshot_id = ?").run("provider returned false", snapshot.snapshotId)
          })
          failed++
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown provider error"
        this.dist.atomic(() => {
          this.dist.prepare("UPDATE snapshot_gc_attempts SET state = 'failed', last_error = ? WHERE snapshot_id = ?").run(message, snapshot.snapshotId)
        })
        failed++
      }
    }
    // Count remaining eligible (not yet processed by a provider this pass but
    // safe to collect) for backlog reporting.
    stillEligible = this.listByState("eligible").length + this.listByState("failed").length + this.listByState("deleting").length
    return { processed, deleted, failed, skipped, stillEligible }
  }

  /** Read a GC attempt record. */
  getAttempt(snapshotId: string): SnapshotGcAttempt | null {
    const row = this.dist.prepare("SELECT * FROM snapshot_gc_attempts WHERE snapshot_id = ?").get(snapshotId) as unknown as GcAttemptRow | undefined
    return row ? toAttempt(row) : null
  }

  /** List GC attempts in a given state (operational backlog). */
  listByState(state: SnapshotGcAttemptState): SnapshotGcAttempt[] {
    const rows = this.dist.prepare("SELECT * FROM snapshot_gc_attempts WHERE state = ? ORDER BY eligible_at ASC").all(state) as unknown as GcAttemptRow[]
    return rows.map(toAttempt)
  }

  /** Mark a snapshot explicitly eligible for GC (operator override). */
  markEligible(snapshotId: string, tenantId: string, now: number = Date.now()): void {
    this.dist.atomic(() => {
      this.dist.prepare(
        `INSERT INTO snapshot_gc_attempts (snapshot_id, tenant_id, state, attempts, last_error, last_attempt_at, eligible_at, deleted_at)
         VALUES (?, ?, 'eligible', 0, NULL, NULL, ?, NULL)
         ON CONFLICT (snapshot_id) DO UPDATE SET state = 'eligible' WHERE snapshot_gc_attempts.state IN ('failed','deleting')`,
      ).run(snapshotId, tenantId, now)
    })
  }
}
