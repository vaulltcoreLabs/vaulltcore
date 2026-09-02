/**
 * SQL-backed {@link JobDispatcher} (Phase 1D).
 *
 * A thin async adapter over {@link DistributedSqlStore}, exposing the neutral
 * {@link JobDispatcher} seam. Claim/acknowledge/heartbeat/release are all fenced
 * by the job's ownership generation + token, persisted in `dispatch_claims`
 * and `job_leases`. Separate worker processes can share one SqlDispatcher
 * (against the same database) and the database's row-level locking guarantees
 * exactly one claimant per job.
 *
 * Because {@link JobDispatcher} is async (the contract the control plane + a
 * worker host both speak), while {@link DistributedSqlStore} is sync (SQLite),
 * this adapter simply wraps each call in `Promise.resolve(...)`. The
 * Postgres-backed equivalent is naturally async.
 */

import type { DispatchClaim, JobDispatcher, LeaseRenewalResult, WorkerIdentity } from "@vaulltcore/runner"
import { DistributedSqlStore } from "./distributed-store"

export class SqlDispatcher implements JobDispatcher {
  constructor(private readonly dist: DistributedSqlStore) {}

  enqueue(jobId: string): Promise<void> {
    return Promise.resolve(this.dist.enqueue(jobId))
  }

  claim(worker: WorkerIdentity, leaseMs: number): Promise<DispatchClaim | null> {
    return Promise.resolve(this.dist.claim(worker, leaseMs))
  }

  acknowledge(claim: DispatchClaim): Promise<void> {
    return Promise.resolve(this.dist.acknowledge(claim))
  }

  heartbeat(claim: DispatchClaim, leaseMs: number): Promise<LeaseRenewalResult> {
    return Promise.resolve(this.dist.heartbeat(claim, leaseMs))
  }

  release(claim: DispatchClaim): Promise<void> {
    return Promise.resolve(this.dist.release(claim))
  }
}
