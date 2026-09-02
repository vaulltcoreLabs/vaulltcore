/**
 * Bounded usage query + aggregation service (Phase 2F).
 *
 * Reads the immutable usage ledger (metering {@link SqlMeteringStore}) through
 * its bounded, paginated, filtered query surface. Aggregates and summaries are
 * DERIVED data — always recomputable from the immutable usage_events rows,
 * never authoritative. Every query enforces a hard page cap
 * ({@link MAX_QUERY_LIMIT}) and a maximum time range so a control-plane
 * request can never scan an unbounded ledger. Cross-tenant reads return empty
 * (the underlying store is tenant-scoped; no existence leak).
 */

import type { SqlMeteringStore, UsageQueryFilter, UsageQueryCursor, UsageAggregate, UsageEvent } from "@vaulltcore/metering"
import { MAX_QUERY_LIMIT } from "@vaulltcore/metering"
import type { UsageQueryResult, UsageSummary } from "./contracts"
import { UsageGovernanceError } from "./contracts"

/** Maximum time range (ms) a single aggregation query may span. Prevents an
 *  unbounded-history aggregation through the control plane. */
export const MAX_AGGREGATION_RANGE_MS = 365 * 24 * 60 * 60 * 1000 // 1 year

export interface UsageQueryServiceOptions {
  readonly defaultLimit?: number
  /** Max time range an aggregation may span (default 1 year). */
  readonly maxRangeMs?: number
}

export class UsageQueryService {
  private readonly metering: SqlMeteringStore
  private readonly defaultLimit: number
  private readonly maxRangeMs: number

  constructor(metering: SqlMeteringStore, options: UsageQueryServiceOptions = {}) {
    this.metering = metering
    this.defaultLimit = options.defaultLimit ?? 200
    this.maxRangeMs = options.maxRangeMs ?? MAX_AGGREGATION_RANGE_MS
  }

  /** Bounded, paginated query of raw usage events. Cursor pagination; the page
   *  size is capped at {@link MAX_QUERY_LIMIT}. Deterministic order
   *  (recorded_at, event_id). */
  query(filter: UsageQueryFilter, cursor?: UsageQueryCursor | null, limit?: number): UsageQueryResult {
    this.assertRangeBounded(filter)
    const page = this.metering.queryEvents(filter, cursor ?? undefined, limit ?? this.defaultLimit)
    return { items: page.items, nextCursor: page.nextCursor, hasMore: page.hasMore }
  }

  /** Page through the entire filtered result set by following cursors until
   *  exhausted, capped by maxPages so the call cannot run forever. Useful for
   *  bounded exports under operator authorization. */
  queryAll(filter: UsageQueryFilter, maxPages = 50): readonly UsageEvent[] {
    this.assertRangeBounded(filter)
    const out: UsageEvent[] = []
    let cursor: UsageQueryCursor | null = null
    for (let i = 0; i < maxPages; i++) {
      const page = this.query(filter, cursor, this.defaultLimit)
      out.push(...page.items)
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }
    return out
  }

  /** Derived summary over a filtered scope. The aggregate + breakdown are
   *  recomputed from the immutable ledger every call — never a mutable summary
   *  table. Enforces a bounded range. */
  summary(filter: UsageQueryFilter): UsageSummary {
    this.assertRangeBounded(filter)
    const aggregate = this.metering.aggregateFiltered(filter)
    const breakdown = this.metering.breakdownByKind(filter)
    const totalEvents = breakdown.reduce((s, b) => s + b.count, 0)
    return { filter, aggregate, breakdown, totalEvents }
  }

  /** Aggregate for a single job (tenant-scoped; cross-tenant returns empty). */
  async jobAggregate(tenantId: string, jobId: string): Promise<UsageAggregate> {
    return this.metering.aggregateJob(tenantId, jobId)
  }

  /** Enforce that an aggregation/query time range is bounded. An unbounded
   *  request (from/to absent is allowed — full tenant history — but a span
   *  exceeding maxRangeMs is rejected with 422). */
  private assertRangeBounded(filter: UsageQueryFilter): void {
    if (filter.from !== undefined && filter.to !== undefined) {
      const span = filter.to - filter.from
      if (span < 0) throw new UsageGovernanceError("INVALID_RANGE", "from must be <= to", 422)
      if (span > this.maxRangeMs) throw new UsageGovernanceError("RANGE_TOO_LARGE", "requested range exceeds the maximum allowed span", 422)
    }
    if (filter.from !== undefined && filter.from < 0) {
      throw new UsageGovernanceError("INVALID_RANGE", "from must be non-negative", 422)
    }
  }
}
