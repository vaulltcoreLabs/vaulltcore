import { describe, it, expect } from "vitest"
import {
  InMemoryAutomationStore,
  InMemoryArtifactStore,
  FakeDeliveryProvider,
  AutomationService,
  AutomationError,
  buildVersion,
  validateStepGraph,
  definitionChecksum,
  verifyVersionChecksum,
  validateInput,
  buildInputRevision,
} from "../src"
import { FakeJobDispatcher, simpleDefinition, simpleStep, simpleInputContract, adminPrincipal } from "./fixtures"
import type { SqlAuditStore } from "@vaulltcore/audit"

/** Minimal in-memory audit store stub for service tests. */
function fakeAudit(): SqlAuditStore {
  return {
    append: async () => {},
    list: async () => [],
  } as unknown as SqlAuditStore
}

function makeService(store = new InMemoryAutomationStore()) {
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

describe("template/version", () => {
  it("1. template ownership is immutable (tenant/org/project pinned at creation)", async () => {
    const { service } = makeService()
    const principal = adminPrincipal("t1", "o1", "p1")
    const t = await service.createTemplate({ principal, orgId: "o1", projectId: "p1", name: "T1" })
    expect(t.tenantId).toBe("t1")
    expect(t.orgId).toBe("o1")
    expect(t.projectId).toBe("p1")
    // A different tenant cannot read it.
    const other = adminPrincipal("t2", "o1", "p1")
    expect(await service.getTemplate(other, t.templateId)).toBeNull()
  })

  it("2. archived templates cannot accept new runs", async () => {
    const { service } = makeService()
    const principal = adminPrincipal()
    const t = await service.createTemplate({ principal, orgId: "org_a", projectId: "proj_a", name: "T" })
    const v = await service.publishVersion({ principal, templateId: t.templateId, definition: simpleDefinition({}), inputContract: simpleInputContract() })
    await service.archiveTemplate(principal, t.templateId)
    await expect(
      service.createRun({ principal, orgId: "org_a", projectId: "proj_a", templateId: t.templateId, versionId: v.versionId, input: [{ fieldId: "query", value: "hi" }], idempotencyKey: "k1" }),
    ).rejects.toThrow(AutomationError)
  })

  it("3. published versions are immutable (checksum verifies; mutation detected)", async () => {
    const { service, store } = makeService()
    const principal = adminPrincipal()
    const t = await service.createTemplate({ principal, orgId: "org_a", projectId: "proj_a", name: "T" })
    const v = await service.publishVersion({ principal, templateId: t.templateId, definition: simpleDefinition({}), inputContract: simpleInputContract() })
    const reloaded = await store.getVersion(principal.tenantId, v.versionId)
    expect(reloaded).not.toBeNull()
    expect(() => verifyVersionChecksum(reloaded!)).not.toThrow()
    // A tampered definition fails the checksum.
    const tampered = { ...reloaded!, definition: { ...reloaded!.definition, steps: [] } }
    expect(() => verifyVersionChecksum(tampered)).toThrow(AutomationError)
  })

  it("4. version numbers are monotonic and unique", async () => {
    const { service, store } = makeService()
    const principal = adminPrincipal()
    const t = await service.createTemplate({ principal, orgId: "org_a", projectId: "proj_a", name: "T" })
    const v1 = await service.publishVersion({ principal, templateId: t.templateId, definition: simpleDefinition({}), inputContract: simpleInputContract() })
    const v2 = await service.publishVersion({ principal, templateId: t.templateId, definition: simpleDefinition({}), inputContract: simpleInputContract() })
    expect(v2.version).toBe(v1.version + 1)
    // Duplicate (template, version) rejected at the store level.
    const dup = { ...v1, versionId: "vid_dup" }
    await expect(store.createVersion(dup)).rejects.toThrow(AutomationError)
  })

  it("5. corrupt checksum is rejected on version load", async () => {
    const { store } = makeService()
    const principal = adminPrincipal()
    await store.createTemplate({ templateId: "tid", tenantId: principal.tenantId, orgId: "org_a", projectId: "proj_a", name: "T", description: null, status: "draft", createdAt: Date.now(), createdBy: "u", archivedAt: null })
    const v = buildVersion({ tenantId: principal.tenantId, orgId: "org_a", projectId: "proj_a", templateId: "tid", version: 1, definition: simpleDefinition({}), inputContract: simpleInputContract(), createdBy: "u" })
    await store.createVersion(v)
    // A version with a wrong checksum fails verification on load.
    const corrupt = { ...v, versionId: "vid_corrupt", version: 2, checksum: "deadbeef" }
    await store.createVersion(corrupt)
    await expect(store.getVersion(principal.tenantId, "vid_corrupt")).rejects.toThrow(AutomationError)
  })

  it("6. invalid step graph is rejected (cycle)", () => {
    const steps = [
      simpleStep({ stepId: "step1", dependsOn: ["step2"] }),
      simpleStep({ stepId: "step2", dependsOn: ["step1"] }),
    ]
    expect(() => validateStepGraph(steps)).toThrow(AutomationError)
  })

  it("6b. invalid step graph is rejected (duplicate step ids)", () => {
    const steps = [simpleStep({ stepId: "step1" }), simpleStep({ stepId: "step1" })]
    expect(() => validateStepGraph(steps)).toThrow(AutomationError)
  })

  it("6c. invalid step graph is rejected (missing dependency)", () => {
    const steps = [
      simpleStep({ stepId: "step1" }),
      simpleStep({ stepId: "step2", dependsOn: ["nope"] }),
    ]
    expect(() => validateStepGraph(steps)).toThrow(AutomationError)
  })

  it("7. cross-tenant version references fail", async () => {
    const { service } = makeService()
    const a = adminPrincipal("t1", "o1", "p1")
    const b = adminPrincipal("t2", "o2", "p2")
    const ta = await service.createTemplate({ principal: a, orgId: "o1", projectId: "p1", name: "TA" })
    const va = await service.publishVersion({ principal: a, templateId: ta.templateId, definition: simpleDefinition({}), inputContract: simpleInputContract() })
    // Tenant b cannot read tenant a's version.
    expect(await service.getVersion(b, va.versionId)).toBeNull()
    // Tenant b cannot create a run referencing tenant a's version.
    await expect(
      service.createRun({ principal: b, orgId: "o2", projectId: "p2", templateId: ta.templateId, versionId: va.versionId, input: [{ fieldId: "query", value: "x" }], idempotencyKey: "k" }),
    ).rejects.toThrow(AutomationError)
  })
})

describe("run/input", () => {
  it("8. valid input creates a run", async () => {
    const { service } = makeService()
    const principal = adminPrincipal()
    const t = await service.createTemplate({ principal, orgId: "org_a", projectId: "proj_a", name: "T" })
    const v = await service.publishVersion({ principal, templateId: t.templateId, definition: simpleDefinition({}), inputContract: simpleInputContract() })
    const run = await service.createRun({ principal, orgId: "org_a", projectId: "proj_a", templateId: t.templateId, versionId: v.versionId, input: [{ fieldId: "query", value: "hello" }], idempotencyKey: "k1" })
    expect(run.status).toBe("admitted")
  })

  it("9. invalid input creates no job and no run", async () => {
    const { service, store, dispatcher } = makeService()
    const principal = adminPrincipal()
    const t = await service.createTemplate({ principal, orgId: "org_a", projectId: "proj_a", name: "T" })
    const v = await service.publishVersion({ principal, templateId: t.templateId, definition: simpleDefinition({}), inputContract: simpleInputContract() })
    // Missing required "query" field.
    await expect(
      service.createRun({ principal, orgId: "org_a", projectId: "proj_a", templateId: t.templateId, versionId: v.versionId, input: [], idempotencyKey: "k1" }),
    ).rejects.toThrow(AutomationError)
    // No run, no job.
    expect(await store.listRuns(principal.tenantId)).toHaveLength(0)
    expect(dispatcher.distinctJobCount()).toBe(0)
  })

  it("10. exact historical input remains recoverable", async () => {
    const { service, store } = makeService()
    const principal = adminPrincipal()
    const t = await service.createTemplate({ principal, orgId: "org_a", projectId: "proj_a", name: "T" })
    const v = await service.publishVersion({ principal, templateId: t.templateId, definition: simpleDefinition({}), inputContract: simpleInputContract() })
    const run = await service.createRun({ principal, orgId: "org_a", projectId: "proj_a", templateId: t.templateId, versionId: v.versionId, input: [{ fieldId: "query", value: "frozen-input" }], idempotencyKey: "k1" })
    const revision = await store.getInputRevision(principal.tenantId, run.runId, run.inputRevisionId)
    expect(revision).not.toBeNull()
    expect(revision!.values.query).toBe("frozen-input")
    // Checksum is stable.
    const rev2 = buildInputRevision({ runId: run.runId, values: { query: "frozen-input" } })
    expect(rev2.checksum).toBe(revision!.checksum)
  })

  it("11. duplicate create requests do not duplicate runs/jobs", async () => {
    const { service, store } = makeService()
    const principal = adminPrincipal()
    const t = await service.createTemplate({ principal, orgId: "org_a", projectId: "proj_a", name: "T" })
    const v = await service.publishVersion({ principal, templateId: t.templateId, definition: simpleDefinition({}), inputContract: simpleInputContract() })
    const r1 = await service.createRun({ principal, orgId: "org_a", projectId: "proj_a", templateId: t.templateId, versionId: v.versionId, input: [{ fieldId: "query", value: "x" }], idempotencyKey: "dup" })
    const r2 = await service.createRun({ principal, orgId: "org_a", projectId: "proj_a", templateId: t.templateId, versionId: v.versionId, input: [{ fieldId: "query", value: "x" }], idempotencyKey: "dup" })
    expect(r1.runId).toBe(r2.runId)
    expect(await store.listRuns(principal.tenantId)).toHaveLength(1)
  })

  it("13. fresh process rebuilds run state (via reconciliation)", async () => {
    // Covered in detail in the recovery test file; here we verify the service
    // reconcileRun path exists and is idempotent.
    const { service, dispatcher } = makeService()
    const principal = adminPrincipal()
    const t = await service.createTemplate({ principal, orgId: "org_a", projectId: "proj_a", name: "T" })
    const v = await service.publishVersion({ principal, templateId: t.templateId, definition: simpleDefinition({}), inputContract: simpleInputContract() })
    dispatcher.setStepOutcome("step1", { text: '{"result":"ok"}' })
    const run = await service.createRun({ principal, orgId: "org_a", projectId: "proj_a", templateId: t.templateId, versionId: v.versionId, input: [{ fieldId: "query", value: "q" }], idempotencyKey: "k" })
    await service.advanceRun(principal, run.runId)
    // Reconcile should be a no-op (already projected) and not create work.
    const before = dispatcher.distinctJobCount()
    await service.reconcileRun(principal, run.runId)
    expect(dispatcher.distinctJobCount()).toBe(before)
  })

  it("14. illegal state transitions fail atomically", async () => {
    const { store } = makeService()
    const principal = adminPrincipal()
    const run = { runId: "r1", tenantId: principal.tenantId, orgId: "org_a", projectId: "proj_a", templateId: "t", versionId: "v", version: 1, status: "created" as const, inputRevisionId: "ir", runVersion: 1, createdBy: "u", error: null, createdAt: 1, updatedAt: 1, suspendedAt: null, completedAt: null }
    await store.createRun(run)
    // created → completed is illegal.
    await expect(store.transitionRun(principal.tenantId, "r1", 1, "completed")).rejects.toThrow(AutomationError)
    // The run is unchanged (atomic rollback).
    const after = await store.getRun(principal.tenantId, "r1")
    expect(after!.status).toBe("created")
    expect(after!.runVersion).toBe(1)
  })
})

describe("input contract validation", () => {
  it("validates required/optional/primitive/json/artifact-ref fields", () => {
    const contract: ReturnType<typeof simpleInputContract> = {
      fields: [
        { fieldId: "s", type: "string", required: true, description: null },
        { fieldId: "n", type: "number", required: false, description: null },
        { fieldId: "b", type: "boolean", required: false, description: null },
        { fieldId: "o", type: "json", required: false, description: null },
        { fieldId: "a", type: "artifact_ref", required: false, description: null },
      ],
    }
    // Valid.
    validateInput(contract, { s: "x", n: 3, b: true, o: { k: 1 }, a: "art_123" })
    // Missing required.
    expect(() => validateInput(contract, {})).toThrow(AutomationError)
    // Wrong type.
    expect(() => validateInput(contract, { s: 5 })).toThrow(AutomationError)
    expect(() => validateInput(contract, { s: "x", n: "notnum" })).toThrow(AutomationError)
  })
})

describe("checksum determinism", () => {
  it("definitionChecksum is stable for identical definitions", () => {
    const d = simpleDefinition({})
    const c1 = definitionChecksum(d, simpleInputContract())
    const c2 = definitionChecksum(d, simpleInputContract())
    expect(c1).toBe(c2)
  })
})
