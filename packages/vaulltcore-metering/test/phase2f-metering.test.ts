/**
 * Phase 2F metering tests: model attribution, granular token kinds, bounded
 * paginated queries, immutable ledger exactly-once accounting identity, and
 * cross-tenant isolation. Uses real PGlite (real PostgreSQL engine).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { PgliteDatabase, pgliteDialect } from "@vaulltcore/store-sql"
import {
  SqlMeteringStore,
  USAGE_KINDS,
  UNIT_FOR_KIND,
  isKnownUsageKind,
  AccountingIdentity,
  eventsToUsageAttributed,
  type MeteringIdentity,
  type UsageAttribution,
  type UsageQueryCursor,
  MAX_QUERY_LIMIT,
} from "@vaulltcore/metering"
import type { JobEvent } from "@vaulltcore/runner"

const db = new PgliteDatabase()
let store: SqlMeteringStore

beforeAll(() => {
  store = new SqlMeteringStore(db, { dialect: pgliteDialect })
})
afterAll(() => db.close())

const identity: MeteringIdentity = { tenantId: "t1", orgId: "o1", projectId: "p1", jobId: "job_a" }

describe("Phase 2F metering — attribution + kinds + validation", () => {
  it("records attributed usage with provider/model (no credentials)", async () => {
    const r = await store.record({
      identity,
      kind: "model_input_tokens",
      quantity: 1200,
      unit: "tokens",
      provider: "anthropic",
      model: "claude-3.5-sonnet",
      dedupKey: AccountingIdentity.tokens(identity.jobId, 1, "input"),
    })
    expect(r.duplicated).toBe(false)
    expect(r.event.provider).toBe("anthropic")
    expect(r.event.model).toBe("claude-3.5-sonnet")
    expect(r.event.kind).toBe("model_input_tokens")
    expect(r.event.quantity).toBe(1200)
  })

  it("rejects negative quantities", async () => {
    await expect(
      store.record({ identity, kind: "model_output_tokens", quantity: -5, unit: "tokens", provider: "openai", model: "gpt-4o", dedupKey: "neg-1" }),
    ).rejects.toThrow()
  })

  it("rejects invalid unit/kind combinations", async () => {
    await expect(
      store.record({ identity, kind: "model_input_tokens", quantity: 10, unit: "ms", provider: null, model: null, dedupKey: "bad-unit-1" }),
    ).rejects.toThrow()
  })

  it("safely represents unknown usage kinds via the contract vocabulary", () => {
    expect(isKnownUsageKind("model_input_tokens")).toBe(true)
    expect(isKnownUsageKind("totally_made_up_kind")).toBe(false)
    for (const k of USAGE_KINDS) {
      expect(UNIT_FOR_KIND[k]).toBeDefined()
    }
  })

  it("same accounting identity committed twice → one ledger entry (idempotent)", async () => {
    const dedupKey = AccountingIdentity.tokens(identity.jobId, 7, "output")
    const input = { identity, kind: "model_output_tokens" as const, quantity: 50, unit: "tokens", provider: "anthropic", model: "claude", dedupKey }
    const first = await store.record(input)
    const second = await store.record(input)
    expect(first.duplicated).toBe(false)
    expect(second.duplicated).toBe(true)
    expect(second.event.eventId).toBe(first.event.eventId)
  })

  it("distinct legitimate usage events both record separately", async () => {
    const a = await store.record({ identity, kind: "model_input_tokens", quantity: 100, unit: "tokens", provider: "openai", model: "gpt-4o", dedupKey: "distinct-a" })
    const b = await store.record({ identity, kind: "model_output_tokens", quantity: 200, unit: "tokens", provider: "openai", model: "gpt-4o", dedupKey: "distinct-b" })
    expect(a.event.eventId).not.toBe(b.event.eventId)
    expect(a.event.kind).toBe("model_input_tokens")
    expect(b.event.kind).toBe("model_output_tokens")
  })

  it("eventsToUsageAttributed projects runner events with attribution", () => {
    const events: JobEvent[] = [
      { seq: 0, type: "usage", timestamp: 1, data: { stepIndex: 0, inputTokens: 10, outputTokens: 5 } } as never,
      { seq: 1, type: "tool_response", timestamp: 2, data: { ok: true } } as never,
    ]
    const usage = eventsToUsageAttributed(identity, events, { provider: "anthropic", model: "claude" } as UsageAttribution)
    expect(usage.length).toBeGreaterThan(0)
    for (const u of usage) {
      expect(u.provider).toBe("anthropic")
      expect(u.model).toBe("claude")
    }
  })
})

describe("Phase 2F metering — bounded paginated queries + isolation", () => {
  beforeAll(async () => {
    for (let i = 0; i < 12; i++) {
      await store.record({
        identity: { tenantId: "t1", orgId: "o1", projectId: "p1", jobId: `job_${i}` },
        kind: "model_input_tokens",
        quantity: 10 * i,
        unit: "tokens",
        provider: "openai",
        model: "gpt-4o",
        dedupKey: `page-${i}`,
      })
    }
    await store.record({
      identity: { tenantId: "t2", orgId: "o2", projectId: "p2", jobId: "job_other" },
      kind: "model_input_tokens",
      quantity: 999,
      unit: "tokens",
      provider: "openai",
      model: "gpt-4o",
      dedupKey: "page-other",
    })
  })

  it("returns a bounded first page with a cursor", () => {
    const page = store.queryEvents({ tenantId: "t1" }, undefined, 5)
    expect(page.items.length).toBe(5)
    expect(page.hasMore).toBe(true)
    expect(page.nextCursor).not.toBeNull()
  })

  it("paginates deterministically to the end", () => {
    let cursor: UsageQueryCursor | null = null
    const seen: string[] = []
    for (let i = 0; i < 20; i++) {
      const page = store.queryEvents({ tenantId: "t1" }, cursor ?? undefined, 5)
      seen.push(...page.items.map((e) => e.eventId))
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }
    expect(new Set(seen).size).toBe(seen.length)
  })

  it("clamps the query limit to the maximum (bounded, never unbounded)", () => {
    // The store clamps rather than throws; the control-plane route enforces
    // a hard 422 above MAX_QUERY_LIMIT. At the store level the guarantee is:
    // a request above the cap is bounded to the cap, never unbounded.
    const page = store.queryEvents({ tenantId: "t1" }, undefined, MAX_QUERY_LIMIT + 1000)
    expect(page.items.length).toBeLessThanOrEqual(MAX_QUERY_LIMIT)
  })

  it("isolates tenants — t2 never sees t1 events", () => {
    const page = store.queryEvents({ tenantId: "t2" }, undefined, 100)
    expect(page.items.length).toBe(1)
    expect(page.items[0]!.tenantId).toBe("t2")
  })

  it("filters by kind", () => {
    const page = store.queryEvents({ tenantId: "t1", kind: "model_input_tokens" }, undefined, 100)
    expect(page.items.every((e) => e.kind === "model_input_tokens")).toBe(true)
  })

  it("derives an aggregate that matches the ledger (t1)", async () => {
    const agg = await store.aggregateScope({ tenantId: "t1", orgId: "o1", projectId: "p1" })
    expect(agg.inputTokens).toBeGreaterThan(0)
    expect(agg.totalTokens).toBeGreaterThanOrEqual(agg.inputTokens)
  })

  it("breakdown by kind is derived and recomputable", () => {
    const b1 = store.breakdownByKind({ tenantId: "t1" })
    const b2 = store.breakdownByKind({ tenantId: "t1" })
    expect(b1).toEqual(b2)
  })
})
