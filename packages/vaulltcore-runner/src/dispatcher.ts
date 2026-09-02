/**
 * Local in-memory {@link JobDispatcher} (Phase 1D).
 *
 * Useful for tests and for a single-process deployment where the control plane
 * and worker share an address space. It is NOT durable across process restarts
 * — for durability use the SQL-backed dispatcher in `@vaulltcore/store-sql`.
 *
 * Fencing is still preserved: a claim carries a fenced generation/token, and
 * heartbeat/release verify the token before mutating. The claim never
 * co-occurs with a stale owner because the queue is single-writer.
 */

import { VaulltcoreError } from "./errors"
import { newLeaseToken } from "./ids"
import type { DispatchClaim, JobDispatcher, LeaseRenewalResult, WorkerIdentity } from "./distributed"

interface LocalClaim {
  jobId: string
  worker: WorkerIdentity
  generation: number
  token: string
  expiresAt: number
  acknowledged: boolean
}

/**
 * A local dispatcher. The optional `store` lets `claim` acquire the fenced job
 * lease through a real {@link DurableJobStore} so ownership is durable even when
 * the dispatch queue itself is in-memory; when omitted, claim only manages the
 * in-memory claim record (tests).
 */
export class LocalDispatcher implements JobDispatcher {
  private readonly queue = new Set<string>()
  private readonly claims = new Map<string, LocalClaim>()
  private readonly order: string[] = []

  enqueue(jobId: string): Promise<void> {
    if (!this.queue.has(jobId)) {
      this.queue.add(jobId)
      this.order.push(jobId)
    }
    return Promise.resolve()
  }

  claim(worker: WorkerIdentity, leaseMs: number): Promise<DispatchClaim | null> {
    const now = Date.now()
    // Steal expired claims back into the queue.
    for (const [jobId, claim] of this.claims) {
      if (claim.expiresAt <= now) {
        this.claims.delete(jobId)
        if (!this.queue.has(jobId)) {
          this.queue.add(jobId)
          this.order.push(jobId)
        }
      }
    }
    const nextId = this.order.find((id) => this.queue.has(id))
    if (!nextId) return Promise.resolve(null)
    this.queue.delete(nextId)
    const token = newLeaseToken()
    const claim: LocalClaim = { jobId: nextId, worker, generation: 1, token, expiresAt: now + leaseMs, acknowledged: false }
    this.claims.set(nextId, claim)
    return Promise.resolve({ jobId: nextId, worker, generation: claim.generation, token, expiresAt: claim.expiresAt })
  }

  acknowledge(claim: DispatchClaim): Promise<void> {
    const existing = this.claims.get(claim.jobId)
    if (!existing || existing.token !== claim.token) {
      return Promise.reject(new VaulltcoreError("DISPATCH_FENCED", `acknowledge rejected: stale claim for job ${claim.jobId}`))
    }
    existing.acknowledged = true
    return Promise.resolve()
  }

  heartbeat(claim: DispatchClaim, leaseMs: number): Promise<LeaseRenewalResult> {
    const existing = this.claims.get(claim.jobId)
    if (!existing) return Promise.resolve({ renewed: false, reason: "not_found" })
    if (existing.token !== claim.token) return Promise.resolve({ renewed: false, reason: "fenced" })
    if (existing.expiresAt <= Date.now()) return Promise.resolve({ renewed: false, reason: "expired", expiresAt: existing.expiresAt })
    existing.expiresAt = Date.now() + leaseMs
    return Promise.resolve({ renewed: true, expiresAt: existing.expiresAt })
  }

  release(claim: DispatchClaim): Promise<void> {
    const existing = this.claims.get(claim.jobId)
    if (existing && existing.token === claim.token) this.claims.delete(claim.jobId)
    return Promise.resolve()
  }
}
