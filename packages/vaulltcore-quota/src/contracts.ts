/**
 * Quota reservation contracts (Phase 1E).
 *
 * Quota enforcement MUST reserve capacity BEFORE execution. A reservation is an
 * immutable durable identity whose state machine is:
 *
 *   pending → active → settled
 *                  ↘ released
 *   pending → rejected (capacity denied or policy denied)
 *   active  → expired (TTL; released capacity)
 *
 * Concurrency correctness is mandatory: two simultaneous requests must not both
 * consume the last available capacity. Reservation settlement/release is
 * idempotent, and a stale writer can never settle or release a newer
 * reservation (fenced by an in-row monotonic `version`).
 */

import type { JobIdentity } from "@vaulltcore/runner"

export const RESERVATION_STATES = ["pending", "active", "settled", "released", "expired", "rejected"] as const
export type ReservationState = (typeof RESERVATION_STATES)[number]

/** Limits applied at reservation time (per scope). */
export interface QuotaLimits {
  readonly maxConcurrentJobs: number
  readonly jobsPerPeriod: number
  readonly periodMs: number
  readonly maxTokens: number
  readonly maxDurationMs: number
}

/** A capacity reservation; identity is immutable once created. */
export interface QuotaReservation {
  readonly reservationId: string
  readonly tenantId: string
  readonly orgId: string
  readonly projectId: string
  /** Idempotency key tying a reservation to an admission request, so a replay
   * of the same admission never reserves capacity a second time. */
  readonly requestKey: string
  readonly jobId: string | null
  readonly state: ReservationState
  /** Monotonic per-row version; fenced on every state transition. */
  readonly version: number
  readonly createdAt: number
  readonly settledAt: number | null
  readonly releasedAt: number | null
  readonly expiresAt: number
  /** Actual usage recorded at settlement (≤ reserved). */
  readonly settledTokens: number | null
  readonly settledDurationMs: number | null
  readonly reasonCode: string | null
}

export class QuotaError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = "QuotaError"
  }
}

/** Scope key shared by limits, counters and reservations. */
export interface QuotaScope {
  readonly tenantId: string
  readonly orgId: string
  readonly projectId: string
}

export function quotaScope(identity: JobIdentity): QuotaScope {
  return { tenantId: identity.tenantId, orgId: identity.orgId, projectId: identity.projectId }
}
