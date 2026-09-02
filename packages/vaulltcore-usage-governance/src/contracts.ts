/**
 * Usage governance contracts (Phase 2F).
 *
 * This package is the B2B usage-governance bridge over the existing metering
 * (immutable usage ledger) + billing (immutable cost ledger) + quota
 * (admission reservations) stores. It does NOT introduce a competing quota
 * authority, a second agent runtime, or a second accounting ledger. It provides:
 *
 *   - bounded, paginated, filtered aggregation/query over the immutable ledger
 *   - a provider-neutral cost-attribution seam (CostCatalog) where usage
 *     quantity stays authoritative independently of cost, unknown pricing stays
 *     honestly unknown, and pricing versions are traceable
 *   - a quota-reservation→actual-metered-settlement integration that settles
 *     an admission reservation against real metered usage idempotently + fenced
 *     (no double-settlement, no negative balance, no cross-tenant settlement)
 *   - a job attribution provider that resolves public provider/model
 *     identifiers from job spec (never credentials)
 *
 * Invariants (Phase 2F additions; none weaken Phase 1–2E):
 *   - Aggregates/summaries are DERIVED data, never authoritative. The immutable
 *     usage_events + ledger_entries rows are the source of truth.
 *   - Cost is derived metadata, never a substitute for usage quantity. Unknown
 *     pricing is represented as `null` (honestly unknown), never a guess.
 *   - Quota settlement against metered usage is idempotent + fenced by the
 *     reservation version; a settled reservation is never re-settled; a stale
 *     writer can never settle a newer reservation. It does NOT create a second
 *     quota authority — it derives actuals from the ledger and calls the
 *     existing quota.settle() exactly once.
 *   - Attribution carries NO credentials — only public provider/model strings.
 *   - Cross-tenant reads return empty/404 (no existence leak).
 *   - No secrets in any ledger row, query result, audit event, error, or
 *     response (sanitizeMetadata + redaction).
 */

import type { UsageKind, UsageAggregate } from "@vaulltcore/metering"
import type { UsageEvent, UsageQueryFilter, UsageQueryCursor } from "@vaulltcore/metering"

/** A resolved unit rate for a (provider, model, kind) at a pricing version.
 *  `null` means the rate is honestly UNKNOWN — never a guess. */
export interface CostRate {
  readonly pricingId: string
  readonly version: string
  readonly rateMicro: number
  /** Effective epoch-ms; a future price change never rewrites a historical
   *  attribution (a new version supersedes for new attributions only). */
  readonly effectiveAt: number
}

/** A derived cost attribution for a usage quantity. Cost is DERIVED metadata;
 *  the usage quantity remains authoritative independently of cost. */
export interface CostAttribution {
  readonly rate: CostRate | null
  readonly amountMicro: number | null
  /** Honest when pricing is unavailable — never fabricated. */
  readonly priced: boolean
}

/** A provider-neutral cost catalog: resolve a unit rate for a (provider, model,
 *  kind) at a pricing version. Unknown pricing resolves to `null`. This is a
 *  seam — concrete catalogs read versioned configuration, never scrape provider
 *  websites at runtime. */
export interface CostCatalog {
  /** Resolve the rate for a (provider, model, kind). Returns null when no rate
   *  is known (honestly unknown). `provider`/`model` may be null (unattributed
   *  usage) — the catalog may resolve a kind-only fallback rate or null. */
  resolveRate(provider: string | null, model: string | null, kind: UsageKind): CostRate | null
  /** The active pricing identity (for traceability on persisted attributions). */
  readonly pricingId: string
  readonly version: string
}

/** Input to attribute a single usage event's cost (derived). */
export interface AttributeCostInput {
  readonly provider: string | null
  readonly model: string | null
  readonly kind: UsageKind
  readonly quantity: number
}

/** Result of a bounded usage query page (raw events). */
export interface UsageQueryResult {
  readonly items: readonly UsageEvent[]
  readonly nextCursor: UsageQueryCursor | null
  readonly hasMore: boolean
}

/** A derived usage summary over a filtered scope. Aggregates are DERIVED —
 *  recomputable from the immutable ledger; never authoritative. */
export interface UsageSummary {
  readonly filter: UsageQueryFilter
  readonly aggregate: UsageAggregate
  readonly breakdown: ReadonlyArray<{ kind: string; quantity: number; count: number }>
  readonly totalEvents: number
}

/** Result of settling an admission reservation against actual metered usage.
 *  Idempotent: a reservation already settled returns its recorded outcome
 *  (duplicated=true) without re-settling. */
export interface QuotaSettlementResult {
  readonly reservationId: string
  readonly state: string
  readonly settledTokens: number | null
  readonly settledDurationMs: number | null
  readonly duplicated: boolean
}

export class UsageGovernanceError extends Error {
  constructor(readonly code: string, message: string, readonly status: number = 400) {
    super(message)
    this.name = "UsageGovernanceError"
  }
}
