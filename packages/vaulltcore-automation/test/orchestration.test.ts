import { describe, it, expect } from "vitest"
import {
  InMemoryAutomationStore,
  InMemoryArtifactStore,
  FakeDeliveryProvider,
  AutomationService,
  AutomationError,
  buildArtifact,
  verifyArtifact,
  contentChecksum,
} from "../src"
import { FakeJobDispatcher, simpleDefinition, simpleStep, simpleInputContract, adminPrincipal, memberPrincipal } from "./fixtures"
import type { SqlAuditStore } from "@vaulltcore/audit"

function fakeAudit(): SqlAuditStore {
  return { append: async () => {}, list: async () => [] } as unknown as SqlAuditStore
}

function makeService() {
  const dispatcher = new FakeJobDispatcher()
  const store = new InMemoryAutomationStore()
  const artifacts = new InMemoryArtifactStore()
  const delivery = new FakeDeliveryProvider()
  const service = new AutomationService({ store, artifacts, delivery, dispatcher, audit: fakeAudit() })
  return { service, dispatcher, store, artifacts, delivery }
}

async function seedRun(service: AutomationService, dispatcher: FakeJobDispatcher, opts: { query?: string; requiresApproval?: boolean; destination?: string; stepOutcome?: { text: string; status?: "completed" | "failed"; error?: string } } = {}) {
  const principal = adminPrincipal()
  const t = await service.createTemplate({ principal, orgId: "org_a", projectId: "proj_a", name: "T" })
  const v = await service.publishVersion({ principal, templateId: t.templateId, definition: simpleDefinition({ requiresApproval: opts.requiresApproval, destination: opts.destination }), inputContract: simpleInputContract() })
  dispatcher.setStepOutcome("step1", opts.stepOutcome ?? { text: `{"result":"${opts.query ?? "ok"}"}` })
  const run = await service.createRun({ principal, orgId: "org_a", projectId: "proj_a", templateId: t.templateId, versionId: v.versionId, input: [{ fieldId: "query", value: opts.query ?? "q" }], idempotencyKey: `k_${Math.random()}` })
  return { principal, t, v, run }
}

describe("jobs/orchestration", () => {
  it("15. step→job mapping is durable", async () => {
    const { service, dispatcher, store } = makeService()
    const { principal, run } = await seedRun(service, dispatcher)
    await service.advanceRun(principal, run.runId)
    const mappings = await store.listJobMappings(principal.tenantId, run.runId)
    expect(mappings).toHaveLength(1)
    expect(mappings[0]!.stepId).toBe("step1")
    expect(mappings[0]!.jobId).toMatch(/^job_/)
  })

  it("16. restart does not duplicate committed job work", async () => {
    const { service, dispatcher, store } = makeService()
    const { principal, run } = await seedRun(service, dispatcher)
    await service.advanceRun(principal, run.runId)
    const jobsBefore = dispatcher.distinctJobCount()
    // Advance again (simulate a restart re-driving the run).
    await service.advanceRun(principal, run.runId)
    expect(dispatcher.distinctJobCount()).toBe(jobsBefore)
    // Only one mapping.
    const mappings = await store.listJobMappings(principal.tenantId, run.runId)
    expect(mappings).toHaveLength(1)
  })

  it("17. multiple steps respect dependencies", async () => {
    const { service, dispatcher } = makeService()
    const principal = adminPrincipal()
    const t = await service.createTemplate({ principal, orgId: "org_a", projectId: "proj_a", name: "T" })
    const base = simpleDefinition({})
    const def: typeof base = {
      ...base,
      steps: [
        ...base.steps,
        simpleStep({ stepId: "step2", prompt: "${steps.step1.output.result}", dependsOn: ["step1"], outputKey: "final" }),
      ],
      artifacts: [
        ...base.artifacts,
        { artifactId: "art2", stepId: "step2", type: "text", name: "final.txt", path: "final" },
      ],
    }
    const v = await service.publishVersion({ principal, templateId: t.templateId, definition: def, inputContract: simpleInputContract() })
    dispatcher.setStepOutcome("step1", { text: '{"result":"intermediate"}' })
    dispatcher.setStepOutcome("step2", { text: '{"final":"done"}' })
    const run = await service.createRun({ principal, orgId: "org_a", projectId: "proj_a", templateId: t.templateId, versionId: v.versionId, input: [{ fieldId: "query", value: "q" }], idempotencyKey: "k" })
    const result = await service.advanceRun(principal, run.runId)
    expect(result.status).toBe("completed")
    // Both steps ran, in order.
    expect(dispatcher.calls).toHaveLength(2)
    // step2's prompt references step1's output.
    expect(dispatcher.calls[1]!.input).toContain("intermediate")
  })

  it("18. failed job projects a deterministic run state", async () => {
    const { service, dispatcher } = makeService()
    const { principal, run } = await seedRun(service, dispatcher, { stepOutcome: { text: "", status: "failed", error: "boom" } })
    const result = await service.advanceRun(principal, run.runId)
    expect(result.status).toBe("failed")
    expect(result.error).toContain("boom")
  })
})

