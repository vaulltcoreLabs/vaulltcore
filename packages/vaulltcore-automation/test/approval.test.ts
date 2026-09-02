import { describe, it, expect } from "vitest"
import {
  InMemoryAutomationStore,
  InMemoryArtifactStore,
  FakeDeliveryProvider,
  AutomationService,
  AutomationError,
} from "../src"
import { FakeJobDispatcher, simpleDefinition, simpleInputContract, adminPrincipal } from "./fixtures"
import type { SqlAuditStore } from "@vaulltcore/audit"

function fakeAudit(): SqlAuditStore {
  return { append: async () => {}, list: async () => [] } as unknown as SqlAuditStore
}

function makeService() {
  const dispatcher = new FakeJobDispatcher()
  const store = new InMemoryAutomationStore()
  const delivery = new FakeDeliveryProvider()
  const service = new AutomationService({
    store,
    artifacts: new InMemoryArtifactStore(),
    delivery,
    dispatcher,
    audit: fakeAudit(),
  })
  return { service, dispatcher, store, delivery }
}

async function seedApprovalRun(service: AutomationService, dispatcher: FakeJobDispatcher) {
  const principal = adminPrincipal()
  const t = await service.createTemplate({ principal, orgId: "org_a", projectId: "proj_a", name: "T" })
  const v = await service.publishVersion({ principal, templateId: t.templateId, definition: simpleDefinition({ requiresApproval: true }), inputContract: simpleInputContract() })
  dispatcher.setStepOutcome("step1", { text: '{"result":"sensitive"}' })
  const run = await service.createRun({ principal, orgId: "org_a", projectId: "proj_a", templateId: t.templateId, versionId: v.versionId, input: [{ fieldId: "query", value: "q" }], idempotencyKey: `k_${Math.random()}` })
  return { principal, t, v, run }
}

describe("approval", () => {
  it("22. pending approval blocks continuation (delivery does not run)", async () => {
    const { service, dispatcher, store, delivery } = makeService()
    const { principal, run } = await seedApprovalRun(service, dispatcher)
    await service.advanceRun(principal, run.runId)
    // Run should be awaiting_approval, not completed/delivered.
    const after = await service.getRun(principal, run.runId)
    expect(after!.status).toBe("awaiting_approval")
    // No delivery attempts.
    expect(delivery.attemptLog).toHaveLength(0)
    const arts = await store.listArtifacts(principal.tenantId, run.runId)
    expect(arts.length).toBeGreaterThanOrEqual(0) // artifacts may exist pre-approval
  })

  it("23. approve continues correctly (run completes + delivers)", async () => {
    const { service, dispatcher, delivery } = makeService()
    const { principal, run } = await seedApprovalRun(service, dispatcher)
    await service.advanceRun(principal, run.runId)
    const reqs = await service.listRunApprovalRequests(principal, run.runId)
    expect(reqs).toHaveLength(1)
    const decision = await service.decideApproval({ principal, approvalId: reqs[0]!.approvalId, decision: "approved" })
    expect(decision.approval.status).toBe("approved")
    // The run should now proceed to delivery and complete.
    const after = await service.getRun(principal, run.runId)
    expect(["delivering", "completed"]).toContain(after!.status)
    // Delivery was attempted.
    expect(delivery.attemptLog.length).toBeGreaterThanOrEqual(1)
  })

  it("24. reject terminates correctly (run → rejected, no delivery)", async () => {
    const { service, dispatcher, delivery } = makeService()
    const { principal, run } = await seedApprovalRun(service, dispatcher)
    await service.advanceRun(principal, run.runId)
    const reqs = await service.listRunApprovalRequests(principal, run.runId)
    await service.decideApproval({ principal, approvalId: reqs[0]!.approvalId, decision: "rejected" })
    const after = await service.getRun(principal, run.runId)
    expect(after!.status).toBe("rejected")
    expect(delivery.attemptLog).toHaveLength(0)
  })

  it("25. concurrent decisions produce one terminal outcome", async () => {
    const { service, dispatcher } = makeService()
    const { principal, run } = await seedApprovalRun(service, dispatcher)
    await service.advanceRun(principal, run.runId)
    const reqs = await service.listRunApprovalRequests(principal, run.runId)
    const approver2 = adminPrincipal()
    // Two concurrent decisions: the fenced CAS ensures only one wins; the loser
    // throws a version-conflict (no contradictory terminal state is persisted).
    const results = await Promise.allSettled([
      service.decideApproval({ principal, approvalId: reqs[0]!.approvalId, decision: "approved" }),
      service.decideApproval({ principal: approver2, approvalId: reqs[0]!.approvalId, decision: "rejected" }),
    ])
    const fulfilled = results.filter((r) => r.status === "fulfilled")
    expect(fulfilled).toHaveLength(1)
    // The approval request has a single terminal status (no contradiction).
    const req = await service.getApprovalRequest(principal, reqs[0]!.approvalId)
    expect(["approved", "rejected"]).toContain(req!.status)
  })

  it("26. unauthorized approver is rejected", async () => {
    const { service, dispatcher } = makeService()
    const { principal, run } = await seedApprovalRun(service, dispatcher)
    await service.advanceRun(principal, run.runId)
    const reqs = await service.listRunApprovalRequests(principal, run.runId)
    // viewer rank 10 < operator rank 20 (minApproverRole).
    const viewer = { ...adminPrincipal(), role: "viewer" as const, admin: false, projectScope: ["proj_a"] }
    await expect(service.decideApproval({ principal: viewer, approvalId: reqs[0]!.approvalId, decision: "approved" })).rejects.toThrow(AutomationError)
  })

  it("27. replayed approval request does not duplicate side effects", async () => {
    const { service, dispatcher, delivery } = makeService()
    const { principal, run } = await seedApprovalRun(service, dispatcher)
    await service.advanceRun(principal, run.runId)
    const reqs = await service.listRunApprovalRequests(principal, run.runId)
    const first = await service.decideApproval({ principal, approvalId: reqs[0]!.approvalId, decision: "approved" })
    const deliveriesAfterFirst = delivery.attemptLog.length
    // Replay the same decision.
    const second = await service.decideApproval({ principal, approvalId: reqs[0]!.approvalId, decision: "approved" })
    expect(second.approval.status).toBe(first.approval.status)
    // No additional delivery side effect from the replay.
    expect(delivery.attemptLog.length).toBe(deliveriesAfterFirst)
  })
})
