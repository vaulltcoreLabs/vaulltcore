/**
 * SQL-backed registries (Phase 1D) implementing the neutral
 * {@link IdempotencyRegistry} and {@link SnapshotRegistry} seams over
 * {@link DistributedSqlStore}. These adapters make the sync SQLite store
 * speak the neutral async-or-sync registry contract; PostgresJobStore exposes
 * an async variant over the same schema.
 */

import type {
  IdempotencyClaim,
  IdempotencyClaimResult,
  IdempotencyRecord,
  IdempotencyRegistry,
  SnapshotGcDecision,
  SnapshotRecord,
  SnapshotRegistry,
  SnapshotLifecycleState,
} from "@vaulltcore/runner"
import { ACTIVE_SNAPSHOT_STATES } from "@vaulltcore/runner"
import { DistributedSqlStore } from "./distributed-store"

/** Idempotency registry backed by the SQLite DistributedSqlStore. */
export class SqlIdempotencyRegistry implements IdempotencyRegistry {
  constructor(private readonly dist: DistributedSqlStore) {}

  claim(claim: IdempotencyClaim): IdempotencyClaimResult {
    return this.dist.claimIdempotency(claim)
  }
  fulfill(slotId: string, jobId: string, responseStatus: number): void {
    // slotId is deterministic (sha256 of tenant+key+requestHash) so reconstruct
    // the claim from the row. To keep the adapter simple, we look up the record
    // by the slotId's components. DistributedSqlStore.fulfillIdempotency takes
    // the IdempotencyClaim; resolve it here.
    const rec = this.dist.getIdempotencyRecordBySlotId(slotId)
    if (!rec) {
      // Slot gone: nothing to fulfill (caller's createJob failed-then-retried path
      // is handled by re-claiming). Treat as no-op.
      return
    }
    this.dist.fulfillIdempotency({ tenantId: rec.tenantId, key: rec.key, requestHash: rec.requestHash }, jobId, responseStatus)
  }
  get(tenantId: string, key: string): IdempotencyRecord | null {
    return this.dist.getIdempotencyRecord(tenantId, key)
  }
  lookup(tenantId: string, key: string): { jobId: string; responseStatus: number | null } | null {
    const r = this.dist.getIdempotencyRecord(tenantId, key)
    if (!r || r.jobId === null) return null
    return { jobId: r.jobId, responseStatus: r.responseStatus }
  }
  delete(tenantId: string, key: string): void {
    this.dist.deleteIdempotencyRecord(tenantId, key)
  }
}

/** Snapshot lifecycle registry backed by the SQLite DistributedSqlStore. */
export class SqlSnapshotRegistry implements SnapshotRegistry {
  constructor(private readonly dist: DistributedSqlStore) {}

  register(record: Omit<SnapshotRecord, "state" | "supersededBy" | "updatedAt">): SnapshotRecord {
    this.dist.recordSnapshotCreated(record)
    return this.dist.getSnapshotRecord(record.snapshotId)!
  }
  activate(snapshotId: string): SnapshotRecord | null {
    this.dist.activateSnapshot(snapshotId)
    return this.dist.getSnapshotRecord(snapshotId)
  }
  supersede(snapshotId: string, bySnapshotId: string): SnapshotRecord | null {
    this.dist.supersedeSnapshot(snapshotId, bySnapshotId)
    return this.dist.getSnapshotRecord(snapshotId)
  }
  latestForJob(jobId: string): SnapshotRecord | null {
    const all = this.dist.listJobSnapshots(jobId)
    const active = all.filter((r) => ACTIVE_SNAPSHOT_STATES.has(r.state))
    if (active.length === 0) return null
    return active[active.length - 1]!
  }
  listForJob(jobId: string): readonly SnapshotRecord[] {
    return [...this.dist.listJobSnapshots(jobId)].reverse()
  }
  gcDecision(now?: number): SnapshotGcDecision {
    return this.dist.gcDecision(now)
  }
  applyGc(decision: SnapshotGcDecision): void {
    for (const r of decision.deletable) {
      this.dist.markSnapshotState(r.snapshotId, "deleting" as SnapshotLifecycleState)
      this.dist.deleteSnapshotRecord(r.snapshotId)
    }
  }
}