describe("artifacts", () => {
  it("19. artifact identity is immutable", async () => {
    const { service, store } = makeService()
    const { principal, run } = await seedRun(service, new FakeJobDispatcher())
    await service.advanceRun(principal, run.runId)
    const artifacts = await store.listArtifacts(principal.tenantId, run.runId)
    expect(artifacts).toHaveLength(1)
    // Re-saving the same artifact id is rejected.
    await expect(store.saveArtifact(artifacts[0]!)).rejects.toThrow(AutomationError)
  })

  it("20. corrupt artifact checksum is detected", async () => {
    const { artifacts } = makeService()
    const content = new TextEncoder().encode("hello")
    const { contentRef, checksum } = await artifacts.put(content, "f.txt")
    // Build a record with a wrong checksum.
    const record = buildArtifact({ runId: "r", versionId: "v", stepId: "s", type: "text", name: "f.txt", contentRef, checksum: "wrong", size: content.byteLength })
    await expect(verifyArtifact(record, artifacts)).rejects.toThrow(AutomationError)
  })

  it("21. historical artifact remains linked to its run", async () => {
    const { service, store, dispatcher } = makeService()
    const { principal, run } = await seedRun(service, dispatcher, { query: "ok" })
    await service.advanceRun(principal, run.runId)
    // Even after the run completes, the artifact is queryable by runId.
    const artifacts = await store.listArtifacts(principal.tenantId, run.runId)
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]!.runId).toBe(run.runId)
    // The artifact content is the step output value ("ok"); its checksum matches.
    expect(artifacts[0]!.checksum).toBe(contentChecksum(new TextEncoder().encode("ok")))
  })
})

describe("security/isolation", () => {
  it("32. cross-tenant run access is denied", async () => {
    const { service, dispatcher } = makeService()
    const { run } = await seedRun(service, dispatcher)
    const other = adminPrincipal("tenant_b", "org_a", "proj_a")
    expect(await service.getRun(other, run.runId)).toBeNull()
    expect(await service.listRunEvents(other, run.runId)).toHaveLength(0)
    expect(await service.listRunArtifacts(other, run.runId)).toHaveLength(0)
  })

  it("33. cross-project access is denied for non-admin", async () => {
    const { service, dispatcher } = makeService()
    const { run } = await seedRun(service, dispatcher)
    // A member of a different project in the same org cannot access.
    const otherProject = memberPrincipal("tenant_a", "org_a", "proj_other")
    expect(await service.getRun(otherProject, run.runId)).toBeNull()
  })

  it("33b. unauthorized approver is rejected (role below minimum)", async () => {
    const { service, dispatcher } = makeService()
    const { principal, run } = await seedRun(service, dispatcher, { requiresApproval: true })
    await service.advanceRun(principal, run.runId)
    const reqs = await service.listRunApprovalRequests(principal, run.runId)
    expect(reqs).toHaveLength(1)
    // The approval's minApproverRole is "operator"; a viewer (rank 10 < 20) cannot approve.
    const viewer = memberPrincipal("tenant_a", "org_a", "proj_a", "viewer")
    await expect(service.decideApproval({ principal: viewer, approvalId: reqs[0]!.approvalId, decision: "approved" })).rejects.toThrow(AutomationError)
  })
})
