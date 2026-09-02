/**
 * Vaulltcore Usage Governance (Phase 2F).
 *
 * Durable, provider-neutral B2B metering + usage-accounting governance bridge
 * over the existing immutable metering ledger + billing ledger + quota
 * reservation system. This package does NOT introduce a competing quota
 * authority, a second agent runtime, a second accounting ledger, or a second
 * LLM abstraction. It provides:
 *
 *   - {@link UsageQueryService}: bounded, paginated, filtered aggregation/query
 *     over the immutable usage ledger (derived aggregates, never authoritative).
 *   - {@link VersionedCostCatalog} + {@link attributeCost}: a provider-neutral
 *     cost-attribution seam where usage quantity stays authoritative, unknown
 *     pricing is honestly unknown, and pricing versions are traceable.
 *   - {@link QuotaSettlementService}: settles an admission reservation against
 *     ACTUAL metered usage idempotently + fenced (no double-settlement).
 *   - {@link jobAttributionProvider}: resolves public provider/model
 *     attribution from job spec (never credentials).
 *
 * Dependency direction (enforced, acyclic):
 *   usage-governance → {runner (types), store-sql, metering, billing, quota,
 *                        audit}
 *   control → usage-governance
 * The runner imports NONE of this. The hard seam holds. No second agent runtime,
 * no second quota authority, no provider SDK in core.
 *
 * Invariants that must not regress (Phase 2F additions):
 *   - Aggregates/summaries/cost attributions are DERIVED data, never
 *     authoritative. The immutable usage_events + ledger_entries rows are the
 *     source of truth.
 *   - Cost is derived metadata, never a substitute for usage quantity; unknown
 *     pricing is `null` (honest), never a guess.
 *   - Quota settlement against metered usage is idempotent + fenced; a settled
 *     reservation is never re-settled; a stale writer cannot settle a newer
 *     reservation; a reservation with no linked job is never settled against
 *     fabricated usage.
 *   - Attribution carries NO credentials — only public provider/model strings.
 *   - Cross-tenant reads/settlement return 404/empty (no existence leak).
 *   - No secrets in any ledger row, query result, audit event, error, or
 *     response.
 */

export * from "./contracts"
export { UsageQueryService, type UsageQueryServiceOptions, MAX_AGGREGATION_RANGE_MS } from "./query-service"
export { VersionedCostCatalog, attributeCost, type CostOverride } from "./cost-catalog"
export { QuotaSettlementService, type QuotaSettlementServiceOptions } from "./quota-settlement"
export {
  jobAttributionProvider,
  staticAttribution,
  type JobAttributionProvider,
  type ModelProviderResolver,
  type JobModelLookup,
  StaticModelProviderResolver,
} from "./attribution"
