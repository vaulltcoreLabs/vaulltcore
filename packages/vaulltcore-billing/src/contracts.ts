/**
 * Billing ledger contracts (Phase 1E).
 *
 * Billing is kept separate from raw usage. The pipeline is:
 *
 *   UsageEvent → aggregation → pricing calculation → immutable LedgerEntry
 *
 * Pricing is versioned: a {@link PricingVersion} pins the unit prices used for
 * a charge, and a later price change never rewrites historical charges (every
 * ledger entry references the pricing version it was priced under). No
 * external payment processor is integrated in this phase — only internal
 * accounting primitives (charge/debit, adjustment/credit, idempotent
 * settlement).
 *
 * A duplicate usage event can never create a duplicate financial charge: the
 * ledger entry carries a UNIQUE `(scope, source_ref)` idempotency key that maps
 * to the source usage event/aggregate, so re-pricing or re-delivery collapses
 * to one charge.
 */

import type { JobIdentity } from "@vaulltcore/runner"
import type { UsageKind } from "@vaulltcore/metering"

/** A versioned price table. */
export interface PricingVersion {
  readonly pricingId: string
  readonly version: string
  /** Per-unit price in micro-currency (integer) to avoid float drift. */
  readonly unitPrices: Readonly<Record<UsageKind, number>>
  readonly effectiveAt: number
  readonly createdAt: number
}

export const LEDGER_ENTRY_TYPES = ["charge", "adjustment"] as const
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number]

/** An immutable accounting entry. */
export interface LedgerEntry {
  readonly entryId: string
  readonly tenantId: string
  readonly orgId: string
  readonly projectId: string
  readonly jobId: string | null
  readonly type: LedgerEntryType
  /** +charge / -credit; micro-currency. */
  readonly amount: number
  /** Pricing version this entry was priced under (immutable reference). */
  readonly pricingId: string
  readonly pricingVersion: string
  /** Source usage reference (usage event id or aggregate key). */
  readonly sourceRef: string
  /** Idempotency key: UNIQUE (scope, source_ref) prevents duplicate charges. */
  readonly idempotencyKey: string
  readonly createdAt: number
  /** Phase 2F: for adjustments, the original entry being corrected (null for
   *  charges). The original entry is NEVER mutated by an adjustment. */
  readonly originalEntryId: string | null
  /** Phase 2F: typed adjustment reason (null for charges). */
  readonly reason: AdjustmentReason | null
  /** Phase 2F: sanitized human-readable note (never secrets). */
  readonly note: string | null
}

export class BillingError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = "BillingError"
  }
}

export interface BillingScope extends JobIdentity {
  readonly jobId: string | null
}

/** A charge to be priced and recorded. */
export interface ChargeInput {
  readonly identity: BillingScope
  readonly kind: UsageKind
  readonly quantity: number
  /** Source usage reference (usage event id or aggregate key). */
  readonly sourceRef: string
  /** Idempotency key, normally `scope|sourceRef`. */
  readonly idempotencyKey: string
}

/** Account balance for a scope (sum of charges/adjustments). */
export interface AccountBalance {
  readonly tenantId: string
  readonly orgId: string
  readonly projectId: string
  readonly balance: number
  readonly charges: number
  readonly credits: number
}

/** A typed reason for an adjustment/credit (Phase 2F). Adjustments are
 *  append-only corrections that reference an original accounting identity and
 *  NEVER mutate the original quantity. */
export const ADJUSTMENT_REASONS = [
  "billing_error",
  "overcharge",
  "refund",
  "goodwill_credit",
  "quantity_correction",
  "operator_override",
] as const
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number]

/** Input to record an append-only adjustment referencing an original entry
 *  (Phase 2F). The adjustment gets its OWN unique accounting identity; it never
 *  mutates the original. `originalEntryId` makes the correction traceable. */
export interface AdjustmentInput {
  readonly identity: BillingScope
  readonly kind: UsageKind
  readonly quantity: number
  /** The original ledger entry being corrected. */
  readonly originalEntryId: string
  /** Typed reason for the correction (auditable). */
  readonly reason: AdjustmentReason
  /** Optional human-readable note (sanitized; never secrets). */
  readonly note?: string
  /** Idempotency key: UNIQUE (scope, idempotency_key) prevents duplicate
   *  adjustments for the same correction. */
  readonly idempotencyKey: string
  /** Amount in micro-currency to credit (negative = credit/refund). */
  readonly amountMicro: number
}

/**
 * Settlement state machine for a usage event (Phase 1F).
 *
 *   pending → priced → settled      (billable: priced + ledger entry created)
 *   pending → non_billable          (durable reason; no charge)
 *   pending → unresolved            (pricing could not be resolved; durable,
 *                                    surfaced to reconciliation; retryable)
 *
 * `settled` and `non_billable` are terminal-success outcomes. `unresolved` is
 * retryable: a later pricing change or operator action can move it to
 * `priced`/`settled`. History is immutable — a re-pricing after settlement is a
 * NEW adjustment ledger entry, never a mutation of the original.
 */
export const SETTLEMENT_STATES = ["pending", "priced", "settled", "non_billable", "unresolved"] as const
export type SettlementState = (typeof SETTLEMENT_STATES)[number]

/** A durable usage→ledger settlement record. */
export interface UsageSettlement {
  readonly tenantId: string
  readonly eventId: string
  readonly jobId: string
  readonly orgId: string
  readonly projectId: string
  readonly kind: UsageKind
  readonly quantity: number
  readonly state: SettlementState
  readonly pricingId: string | null
  readonly pricingVersion: string | null
  readonly ledgerEntryId: string | null
  readonly amountMicro: number | null
  readonly nonBillableReason: string | null
  readonly settledAt: number | null
  readonly attempts: number
  readonly lastError: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

/** Input to settle a single usage event. */
export interface SettleUsageInput {
  readonly tenantId: string
  readonly eventId: string
  readonly jobId: string
  readonly orgId: string
  readonly projectId: string
  readonly kind: UsageKind
  readonly quantity: number
}

/** Outcome of settling one usage event. */
export interface SettleUsageResult {
  readonly settlement: UsageSettlement
  readonly ledgerEntry: LedgerEntry | null
  readonly duplicated: boolean
}
