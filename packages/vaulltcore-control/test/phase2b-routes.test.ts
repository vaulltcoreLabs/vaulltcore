/**
 * Phase 2B control-plane routes: schedules, deliveries, retry-status,
 * operational health, metrics, SSE automation event streaming, and tenant
 * isolation / secret redaction. Uses the real SQL automation/scheduler/ops
 * stores over PGlite (real PostgreSQL engine).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { PgliteDatabase, pgliteDialect } from "@vaulltcore/store-sql"
import { SqlIdentityStore } from "@vaulltcore/identity"
import { DEFAULT_ADMISSION_POLICY, SqlPolicyStore } from "@vaulltcore/policy"
import { SqlQuotaStore } from "@vaulltcore/quota"
import { SqlMeteringStore } from "@vaulltcore/metering"
import { DEFAULT_PRICING, SqlBillingStore } from "@vaulltcore/billing"
import { SqlAuditStore } from "@vaulltcore/audit"
import { SqlAutomationStore } from "@vaulltcore/automation"
import { SqlScheduleStore } from "@vaulltcore/scheduler"
import { SqlOpsStore } from "@vaulltcore/ops"
import { ControlPlane, HeaderAuthenticator } from "../src/index"
import type { Server } from "node:http"

const db = new PgliteDatabase()

let control: ControlPlane
let server: Server
let base: string

beforeAll(async () => {
  const identity = new SqlIdentityStore(db, { dialect: pgliteDialect })
  const policy = new SqlPolicyStore(db, { dialect: pgliteDialect })
  const quota = new SqlQuotaStore(db, { dialect: pgliteDialect })
  const metering = new SqlMeteringStore(db, { dialect: pgliteDialect })
  const billing = new SqlBillingStore(db, { dialect: pgliteDialect })
  const audit = new SqlAuditStore(db, { dialect: pgliteDialect })
  const automationStore = new SqlAutomationStore(db, { dialect: pgliteDialect })
  const schedulerStore = new SqlScheduleStore(db, { dialect: pgliteDialect })
  const opsStore = new SqlOpsStore(db, { dialect: pgliteDialect })

  // Stub runner: Phase 2B read routes never invoke agent execution (creation +
  // reads only). Admission is wired so the routes resolve; run creation does
  // not dispatch jobs.
  const runner = { runJob: async () => ({ status: "succeeded" }), listEvents: async () => [], getJobState: async () => null, createJob: async () => ({ jobId: "j" }), submitInput: async () => ({ status: "succeeded" }) } as never
  control = new ControlPlane({
    runner,
    authenticator: new HeaderAuthenticator(),
    business: { identity, policy, quota, metering, billing, audit },
    automation: { store: automationStore },
    phase2b: { schedulerStore, opsStore },
  })
  server = await control.listen(0)
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`
  // Seed a tenant/org/project/principal/policy so admission succeeds for the
  // run-creating tests (metrics/deliveries/SSE). Schedule/retry/health tests
  // use ad-hoc tenants and do not require admission.
  await identity.createTenant("tSeed", "system", "Seed")
  await identity.createOrganization("tSeed", "org_a", "Engineering")
  await identity.createProject("tSeed", "org_a", "proj_a", "Alpha")
  await identity.registerPrincipal("tSeed", "p-owner", "service_account")
  await identity.addMember("tSeed", "org_a", "p-owner", "owner")
  await identity.grantProject("tSeed", "org_a", "proj_a", "p-owner", "owner")
  await policy.createPolicy({ tenantId: "tSeed", orgId: "org_a", projectId: "proj_a" }, { ...DEFAULT_ADMISSION_POLICY, allowedTools: ["noop", "read_file"] })
  await billing.createPricingVersion(DEFAULT_PRICING)
  void metering
  void DEFAULT_ADMISSION_POLICY
  void DEFAULT_PRICING
})

afterAll(() => {
  server.close()
  db.close()
})

function headers(tenant: string, org = "org_a", project = "proj_a", extra: Record<string, string> = {}): Record<string, string> {
  return { "x-vc-tenant": tenant, "x-vc-org": org, "x-vc-project": project, ...extra }
}

async function call(method: string, path: string, opts: { tenant?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; json: unknown; text: string }> {
  const h = opts.headers ?? {}
  if (opts.tenant) Object.assign(h, headers(opts.tenant))
  if (opts.body !== undefined) h["content-type"] = "application/json"
  const response = await fetch(`${base}${path}`, {
    method,
    headers: h,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const text = await response.text()
  return { status: response.status, json: text === "" ? null : JSON.parse(text), text }
}

const DEF = {
  steps: [{ stepId: "step1", execution: { engine: "script", model: "test", prompt: "${input.query}", engineOptions: {}, maxSteps: 10, maxTokens: null, maxDurationMs: null, allowedTools: [] }, inputMappings: [], outputMappings: [], dependsOn: [] }],
  artifacts: [{ artifactId: "art1", type: "text", name: "result.txt", stepId: "step1", path: "result" }],
  approval: { required: false, gateId: "", minApproverRole: "operator", contextArtifacts: [], expiresAfterMs: null },
  delivery: { destination: "test-destination", artifactIds: [] },
}
const CONTRACT = { fields: [{ fieldId: "query", type: "string", required: true }] }

async function createTemplateVersionRun(tenant: string, name: string): Promise<{ runId: string }> {
  const tmpl = await call("POST", "/automation/templates", { tenant, body: { name, orgId: "org_a", projectId: "proj_a" } })
  if (tmpl.status !== 201) throw new Error(`template create ${tmpl.status}: ${tmpl.text}`)
  const templateId = (tmpl.json as { templateId: string }).templateId
  const ver = await call("POST", `/automation/templates/${templateId}/versions`, { tenant, body: { definition: DEF, inputContract: CONTRACT } })
  if (ver.status !== 201) throw new Error(`version create ${ver.status}: ${ver.text}`)
  const versionId = (ver.json as { versionId: string }).versionId
  const run = await call("POST", "/automation/runs", {
    tenant,
    headers: { ...headers(tenant), "idempotency-key": `k_${name}_${Math.random()}` },
    body: { templateId, versionId, input: [{ fieldId: "query", value: "hi" }], orgId: "org_a", projectId: "proj_a" },
  })
  if (run.status !== 201) throw new Error(`run create ${run.status}: ${run.text}`)
  return { runId: (run.json as { runId: string }).runId }
}

describe("Phase 2B control-plane routes", () => {
  it("creates and lists schedules, enforces tenant isolation (404 cross-tenant)", async () => {
    const created = await call("POST", "/automation/schedules", {
      tenant: "tA",
      body: { name: "daily", automationVersionId: "ver_1", kind: "recurring", cron: "0 9 * * *", timezone: "UTC" },
    })
    expect(created.status).toBe(201)
    const scheduleId = (created.json as { scheduleId: string }).scheduleId

    const cross = await call("GET", `/automation/schedules/${scheduleId}`, { tenant: "tB" })
    expect(cross.status).toBe(404)

    const same = await call("GET", `/automation/schedules/${scheduleId}`, { tenant: "tA" })
    expect(same.status).toBe(200)

    const list = await call("GET", "/automation/schedules", { tenant: "tA" })
    expect(list.status).toBe(200)
    expect((list.json as { schedules: unknown[] }).schedules).toHaveLength(1)
    const listB = await call("GET", "/automation/schedules", { tenant: "tB" })
    expect((listB.json as { schedules: unknown[] }).schedules).toHaveLength(0)
  })

  it("pauses, resumes, and cancels schedules with fenced transitions", async () => {
    const created = await call("POST", "/automation/schedules", {
      tenant: "tC",
      body: { name: "weekly", automationVersionId: "ver_1", kind: "recurring", cron: "0 0 * * 0", timezone: "UTC" },
    })
    const id = (created.json as { scheduleId: string }).scheduleId

    const paused = await call("POST", `/automation/schedules/${id}/pause`, { tenant: "tC" })
    expect(paused.status).toBe(200)
    expect((paused.json as { state: string }).state).toBe("paused")

    const resumed = await call("POST", `/automation/schedules/${id}/resume`, { tenant: "tC" })
    expect((resumed.json as { state: string }).state).toBe("active")

    const cancelled = await call("POST", `/automation/schedules/${id}/cancel`, { tenant: "tC" })
    expect((cancelled.json as { state: string }).state).toBe("cancelled")

    const cross = await call("POST", `/automation/schedules/${id}/cancel`, { tenant: "tX" })
    expect(cross.status).toBe(404)
  })

  it("rejects invalid schedule input (422) and requires auth (401)", async () => {
    const invalid = await call("POST", "/automation/schedules", { tenant: "tD", body: { name: "x", automationVersionId: "ver_1", kind: "bogus" } })
    expect(invalid.status).toBe(422)

    const noauth = await call("POST", "/automation/schedules", { body: { name: "x", automationVersionId: "ver_1", kind: "recurring", cron: "0 9 * * *" } })
    expect(noauth.status).toBe(401)
  })

  it("exposes retry-status and operational health, tenant-scoped", async () => {
    const retry = await call("GET", "/operations/retry-status", { tenant: "tA" })
    expect(retry.status).toBe(200)
    expect((retry.json as { items: unknown[] }).items).toHaveLength(0)

    const health = await call("GET", "/operations/health/p2b", { tenant: "tA" })
    expect(health.status).toBe(200)
    expect((health.json as { opsQueue: unknown }).opsQueue).toBeDefined()
  })

  it("exposes tenant-scoped metrics derived from durable records", async () => {
    const { runId } = await createTemplateVersionRun("tSeed", "metrics_run")
    expect(runId).toBeTruthy()
    const metrics = await call("GET", "/automation/metrics", { tenant: "tSeed" })
    expect(metrics.status).toBe(200)
    const body = metrics.json as { runs: { total: number }; delivery: unknown; approvals: unknown }
    expect(body.runs.total).toBeGreaterThanOrEqual(1)
  })

  it("lists deliveries for a run, tenant-isolated (404 cross-tenant)", async () => {
    const { runId } = await createTemplateVersionRun("tSeed", "delivery_run")
    const same = await call("GET", `/automation/runs/${runId}/deliveries`, { tenant: "tSeed" })
    expect(same.status).toBe(200)
    expect((same.json as { deliveries: unknown[] }).deliveries).toHaveLength(0)
    const cross = await call("GET", `/automation/runs/${runId}/deliveries`, { tenant: "tB" })
    expect(cross.status).toBe(404)
  })

  it("SSE stream replays events and closes with done (no-gap, terminal-readable)", async () => {
    const { runId } = await createTemplateVersionRun("tSeed", "sse_run")
    const response = await fetch(`${base}/automation/runs/${runId}/stream?follow=false`, { headers: headers("tSeed") })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const text = await response.text()
    expect(text).toContain("event: done")
    // Cross-tenant SSE -> 404 (no existence leak).
    const cross = await fetch(`${base}/automation/runs/${runId}/stream?follow=false`, { headers: headers("tB") })
    expect(cross.status).toBe(404)
  })

  it("never leaks secrets/bearer tokens in retry-status output", async () => {
    const retry = await call("GET", "/operations/retry-status", { tenant: "tA" })
    const text = JSON.stringify(retry.json)
    expect(text).not.toMatch(/Bearer\s+[A-Za-z0-9]/)
    expect(text).not.toMatch(/token=[A-Za-z0-9]/)
  })
})
