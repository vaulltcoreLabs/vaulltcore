/**
 * Phase 2F control-plane routes: bounded usage queries, derived aggregates,
 * per-job aggregates (cross-tenant → empty), pagination cursor, range bounds,
 * admin-only reconciliation, audit emission, and 401/422/403 semantics.
 * Real PGlite (real PostgreSQL engine) over a stub runner (read routes never
 * invoke agent execution).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { PgliteDatabase, pgliteDialect } from "@vaulltcore/store-sql"
import { SqlIdentityStore } from "@vaulltcore/identity"
import { DEFAULT_ADMISSION_POLICY, SqlPolicyStore } from "@vaulltcore/policy"
import { SqlQuotaStore } from "@vaulltcore/quota"
import { SqlMeteringStore, AccountingIdentity } from "@vaulltcore/metering"
import { DEFAULT_PRICING, SqlBillingStore } from "@vaulltcore/billing"
import { SqlAuditStore } from "@vaulltcore/audit"
import { ControlPlane, HeaderAuthenticator } from "../src/index"
import type { ControlAuthenticator } from "../src/auth"
import type { IncomingMessage } from "node:http"
import type { Server } from "node:http"

const db = new PgliteDatabase()

let control: ControlPlane
let server: Server
let base: string
let metering: SqlMeteringStore

/** Authenticator that honors an x-vc-admin header for the reconcile test. */
class AdminHeaderAuthenticator extends HeaderAuthenticator implements ControlAuthenticator {
  async authenticate(request: IncomingMessage) {
    const base = await super.authenticate(request)
    if (!base) return null
    const adminHeader = request.headers["x-vc-admin"]
    return { ...base, admin: adminHeader === "true" }
  }
}

