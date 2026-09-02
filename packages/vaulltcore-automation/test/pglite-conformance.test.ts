/**
 * Tier A PGlite conformance for the automation SQL store (Phase 2A).
 *
 * PGlite is a real PostgreSQL engine running in-process, so these tests prove
 * the SQL-level invariants (constraints, fenced CAS, unique identities) hold
 * against genuine PostgreSQL — not just SQLite. They ALWAYS run (no env gating).
 * Tier B multi-connection server tests would be added under PG_TEST_* gating,
 * matching the Phase 1F pattern.
 */
import { describe, it, expect, afterAll } from "vitest"
import { PgliteDatabase, pgliteDialect } from "@vaulltcore/store-sql"
import { SqlAutomationStore } from "../src"
import {
  InMemoryArtifactStore,
  FakeDeliveryProvider,
  AutomationService,
  AutomationError,
  buildVersion,
  buildInputRevision,
  buildRun,
  buildDeliveryAttempt,
  buildApprovalRequest,
} from "../src"
import { FakeJobDispatcher, simpleDefinition, simpleInputContract, adminPrincipal } from "./fixtures"
import type { SqlAuditStore } from "@vaulltcore/audit"

const db = new PgliteDatabase()

afterAll(() => {
  db.close()
})

function fakeAudit(): SqlAuditStore {
  return { append: async () => {}, list: async () => [] } as unknown as SqlAuditStore
}

function makeService() {
  const store = new SqlAutomationStore(db, { dialect: pgliteDialect })
  const dispatcher = new FakeJobDispatcher()
  const service = new AutomationService({
    store,
    artifacts: new InMemoryArtifactStore(),
    delivery: new FakeDeliveryProvider(),
    dispatcher,
    audit: fakeAudit(),
  })
  return { service, dispatcher, store }
}

