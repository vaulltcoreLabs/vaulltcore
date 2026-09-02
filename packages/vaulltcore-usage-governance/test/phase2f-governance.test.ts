/**
 * Phase 2F usage-governance tests: cost attribution (honest unknown pricing,
 * historical pricing immutable), bounded aggregation, and quota reservation →
 * actual-metered-settlement (idempotent, fenced, no cross-tenant). Real PGlite.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { PgliteDatabase, pgliteDialect } from "@vaulltcore/store-sql"
import { SqlMeteringStore, AccountingIdentity } from "@vaulltcore/metering"
import { DEFAULT_PRICING, type PricingVersion } from "@vaulltcore/billing"
import { SqlQuotaStore } from "@vaulltcore/quota"
import {
  UsageQueryService,
  QuotaSettlementService,
  VersionedCostCatalog,
  attributeCost,
  jobAttributionProvider,
  staticAttribution,
  StaticModelProviderResolver,
  MAX_AGGREGATION_RANGE_MS,
  UsageGovernanceError,
  type CostOverride,
} from "@vaulltcore/usage-governance"

const db = new PgliteDatabase()
let metering: SqlMeteringStore
let quota: SqlQuotaStore

beforeAll(() => {
  metering = new SqlMeteringStore(db, { dialect: pgliteDialect })
  quota = new SqlQuotaStore(db, { dialect: pgliteDialect })
})
afterAll(() => db.close())

describe("Phase 2F cost attribution", () => {
  it("attributes cost from a versioned catalog without credentials", () => {
    const catalog = new VersionedCostCatalog(DEFAULT_PRICING, [])
    const cost = attributeCost(catalog, { provider: "openai", model: "gpt-4o", kind: "model_input_tokens", quantity: 100 })
    expect(cost.priced).toBe(true)
    expect(cost.amountMicro).toBe(100 * 2)
    expect(cost.rate?.version).toBe("1")
  })

  it("uses provider/model override when present", () => {
    const overrides: CostOverride[] = [{ provider: "anthropic", model: "claude", kind: "model_input_tokens", rateMicro: 3 }]
    const catalog = new VersionedCostCatalog(DEFAULT_PRICING, overrides)
    const cost = attributeCost(catalog, { provider: "anthropic", model: "claude", kind: "model_input_tokens", quantity: 10 })
    expect(cost.amountMicro).toBe(30)
  })

  it("represents unknown pricing honestly as null (no guess)", () => {
    const sparse: PricingVersion = { ...DEFAULT_PRICING, unitPrices: { ...DEFAULT_PRICING.unitPrices, model_reasoning_tokens: 0 }, pricingId: "sparse", version: "2" }
    // remove reasoning price by setting a catalog with no entry for a custom kind
    const catalog = new VersionedCostCatalog({ ...sparse, unitPrices: { ...sparse.unitPrices } }, [])
    // Force unknown: a kind with no rate. We simulate by overriding to undefined via a minimal catalog.
    const minimal = new VersionedCostCatalog({ ...DEFAULT_PRICING, unitPrices: { ...DEFAULT_PRICING.unitPrices, snapshot_storage: 0 } } as never, [])
    void catalog
    void minimal
    // The cleanest honest-unknown check: a brand-new catalog with overrides only
    // and the default pricing missing a kind the catalog does not carry → null.
    const only = new VersionedCostCatalog({ ...DEFAULT_PRICING, unitPrices: {} as never } as never, [])
    const cost = attributeCost(only, { provider: null, model: null, kind: "model_input_tokens", quantity: 5 })
    expect(cost.priced).toBe(false)
    expect(cost.amountMicro).toBeNull()
  })

  it("changing future pricing does not rewrite historical attribution identity", () => {
    const v1 = new VersionedCostCatalog(DEFAULT_PRICING, [])
    const v2 = new VersionedCostCatalog({ ...DEFAULT_PRICING, version: "2", unitPrices: { ...DEFAULT_PRICING.unitPrices, model_input_tokens: 99 } }, [])
    const hist = attributeCost(v1, { provider: "openai", model: "gpt-4o", kind: "model_input_tokens", quantity: 10 })
    const future = attributeCost(v2, { provider: "openai", model: "gpt-4o", kind: "model_input_tokens", quantity: 10 })
    // Historical attribution keeps version "1"; future uses "2" — same quantity,
    // different rate identity. Historical is never rewritten.
    expect(hist.rate?.version).toBe("1")
    expect(future.rate?.version).toBe("2")
    expect(hist.amountMicro).toBe(20)
    expect(future.amountMicro).toBe(990)
  })
})

describe("Phase 2F bounded aggregation/query", () => {
  beforeAll(async () => {
    for (let i = 0; i < 5; i++) {
      await metering.record({
        identity: { tenantId: "tg", orgId: "og", projectId: "pg", jobId: `j${i}` },
        kind: "model_input_tokens",
        quantity: 100,
        unit: "tokens",
        provider: "openai",
        model: "gpt-4o",
        dedupKey: `gov-${i}`,
      })
    }
  })

  it("summary is derived and matches ledger", () => {
    const svc = new UsageQueryService(metering)
    const s = svc.summary({ tenantId: "tg" })
    expect(s.totalEvents).toBeGreaterThan(0)
    expect(s.aggregate.inputTokens).toBeGreaterThanOrEqual(500)
  })

  it("rejects an unbounded range exceeding the maximum span", () => {
    const svc = new UsageQueryService(metering)
    expect(() => svc.summary({ tenantId: "tg", from: 0, to: MAX_AGGREGATION_RANGE_MS + 1 })).toThrow(UsageGovernanceError)
  })

  it("rejects negative from", () => {
    const svc = new UsageQueryService(metering)
    expect(() => svc.summary({ tenantId: "tg", from: -1 })).toThrow(UsageGovernanceError)
  })

  it("queryAll is capped by maxPages", () => {
    const svc = new UsageQueryService(metering, { defaultLimit: 2 })
    const all = svc.queryAll({ tenantId: "tg" }, 3)
    // 3 pages × up to 2 = up to 6 items; capped so it cannot run forever.
    expect(all.length).toBeLessThanOrEqual(6)
  })
})

describe("Phase 2F quota settlement against actual usage", () => {
  it("settles a reservation against metered usage exactly once", async () => {
    await metering.record({
      identity: { tenantId: "ts", orgId: "os", projectId: "ps", jobId: "jobset" },
      kind: "model_tokens",
      quantity: 42,
      unit: "tokens",
      provider: "openai",
      model: "gpt-4o",
      dedupKey: AccountingIdentity.tokens("jobset", 0, "tokens"),
    })
    const r = await quota.reserve({ tenantId: "ts", orgId: "os", projectId: "ps" }, "rk_settle_1", "jobset", { maxConcurrentJobs: 10, jobsPerPeriod: 100, periodMs: 3600000, maxTokens: 100000, maxDurationMs: 3600000 })
    const settle = new QuotaSettlementService({ metering, quota })
    const first = await settle.settleAgainstActualUsage("ts", r.reservationId)
    expect(first.duplicated).toBe(false)
    expect(first.settledTokens).toBe(42)
    // Retry → idempotent duplicate, no double-settlement.
    const second = await settle.settleAgainstActualUsage("ts", r.reservationId)
    expect(second.duplicated).toBe(true)
    expect(second.settledTokens).toBe(42)
  })

  it("rejects cross-tenant settlement (no existence leak)", async () => {
    const r = await quota.reserve({ tenantId: "ts", orgId: "os", projectId: "ps" }, "rk_settle_2", "jobx", { maxConcurrentJobs: 10, jobsPerPeriod: 100, periodMs: 3600000, maxTokens: 100000, maxDurationMs: 3600000 })
    const settle = new QuotaSettlementService({ metering, quota })
    await expect(settle.settleAgainstActualUsage("OTHER_TENANT", r.reservationId)).rejects.toThrow(UsageGovernanceError)
  })

  it("rejects settlement of a reservation with no linked job (no fabricated usage)", async () => {
    const r = await quota.reserve({ tenantId: "ts", orgId: "os", projectId: "ps" }, "rk_settle_3", null, { maxConcurrentJobs: 10, jobsPerPeriod: 100, periodMs: 3600000, maxTokens: 100000, maxDurationMs: 3600000 })
    const settle = new QuotaSettlementService({ metering, quota })
    await expect(settle.settleAgainstActualUsage("ts", r.reservationId)).rejects.toThrow(UsageGovernanceError)
  })
})

describe("Phase 2F job attribution provider", () => {
  it("resolves public provider/model from a job lookup (no credentials)", () => {
    const lookup = { resolveModel: (jobId: string) => (jobId === "jobset" ? "gpt-4o" : null) }
    const resolver = new StaticModelProviderResolver([{ model: "gpt-4o", provider: "openai" }])
    const provider = jobAttributionProvider(lookup, resolver)
    const attr = provider({ jobId: "jobset", tenantId: "ts", orgId: "os", projectId: "ps" })
    expect(attr?.provider).toBe("openai")
    expect(attr?.model).toBe("gpt-4o")
  })

  it("returns null when the job/model is unknown (honest, never fabricated)", () => {
    const lookup = { resolveModel: () => null }
    const resolver = new StaticModelProviderResolver()
    const provider = jobAttributionProvider(lookup, resolver)
    expect(provider({ jobId: "unknown", tenantId: "ts", orgId: "os", projectId: "ps" })).toBeNull()
  })

  it("staticAttribution returns the same public identifiers for every job", () => {
    const provider = staticAttribution("anthropic", "claude")
    const a = provider({ jobId: "j1", tenantId: "t", orgId: "o", projectId: "p" })
    const b = provider({ jobId: "j2", tenantId: "t", orgId: "o", projectId: "p" })
    expect(a).toEqual({ provider: "anthropic", model: "claude" })
    expect(b).toEqual(a)
  })
})
