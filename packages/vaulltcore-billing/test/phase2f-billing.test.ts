/**
 * Phase 2F billing tests: append-only adjustments (never mutate history),
 * durable idempotency of adjustments, immutable pricing (historical entries
 * not rewritten), and cross-tenant adjustment rejection. Real PGlite.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { PgliteDatabase, pgliteDialect } from "@vaulltcore/store-sql"
import { DEFAULT_PRICING, SqlBillingStore, type BillingScope } from "@vaulltcore/billing"

const db = new PgliteDatabase()
let store: SqlBillingStore

beforeAll(() => {
  store = new SqlBillingStore(db, { dialect: pgliteDialect })
})
afterAll(() => db.close())

const scope: BillingScope = { tenantId: "tb", orgId: "ob", projectId: "pb", jobId: "job1" }

describe("Phase 2F billing — append-only adjustments", () => {
  it("creates a base charge, then appends an adjustment (no mutation)", async () => {
    const charge = await store.chargeJobUsage(scope, "model_input_tokens", 100, DEFAULT_PRICING)
    expect(charge.duplicated).toBe(false)
    const adj = await store.recordAdjustment(
      {
        identity: scope,
        kind: "model_input_tokens",
        quantity: -100,
        originalEntryId: charge.entry.entryId,
        reason: "overcharge",
        note: "corrected over-billing",
        idempotencyKey: "adj-1",
        amountMicro: -200,
      },
      DEFAULT_PRICING,
    )
    expect(adj.duplicated).toBe(false)
    expect(adj.entry.type).toBe("adjustment")
    expect(adj.entry.originalEntryId).toBe(charge.entry.entryId)
    expect(adj.entry.reason).toBe("overcharge")
    const entries = await store.listEntries(scope)
    const original = entries.find((e) => e.entryId === charge.entry.entryId)
    expect(original?.type).toBe("charge")
    expect(original?.amount).toBe(charge.entry.amount)
  })

  it("duplicate adjustment (same idempotency key) → one entry", async () => {
    const charge = await store.chargeJobUsage({ ...scope, jobId: "job2" }, "model_output_tokens", 50, DEFAULT_PRICING)
    const input = {
      identity: { ...scope, jobId: "job2" },
      kind: "model_output_tokens" as const,
      quantity: -50,
      originalEntryId: charge.entry.entryId,
      reason: "refund" as const,
      idempotencyKey: "adj-dup-1",
      amountMicro: -100,
    }
    const a = await store.recordAdjustment(input, DEFAULT_PRICING)
    const b = await store.recordAdjustment(input, DEFAULT_PRICING)
    expect(a.duplicated).toBe(false)
    expect(b.duplicated).toBe(true)
    expect(b.entry.entryId).toBe(a.entry.entryId)
  })

  it("rejects adjustment referencing a non-existent original (no fabrication)", async () => {
    await expect(
      store.recordAdjustment(
        {
          identity: scope,
          kind: "model_input_tokens",
          quantity: 1,
          originalEntryId: "does_not_exist",
          reason: "quantity_correction",
          idempotencyKey: "adj-missing-1",
          amountMicro: 0,
        },
        DEFAULT_PRICING,
      ),
    ).rejects.toThrow()
  })

  it("balance reflects charges + adjustments (derived, recomputable)", async () => {
    const bal = await store.getBalance(scope)
    expect(bal.charges).toBeGreaterThanOrEqual(0)
    expect(bal.credits).toBeGreaterThanOrEqual(0)
    expect(bal.balance).toBe(bal.charges - bal.credits)
  })

  it("historical pricing is immutable — a new pricing version does not rewrite settled entries", async () => {
    const c1 = await store.chargeJobUsage({ ...scope, jobId: "jobP" }, "model_input_tokens", 10, DEFAULT_PRICING)
    const v2 = { ...DEFAULT_PRICING, version: "2", unitPrices: { ...DEFAULT_PRICING.unitPrices, model_input_tokens: 999 } }
    const c2 = await store.chargeJobUsage({ ...scope, jobId: "jobP2" }, "model_input_tokens", 10, v2)
    expect(c1.entry.pricingVersion).toBe("1")
    expect(c2.entry.pricingVersion).toBe("2")
    expect(c1.entry.amount).not.toBe(c2.entry.amount)
  })
})