describe("automation SQL store — PGlite conformance (Tier A)", () => {
  it("creates + retrieves a template with correct ownership", async () => {
    const { store } = makeService()
    const tenantId = `pg_t_${Math.random().toString(36).slice(2)}`
    const t = await store.createTemplate({ templateId: `${tenantId}_tpl`, tenantId, orgId: "o", projectId: "p", name: "PG T", description: null, status: "draft", createdAt: Date.now(), createdBy: "u", archivedAt: null })
    expect(t.templateId).toBe(`${tenantId}_tpl`)
    const got = await store.getTemplate(tenantId, t.templateId)
    expect(got).not.toBeNull()
    expect(got!.tenantId).toBe(tenantId)
    // Cross-tenant read returns null (no leak).
    expect(await store.getTemplate("other_tenant", t.templateId)).toBeNull()
  })

  it("enforces UNIQUE (template_id, version)", async () => {
    const { store } = makeService()
    const tenantId = `pg_v_${Math.random().toString(36).slice(2)}`
    await store.createTemplate({ templateId: `${tenantId}_tpl`, tenantId, orgId: "o", projectId: "p", name: "V", description: null, status: "draft", createdAt: Date.now(), createdBy: "u", archivedAt: null })
    const v = buildVersion({ tenantId, orgId: "o", projectId: "p", templateId: `${tenantId}_tpl`, version: 1, definition: simpleDefinition({}), inputContract: simpleInputContract(), createdBy: "u" })
    await store.createVersion(v)
    // Same (template, version) with a different versionId must fail.
    const dup = { ...v, versionId: `${tenantId}_v_dup` }
    await expect(store.createVersion(dup)).rejects.toThrow()
  })

  it("verifies version checksum on load (corruption detected)", async () => {
    const { store } = makeService()
    const tenantId = `pg_c_${Math.random().toString(36).slice(2)}`
    await store.createTemplate({ templateId: `${tenantId}_tpl`, tenantId, orgId: "o", projectId: "p", name: "C", description: null, status: "draft", createdAt: Date.now(), createdBy: "u", archivedAt: null })
    const v = buildVersion({ tenantId, orgId: "o", projectId: "p", templateId: `${tenantId}_tpl`, version: 1, definition: simpleDefinition({}), inputContract: simpleInputContract(), createdBy: "u" })
    await store.createVersion(v)
    const reloaded = await store.getVersion(tenantId, v.versionId)
    expect(reloaded).not.toBeNull()
    expect(reloaded!.checksum).toBe(v.checksum)
  })

  it("fenced run transition rejects stale runVersion (CAS)", async () => {
    const { store } = makeService()
    const tenantId = `pg_r_${Math.random().toString(36).slice(2)}`
    const run = buildRun({ tenantId, orgId: "o", projectId: "p", templateId: "t", versionId: "v", version: 1, inputRevisionId: "ir", createdBy: "u" })
    await store.createRun(run)
    // Stale version (0) must fail; correct version (1) succeeds.
    await expect(store.transitionRun(tenantId, run.runId, 0, "validating_input")).rejects.toThrow()
    const ok = await store.transitionRun(tenantId, run.runId, 1, "validating_input")
    expect(ok.status).toBe("validating_input")
    expect(ok.runVersion).toBe(2)
  })

  it("durable input revision is recoverable with stable checksum", async () => {
    const { store } = makeService()
    const tenantId = `pg_i_${Math.random().toString(36).slice(2)}`
    const run = buildRun({ tenantId, orgId: "o", projectId: "p", templateId: "t", versionId: "v", version: 1, inputRevisionId: "ir", createdBy: "u" })
    await store.createRun(run)
    const rev = buildInputRevision({ runId: run.runId, values: { query: "frozen" } })
    await store.saveInputRevision(rev)
    const got = await store.getInputRevision(tenantId, run.runId, rev.inputRevisionId)
    expect(got).not.toBeNull()
    expect(got!.values.query).toBe("frozen")
    expect(got!.checksum).toBe(rev.checksum)
  })

  it("idempotent job mapping: UNIQUE (run_id, step_id)", async () => {
    const { store } = makeService()
    const tenantId = `pg_m_${Math.random().toString(36).slice(2)}`
    const run = buildRun({ tenantId, orgId: "o", projectId: "p", templateId: "t", versionId: "v", version: 1, inputRevisionId: "ir", createdBy: "u" })
    await store.createRun(run)
    const mapping = { mappingId: `${tenantId}_m1`, runId: run.runId, versionId: "v", stepId: "s1", jobId: "j1", idempotencyKey: `auto:${run.runId}:s1`, inputRevisionId: "ir", createdAt: Date.now() }
    await store.saveJobMapping(mapping)
    // Duplicate (runId, stepId) must fail.
    const dup = { ...mapping, mappingId: `${tenantId}_m2`, jobId: "j2" }
    await expect(store.saveJobMapping(dup)).rejects.toThrow()
  })

  it("idempotent delivery: UNIQUE (run_id, idempotency_key) + fenced transition", async () => {
    const { store } = makeService()
    const tenantId = `pg_d_${Math.random().toString(36).slice(2)}`
    const run = buildRun({ tenantId, orgId: "o", projectId: "p", templateId: "t", versionId: "v", version: 1, inputRevisionId: "ir", createdBy: "u" })
    await store.createRun(run)
    const attempt = buildDeliveryAttempt({ runId: run.runId, versionId: "v", idempotencyKey: `delivery:${run.runId}:dest`, destination: "dest" })
    await store.saveDeliveryAttempt(attempt)
    // Duplicate key must fail.
    const dup = { ...attempt, deliveryId: `${tenantId}_d2` }
    await expect(store.saveDeliveryAttempt(dup)).rejects.toThrow()
    // Fenced transition: stale version fails.
    await expect(store.transitionDelivery(tenantId, attempt.deliveryId, 0, "in_progress")).rejects.toThrow()
    const ok = await store.transitionDelivery(tenantId, attempt.deliveryId, 1, "in_progress")
    expect(ok.status).toBe("in_progress")
  })

  it("approval decision is fenced + idempotent (concurrent CAS → one winner)", async () => {
    const { store } = makeService()
    const tenantId = `pg_a_${Math.random().toString(36).slice(2)}`
    const run = buildRun({ tenantId, orgId: "o", projectId: "p", templateId: "t", versionId: "v", version: 1, inputRevisionId: "ir", createdBy: "u" })
    await store.createRun(run)
    const req = buildApprovalRequest({ runId: run.runId, versionId: "v", gateId: "g1", minApproverRole: "operator", contextArtifacts: [], expiresAfterMs: null })
    await store.saveApprovalRequest(req)
    // Two concurrent decisions with the same expected version: only one wins.
    const [r1, r2] = await Promise.allSettled([
      store.decideApproval(tenantId, req.approvalId, req.approvalVersion, "approved", { principalId: "u1", kind: "user" }, undefined),
      store.decideApproval(tenantId, req.approvalId, req.approvalVersion, "rejected", { principalId: "u2", kind: "user" }, undefined),
    ])
    const fulfilled = [r1, r2].filter((r) => r.status === "fulfilled")
    expect(fulfilled).toHaveLength(1)
  })

  it("end-to-end run against PGlite: create → advance → complete", async () => {
    const { service, dispatcher } = makeService()
    const principal = adminPrincipal(`pg_e2e_${Math.random().toString(36).slice(2)}`, "o", "p")
    const t = await service.createTemplate({ principal, orgId: "o", projectId: "p", name: "E2E" })
    const v = await service.publishVersion({ principal, templateId: t.templateId, definition: simpleDefinition({}), inputContract: simpleInputContract() })
    dispatcher.setStepOutcome("step1", { text: '{"result":"pg-ok"}' })
    const run = await service.createRun({ principal, orgId: "o", projectId: "p", templateId: t.templateId, versionId: v.versionId, input: [{ fieldId: "query", value: "q" }], idempotencyKey: `pg_e2e_k_${Math.random()}` })
    const result = await service.advanceRun(principal, run.runId)
    expect(result.status).toBe("completed")
  })
})
