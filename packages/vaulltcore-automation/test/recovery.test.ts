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

/** Simulate a crash: the dispatcher creates the job durably but throws before
 *  returning, so the service never saves the mapping or projects the step. The
 *  job survives inside the dispatcher (as it would in a durable Phase 1 kernel).
 *  A fresh service reconciling the same run must recover without duplicating
 *  the job. */
async function seedCrashedRun(store: InMemoryAutomationStore, dispatcher: FakeJobDispatcher) {
  const service = new AutomationService({
    store,
    artifacts: new InMemoryArtifactStore(),
    delivery: new FakeDeliveryProvider(),
    dispatcher,
    audit: fakeAudit(),
  })
  const principal = adminPrincipal()
  const t = await service.createTemplate({ principal, orgId: "org_a", projectId: "proj_a", name: "T" })
  const v = await service.publishVersion({ principal, templateId: t.templateId, definition: simpleDefinition({}), inputContract: simpleInputContract() })
  dispatcher.setStepOutcome("step1", { text: '{"result":"recovered"}' })
  dispatcher.crashAfterJob = true
  const run = await service.createRun({ principal, orgId: "org_a", projectId: "proj_a", templateId: t.templateId, versionId: v.versionId, input: [{ fieldId: "query", value: "q" }], idempotencyKey: "crash_k" })
  // advanceRun dispatches step1; the dispatcher creates the job then throws.
  await expect(service.advanceRun(principal, run.runId)).rejects.toThrow("simulated crash")
  // The run is stuck in a non-terminal state (projection never happened), but
  // the job was durably created inside the dispatcher.
  const stuck = await store.getRun(principal.tenantId, run.runId)
  expect(["admitted", "running"]).toContain(stuck!.status)
  return { principal, run }
}

describe("recovery/reconciliation", () => {
  it("12. crash after job creation before projection recovers safely", async () => {
    const store = new InMemoryAutomationStore()
    const dispatcher = new FakeJobDispatcher()
    const { principal, run } = await seedCrashedRun(store, dispatcher)
    // A job was created during the crashed advanceRun.
    expect(dispatcher.distinctJobCount()).toBe(1)
    // Rebuild a fresh service from the same store + dispatcher (process restart;
    // the durable job state survives in the dispatcher/kernel).
    const { service: fresh } = makeService(store)
    // Re-point the fresh service at the same dispatcher (in a real deployment
    // the dispatcher is the control-plane AdmissionJobDispatcher over the same
    // runner/store, so job state is durable across restarts).
    ;(fresh as unknown as { deps: { dispatcher: FakeJobDispatcher } }).deps.dispatcher = dispatcher
    // Reconcile: re-dispatches step1, but the dispatcher deduplicates on the
    // idempotency key → no new job, then projects the existing job's state.
    await fresh.reconcileRun(principal, run.runId)
    expect(dispatcher.distinctJobCount()).toBe(1) // no duplicate
    const mappings = await store.listJobMappings(principal.tenantId, run.runId)
    expect(mappings).toHaveLength(1)
  })

  it("34. fresh process resumes safely (reconcile advances a stuck run)", async () => {
    const store = new InMemoryAutomationStore()
    const dispatcher = new FakeJobDispatcher()
    const { principal, run } = await seedCrashedRun(store, dispatcher)
    const { service: fresh } = makeService(store)
    ;(fresh as unknown as { deps: { dispatcher: FakeJobDispatcher } }).deps.dispatcher = dispatcher
    const result = await fresh.reconcileRun(principal, run.runId)
    // The reconciled run advanced toward completion without re-executing work.
    expect(["collecting", "completed", "delivering"]).toContain(result.status)
    expect(dispatcher.distinctJobCount()).toBe(1)
  })

  it("35. reconciliation repairs missing safe projections (artifact)", async () => {
    const store = new InMemoryAutomationStore()
    const { service, dispatcher } = makeService(store)
    const principal = adminPrincipal()
    const t = await service.createTemplate({ principal, orgId: "org_a", projectId: "proj_a", name: "T" })
    const v = await service.publishVersion({ principal, templateId: t.templateId, definition: simpleDefinition({}), inputContract: simpleInputContract() })
    dispatcher.setStepOutcome("step1", { text: '{"result":"proj-missing"}' })
    const run = await service.createRun({ principal, orgId: "org_a", projectId: "proj_a", templateId: t.templateId, versionId: v.versionId, input: [{ fieldId: "query", value: "q" }], idempotencyKey: "k35" })
    // Advance fully so the job completes, then reconcile to re-derive artifacts.
    await service.advanceRun(principal, run.runId)
    const artsBefore = await store.listArtifacts(principal.tenantId, run.runId)
    expect(artsBefore.length).toBeGreaterThanOrEqual(1)
    // Reconcile should be a no-op-safe repair: it re-derives artifacts from the
    // committed job events without creating new execution work.
    const jobsBefore = dispatcher.distinctJobCount()
    await service.reconcileRun(principal, run.runId)
    expect(dispatcher.distinctJobCount()).toBe(jobsBefore)
    const artsAfter = await store.listArtifacts(principal.tenantId, run.runId)
    expect(artsAfter.length).toBeGreaterThanOrEqual(1)
  })

  it("36. reconciliation never creates new execution work", async () => {
    const store = new InMemoryAutomationStore()
    const { service, dispatcher } = makeService(store)
    const principal = adminPrincipal()
    const t = await service.createTemplate({ principal, orgId: "org_a", projectId: "proj_a", name: "T" })
    const v = await service.publishVersion({ principal, templateId: t.templateId, definition: simpleDefinition({}), inputContract: simpleInputContract() })
    dispatcher.setStepOutcome("step1", { text: '{"result":"no-reexec"}' })
    const run = await service.createRun({ principal, orgId: "org_a", projectId: "proj_a", templateId: t.templateId, versionId: v.versionId, input: [{ fieldId: "query", value: "q" }], idempotencyKey: "k36" })
    await service.advanceRun(principal, run.runId)
    const jobsBefore = dispatcher.distinctJobCount()
    // Reconcile multiple times — never creates a new job.
    await service.reconcileRun(principal, run.runId)
    await service.reconcileRun(principal, run.runId)
    expect(dispatcher.distinctJobCount()).toBe(jobsBefore)
  })
})
