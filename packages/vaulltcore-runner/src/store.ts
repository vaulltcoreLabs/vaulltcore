/**
 * Durable store boundary. The runner never trusts process memory for
 * authoritative state: job records, the append-only event log, and the latest
 * checkpoint all live behind this interface.
 *
 * Phase 1A ships a single-node file implementation. The interface is shaped
 * so a transactional database implementation (with real cross-worker lease
 * CAS) can replace it without touching the runner.
 */

import type { JobCheckpoint, JobEvent, JobRecord, NewJobEvent } from "./contracts"
import { IdentityMismatchError } from "./errors"
import type { LeaseRenewalResult } from "./distributed"

/** Fields frozen at creation: tenant identity and job wiring can never change. */
export const IMMUTABLE_JOB_FIELDS = ["jobId", "tenantId", "orgId", "projectId", "createdAt", "spec", "env", "policy"] as const

/** Reject any patch that would mutate a frozen field. Shared by every
 * DurableJobStore implementation so the invariant holds identically
 * regardless of the persistence backend. */
export function assertImmutableJobUpdate(jobId: string, record: JobRecord, patch: Partial<JobRecord>): void {
  for (const key of IMMUTABLE_JOB_FIELDS) {
    if (key in patch && JSON.stringify(patch[key]) !== JSON.stringify(record[key])) {
      throw new IdentityMismatchError(jobId, `attempted mutation of immutable field "${key}"`)
    }
  }
}

export interface LeaseGrant {
  readonly attempt: number
  readonly leaseToken: string
  readonly leaseExpiresAt: number
}

export interface DurableJobStore {
  createJobRecord(record: JobRecord): Promise<void>
  getJobRecord(jobId: string): Promise<JobRecord | null>
  /** Atomic compare-and-swap on the record; `expectedAttempt` fences stale workers. */
  updateJobRecord(
    jobId: string,
    expectedAttempt: number,
    mutate: (record: JobRecord) => Partial<JobRecord>,
  ): Promise<JobRecord>
  /**
   * Acquire (or steal, when expired) the lease. Increments the ownership
   * generation (attempt) and returns a fencing token. Throws when a live
   * lease is held by another token.
   */
  acquireLease(jobId: string, leaseToken: string, leaseMs: number): Promise<LeaseGrant>
  /**
   * Phase 1D: fenced lease renewal (the heartbeat durability path). Renewal
   * must itself be fenced — a stale worker waking up after a network
   * partition can never reclaim authority. Extends `expiresAt` only when the
   * caller's token matches the current lease; otherwise returns a fenced
   * result (never throws, so a supervisor can classify expiry deterministically).
   * Optional: stores without it keep the Phase 1A/1B acquire-on-expiry model.
   */
  renewLease?(jobId: string, leaseToken: string, leaseMs: number): Promise<LeaseRenewalResult>
  /** Explicitly release ownership (no-op when already released). */
  releaseLease?(jobId: string, leaseToken: string): Promise<void>
  /**
   * Append events; assigns monotonic seq starting at 1. Atomic per batch.
   * When `expectedAttempt` is supplied, stale ownership generations are
   * rejected (Phase 1B ownership fencing: one authoritative writer).
   */
  appendEvents<T>(jobId: string, events: readonly NewJobEvent<T>[], expectedAttempt?: number): Promise<JobEvent<T>[]>
  listEvents(jobId: string, afterSeq?: number): Promise<JobEvent[]>
  /** Persist the latest checkpoint; rejects writes from a stale attempt. */
  saveCheckpoint(jobId: string, checkpoint: JobCheckpoint): Promise<void>
  getCheckpoint(jobId: string): Promise<JobCheckpoint | null>
}
