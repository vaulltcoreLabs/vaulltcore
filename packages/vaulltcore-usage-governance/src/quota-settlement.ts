/**
 * Quota settlement integration (Phase 2F).
 *
 * Bridges the admission RESERVATION (economic capacity held before execution)
 * and POST-USAGE ACCOUNTING (actual metered consumption). These are distinct
 * concepts: the reservation holds a concurrency slot; metered usage is the real
 * consumption recorded in the immutable ledger. This service derives ACTUAL
 * usage from the metering ledger for a job and settles the job's reservation
 * against it exactly once, idempotently + fenced by the reservation version.
 *
 * It does NOT create a second quota authority — it reads metered actuals and
 * calls the existing {@link SqlQuotaStore.settle} (which releases the
 * concurrency slot). Invariants:
 *   - no double-settlement: a settled reservation returns its recorded outcome
 *     (duplicated=true) — quota.settle is idempotent on the `settled` state.
 *   - no negative balances: actuals are summed from non-negative ledger
 *     quantities; the reservation's capacity hold is released exactly once.
 *   - no releasing already-settled reservations: settle/release are no-ops on
 *     terminal states.
 *   - no cross-tenant settlement: the reservation is loaded by id and its
 *     tenant is checked against the requesting tenant.
 *   - retry double-settlement: a retry returns the same recorded outcome.
 */

import type { SqlQuotaStore } from "@vaulltcore/quota"
import { QuotaError } from "@vaulltcore/quota"
import type { SqlMeteringStore, UsageAggregate } from "@vaulltcore/metering"
import type { QuotaSettlementResult } from "./contracts"
import { UsageGovernanceError } from "./contracts"

export interface QuotaSettlementServiceOptions {
  readonly metering: SqlMeteringStore
  readonly quota: SqlQuotaStore
}

export class QuotaSettlementService {
  private readonly metering: SqlMeteringStore
  private readonly quota: SqlQuotaStore

  constructor(options: QuotaSettlementServiceOptions) {
    this.metering = options.metering
    this.quota = options.quota
  }

  /**
   * Settle a reservation against the ACTUAL metered usage for its linked job.
   * Reads the job's aggregate from the immutable ledger (authoritative),
   * derives {tokens, durationMs}, and calls quota.settle() with the
   * reservation's current version (fenced). Idempotent: a reservation already
   * settled returns its recorded outcome (duplicated=true) without
   * re-settling. A reservation with no linked job is an admission that never
   * created a job (rejected/crashed) — settling it would fabricate execution
   * usage, so it is rejected honestly (no fake consumption).
   */
  async settleAgainstActualUsage(tenantId: string, reservationId: string): Promise<QuotaSettlementResult> {
    const reservation = await this.quota.getReservation(reservationId)
    if (!reservation) throw new UsageGovernanceError("RESERVATION_NOT_FOUND", "reservation not found", 404)
    // Cross-tenant settlement is forbidden (no existence leak — a wrong-tenant
    // id returns 404 indistinguishable from absence).
    if (reservation.tenantId !== tenantId) {
      throw new UsageGovernanceError("RESERVATION_NOT_FOUND", "reservation not found", 404)
    }
    // Already settled → idempotent duplicate (no double-settlement).
    if (reservation.state === "settled") {
      return {
        reservationId: reservation.reservationId,
        state: reservation.state,
        settledTokens: reservation.settledTokens,
        settledDurationMs: reservation.settledDurationMs,
        duplicated: true,
      }
    }
    if (reservation.state === "released" || reservation.state === "expired" || reservation.state === "rejected") {
      // A released/expired/rejected reservation holds no capacity to settle.
      return {
        reservationId: reservation.reservationId,
        state: reservation.state,
        settledTokens: reservation.settledTokens,
        settledDurationMs: reservation.settledDurationMs,
        duplicated: true,
      }
    }
    if (reservation.state !== "active") {
      throw new UsageGovernanceError("INVALID_RESERVATION_STATE", `cannot settle reservation in state "${reservation.state}"`, 409)
    }
    // A reservation with no linked job never executed — settling it would
    // fabricate execution usage. Reject honestly (operator should release it).
    if (!reservation.jobId) {
      throw new UsageGovernanceError("NO_LINKED_JOB", "reservation has no linked job; cannot settle against fabricated usage", 422)
    }
    // Authoritative actuals from the immutable ledger.
    const actual: UsageAggregate = await this.metering.aggregateJob(tenantId, reservation.jobId)
    const tokens = actual.totalTokens
    const durationMs = actual.durationMs
    try {
      const settled = await this.quota.settle(reservationId, reservation.version, { tokens, durationMs })
      return {
        reservationId: settled.reservationId,
        state: settled.state,
        settledTokens: settled.settledTokens,
        settledDurationMs: settled.settledDurationMs,
        duplicated: false,
      }
    } catch (error) {
      if (error instanceof QuotaError && error.code === "RESERVATION_FENCED") {
        // A newer version owns the reservation — a stale writer cannot settle.
        throw new UsageGovernanceError("RESERVATION_FENCED", "reservation is owned by a newer version", 409)
      }
      if (error instanceof QuotaError && error.code === "INVALID_RESERVATION_STATE") {
        // Settled concurrently between our read and write — idempotent.
        const after = await this.quota.getReservation(reservationId)
        return {
          reservationId: reservationId,
          state: after?.state ?? reservation.state,
          settledTokens: after?.settledTokens ?? null,
          settledDurationMs: after?.settledDurationMs ?? null,
          duplicated: true,
        }
      }
      throw error
    }
  }
}
