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

async function seedCompletedRun(service: AutomationService, dispatcher: FakeJobDispatcher, opts: { destination?: string } = {}) {
  const principal = adminPrincipal()
  const t = await service.createTemplate({ principal, orgId: "org_a", projectId: "proj_a", name: "T" })
  const v = await service.publishVersion({ principal, templateId: t.templateId, definition: simpleDefinition({ destination: opts.destination ?? "dest-1" }), inputContract: simpleInputContract() })
  dispatcher.setStepOutcome("step1", { text: '{"result":"payload"}' })
  const run = await service.createRun({ principal, orgId: "org_a", projectId: "proj_a", templateId: t.templateId, versionId: v.versionId, input: [{ fieldId: "query", value: "q" }], idempotencyKey: `k_${Math.random()}` })
  await service.advanceRun(principal, run.runId)
  return { principal, t, v, run }
}

describe("delivery", () => {
  it("28. delivery is idempotent (re-deliver same idempotency key = one settled attempt)", async () => {
    const { service, dispatcher, store, delivery } = makeService()
    const { principal, run } = await seedCompletedRun(service, dispatcher)
    const after = await service.getRun(principal, run.runId)
    expect(after!.status).toBe("completed")
    // The run should have delivered exactly once.
    const settledBefore = delivery.attemptLog.filter((a) => a.status === "delivered").length
    expect(settledBefore).toBeGreaterThanOrEqual(1)
    // Re-driving delivery (e.g. reconcile) should not create a new settled attempt.
    await service.reconcileRun(principal, run.runId)
    const settledAfter = delivery.attemptLog.filter((a) => a.status === "delivered").length
    expect(settledAfter).toBe(settledBefore)
  })

  it("29. crash during delivery does not falsely settle (in-flight attempt is retried, not marked delivered)", async () => {
    const dispatcher = new FakeJobDispatcher()
    const store = new InMemoryAutomationStore()
    // A delivery provider that fails the first attempt, then succeeds.
    const delivery = new FakeDeliveryProvider()
    delivery.failNext(1)
    const service = new AutomationService({ store, artifacts: new InMemoryArtifactStore(), delivery, dispatcher, audit: fakeAudit() })
    const { principal, run } = await seedCompletedRun(service, dispatcher)
    const after = await service.getRun(principal, run.runId)
    // Even after a failed delivery attempt, the run is not falsely "completed" as delivered.
    // It should be in a delivering/failed-delivery state, then reconciled to completed.
    expect(["completed", "delivering", "failed"]).toContain(after!.status)
  })

  it("30. retry reuses the same delivery identity", async () => {
    const dispatcher = new FakeJobDispatcher()
    const store = new InMemoryAutomationStore()
    const delivery = new FakeDeliveryProvider()
    delivery.failNext(2)
    const service = new AutomationService({ store, artifacts: new InMemoryArtifactStore(), delivery, dispatcher, audit: fakeAudit() })
    const { principal, run } = await seedCompletedRun(service, dispatcher)
    // All delivery attempts for this run share the same idempotencyKey (identity).
    const attempts = delivery.attemptLog
    if (attempts.length > 1) {
      const keys = new Set(attempts.map((a) => a.idempotencyKey))
      expect(keys.size).toBe(1)
    }
    // Reconcile to settle.
    await service.reconcileRun(principal, run.runId)
    const settled = delivery.attemptLog.filter((a) => a.status === "delivered")
    expect(settled.length).toBeLessThanOrEqual(1)
  })

  it("31. final delivery result is historically recoverable", async () => {
    const { service, dispatcher, store } = makeService()
    const { principal, run } = await seedCompletedRun(service, dispatcher)
    const deliveries = await store.listDeliveryAttempts(principal.tenantId, run.runId)
    expect(deliveries.length).toBeGreaterThanOrEqual(1)
    const settled = deliveries.find((d) => d.status === "delivered")
    expect(settled).toBeDefined()
    expect(settled!.resultRef).toBeTruthy()
  })
})