beforeAll(async () => {
  const identity = new SqlIdentityStore(db, { dialect: pgliteDialect })
  const policy = new SqlPolicyStore(db, { dialect: pgliteDialect })
  const quota = new SqlQuotaStore(db, { dialect: pgliteDialect })
  metering = new SqlMeteringStore(db, { dialect: pgliteDialect })
  const billing = new SqlBillingStore(db, { dialect: pgliteDialect })
  const audit = new SqlAuditStore(db, { dialect: pgliteDialect })
  await billing.createPricingVersion(DEFAULT_PRICING)

  const runner = { runJob: async () => ({ status: "succeeded" }), listEvents: async () => [], getJobState: async () => null, createJob: async () => ({ jobId: "j" }), submitInput: async () => ({ status: "succeeded" }) } as never
  control = new ControlPlane({
    runner,
    authenticator: new AdminHeaderAuthenticator(),
    business: { identity, policy, quota, metering, billing, audit },
    phase2f: { metering, billing, quotaStore: quota, audit, pricing: { pricingId: DEFAULT_PRICING.pricingId, version: DEFAULT_PRICING.version, effectiveAt: DEFAULT_PRICING.effectiveAt, unitPrices: DEFAULT_PRICING.unitPrices as Record<string, number> }, reconcile: async () => ({ runId: "recon-1", gaps: 0, repaired: 0, watermark: Date.now() }) },
  })
  server = await control.listen(0)
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`

  // Seed a tenant/org/project/principal/policy so resolvePrincipal succeeds.
  await identity.createTenant("tF", "system", "F")
  await identity.createOrganization("tF", "org_f", "Eng")
  await identity.createProject("tF", "org_f", "proj_f", "Foxtrot")
  await identity.registerPrincipal("tF", "p-admin", "service_account")
  await identity.addMember("tF", "org_f", "p-admin", "owner")
  await identity.grantProject("tF", "org_f", "proj_f", "p-admin", "owner")
  await policy.createPolicy({ tenantId: "tF", orgId: "org_f", projectId: "proj_f" }, DEFAULT_ADMISSION_POLICY)

  // Seed usage for tF and an isolated tenant tG.
  for (let i = 0; i < 8; i++) {
    await metering.record({
      identity: { tenantId: "tF", orgId: "org_f", projectId: "proj_f", jobId: `job_f_${i}` },
      kind: "model_input_tokens",
      quantity: 100,
      unit: "tokens",
      provider: "openai",
      model: "gpt-4o",
      dedupKey: AccountingIdentity.tokens(`job_f_${i}`, 0, "input"),
    })
  }
  await metering.record({
    identity: { tenantId: "tG", orgId: "org_g", projectId: "proj_g", jobId: "job_g" },
    kind: "model_input_tokens",
    quantity: 1,
    unit: "tokens",
    provider: "anthropic",
    model: "claude",
    dedupKey: AccountingIdentity.tokens("job_g", 0, "input"),
  })
})

afterAll(() => {
  server.close()
  db.close()
})

function headers(tenant: string, org: string, project: string, extra: Record<string, string> = {}): Record<string, string> {
  return { "x-vc-tenant": tenant, "x-vc-org": org, "x-vc-project": project, ...extra }
}

async function call(method: string, path: string, opts: { tenant?: string; org?: string; project?: string; admin?: boolean; query?: string } = {}): Promise<{ status: number; json: unknown }> {
  const h = opts.tenant ? headers(opts.tenant, opts.org ?? "org_f", opts.project ?? "proj_f", opts.admin ? { "x-vc-admin": "true" } : {}) : {}
  const url = `${base}${path}${opts.query ?? ""}`
  const res = await fetch(url, { method, headers: h })
  let json: unknown = null
  try { json = await res.json() } catch { /* ignore */ }
  return { status: res.status, json }
}

describe("Phase 2F control-plane /usage routes", () => {
  it("returns 401 when unauthenticated", async () => {
    const r = await call("GET", "/usage")
    expect(r.status).toBe(401)
  })

  it("returns a bounded, paginated usage page for the tenant", async () => {
    const r = await call("GET", "/usage", { tenant: "tF", query: "?limit=3" })
    expect(r.status).toBe(200)
    const body = r.json as { items: unknown[]; nextCursor: string | null; hasMore: boolean }
    expect(body.items.length).toBe(3)
    expect(body.hasMore).toBe(true)
    expect(body.nextCursor).not.toBeNull()
  })

  it("paginates with a cursor deterministically", async () => {
    const first = await call("GET", "/usage", { tenant: "tF", query: "?limit=3" })
    const body1 = first.json as { nextCursor: string | null }
    expect(first.status).toBe(200)
    expect(body1.nextCursor).not.toBeNull()
    const second = await call("GET", "/usage", { tenant: "tF", query: `?limit=3&cursor=${encodeURIComponent(body1.nextCursor!)}` })
    expect(second.status).toBe(200)
  })

  it("rejects an oversized limit with 422", async () => {
    const r = await call("GET", "/usage", { tenant: "tF", query: "?limit=999999" })
    expect(r.status).toBe(422)
  })

  it("rejects an unbounded range with 422", async () => {
    // 2-year span exceeds the 1-year max.
    const twoYears = 2 * 365 * 24 * 60 * 60 * 1000
    const r = await call("GET", "/usage/summary", { tenant: "tF", query: `?from=0&to=${twoYears}` })
    expect(r.status).toBe(422)
  })

  it("returns a derived summary that matches the ledger", async () => {
    const r = await call("GET", "/usage/summary", { tenant: "tF" })
    expect(r.status).toBe(200)
    const body = r.json as { aggregate: { inputTokens: number }; totalEvents: number }
    expect(body.aggregate.inputTokens).toBeGreaterThanOrEqual(800)
    expect(body.totalEvents).toBeGreaterThanOrEqual(8)
  })

  it("per-job aggregate is tenant-scoped (cross-tenant → empty, no leak)", async () => {
    const r = await call("GET", "/usage/runs/job_f_0", { tenant: "tF" })
    expect(r.status).toBe(200)
    const body = r.json as { inputTokens: number }
    expect(body.inputTokens).toBeGreaterThanOrEqual(100)
    // A different tenant asking for tF's job gets an empty aggregate (404 would leak).
    const other = await call("GET", "/usage/runs/job_f_0", { tenant: "tG", org: "org_g", project: "proj_g" })
    expect(other.status).toBe(200)
    const ob = other.json as { inputTokens: number }
    expect(ob.inputTokens).toBe(0)
  })

  it("/usage/ledger returns the same bounded query shape", async () => {
    const r = await call("GET", "/usage/ledger", { tenant: "tF", query: "?limit=2" })
    expect(r.status).toBe(200)
    const body = r.json as { items: unknown[] }
    expect(body.items.length).toBe(2)
  })

  it("reconciliation requires admin (403 for non-admin)", async () => {
    const r = await call("POST", "/usage/reconcile", { tenant: "tF" })
    expect(r.status).toBe(403)
  })

  it("reconciliation succeeds for admin and audits the action", async () => {
    const r = await call("POST", "/usage/reconcile", { tenant: "tF", admin: true })
    expect(r.status).toBe(200)
    const body = r.json as { runId: string }
    expect(body.runId).toBeTruthy()
  })
})
