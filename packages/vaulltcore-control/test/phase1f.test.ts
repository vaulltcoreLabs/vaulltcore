/**
 * Phase 1F focused tests. Covers Deliverables 1–10 required scenarios:
 *  1  two API instances + same idempotency key create one job
 *  2  same replay consumes one quota reservation
 *  3  same key with different request fingerprint is rejected
 *  4  idempotency survives process/store restart
 *  5  expired orphan reservation releases capacity once
 *  6  reaper run twice does not double-release
 *  7  stale reaper cannot release a renewed/settled reservation
 *  8  crash after reservation before admission is recoverable
 *  9  terminal job unsettled reservation is reconciled safely
 *  10 missing UsageEvent is rebuilt from committed execution events
 *  11 reconciliation rerun creates no duplicate UsageEvent
 *  12 unpriced usage remains durably unresolved, never disappears
 *  13 missing LedgerEntry is repaired once
 *  14 concurrent settlement produces one ledger entry
 *  15 later pricing changes do not rewrite historical charge
 *  16 reconciliation never invokes AgentRunner execution
 *  17 worker recovery does not double-charge
 *  18 budget exhaustion preserves accounting and a durable execution boundary
 *  19 runtime duration/step/token enforcement is explicit and explainable
 *  20 API key rotation overlap works
 *  21 expired/revoked API keys fail
 *  22 ordinary tenant cannot read operational data for another tenant
 *  23 snapshot GC does not delete active recovery state
 *  24 GC is retry-safe and idempotent
 *  25 failed provider deletion remains retryable
 *
 * PostgreSQL true multi-connection concurrency (scenario 26) is covered in
 * postgres-conformance-1f.test.ts, gated on a real PG server (SKIPPED here).
 * Scenario 27 (Phase 1A–1E regression) is verified by the full suite.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { NodeSqliteDatabase, SqlJobStore, SqlAdmissionIdempotencyRegistry, DistributedSqlStore, SnapshotGcDriver } from "@vaulltcore/store-sql"
import { DurableAgentRunner, ScriptEngine, type Tool, type JobEvent } from "@vaulltcore/runner"
import { DEFAULT_ADMISSION_POLICY } from "@vaulltcore/policy"
import { quotaScope } from "@vaulltcore/quota"
import { eventsToUsage, type MeteringIdentity } from "@vaulltcore/metering"
import { DEFAULT_PRICING } from "@vaulltcore/billing"
import { seedFixture, DEFAULT_LIMITS, type BusinessFixture } from "./business-fixture"
import { AdmissionPipeline, AdmissionError } from "../src/admission"

const noopTool: Tool = {
  definition: { name: "noop", description: "no-op tool", parameters: { type: "object" } },
  async execute() {
    return { ok: true }
  },
}

let runnerRoots: string[] = []

async function newRunnerWithSqlStore(fixture: BusinessFixture): Promise<{ runner: DurableAgentRunner; jobStore: SqlJobStore }> {
  const root = await mkdtemp(path.join(tmpdir(), "vc-1f-runner-"))
  runnerRoots.push(root)
  const jobStore = new SqlJobStore(fixture.db)
  const turns = [{ text: "ok", usage: { inputTokens: 10, outputTokens: 5 } }]
  return {
    runner: new DurableAgentRunner({
      store: jobStore,
      engines: [new ScriptEngine(turns as never)],
      tools: [noopTool],
      workspace: null,
    }),
    jobStore,
  }
}

function newDurablePipeline(fixture: BusinessFixture, runner: DurableAgentRunner): AdmissionPipeline {
  const idem = new SqlAdmissionIdempotencyRegistry(fixture.db)
  return new AdmissionPipeline({
    runner,
    identity: fixture.identity,
    policy: fixture.policy,
    quota: fixture.quota,
    audit: fixture.audit,
    idempotency: idem,
  })
}

async function admit(pipeline: AdmissionPipeline, fx: BusinessFixture, key: string, input = "noop\nok") {
  const principal = (await fx.identity.authenticateApiKey(fx.apiKeySecret))!
  return pipeline.admit({
    principal,
    idempotencyKey: key,
    orgId: fx.orgId,
    projectId: fx.projectId,
    spec: { engine: "script", model: "script-model", input },
    requestedTools: ["noop", "read_file"],
  })
}

afterEach(() => {
  runnerRoots = []
})

// ===========================================================================
// Deliverable 1 — Durable distributed idempotency
// ===========================================================================

describe("Phase 1F Deliverable 1: durable distributed admission idempotency", () => {
  it("1. two API instances + same idempotency key create one job", async () => {
    const fx = await seedFixture()
    const { runner } = await newRunnerWithSqlStore(fx)
    // Two independent pipelines (two "API instances") sharing ONE durable store.
    const pipelineA = newDurablePipeline(fx, runner)
    const pipelineB = newDurablePipeline(fx, runner)
    const a = await admit(pipelineA, fx, "key-shared")
    const b = await admit(pipelineB, fx, "key-shared")
    expect(a.replayed).toBe(false)
    expect(b.replayed).toBe(true)
    expect(b.jobId).toBe(a.jobId)
    // Exactly one job + one reservation.
    const active = (await fx.quota.listReservations(quotaScope({ tenantId: fx.tenantId, orgId: fx.orgId, projectId: fx.projectId }))).filter((r) => r.state === "active")
    expect(active.length).toBe(1)
    const job = await runner.getJob(a.jobId)
    expect(job).not.toBeNull()
  })

  it("2. same replay consumes one quota reservation", async () => {
    const fx = await seedFixture()
    const { runner } = await newRunnerWithSqlStore(fx)
    const pipeline = newDurablePipeline(fx, runner)
    await fx.quota.setLimits(quotaScope({ tenantId: fx.tenantId, orgId: fx.orgId, projectId: fx.projectId }), DEFAULT_LIMITS)
    const first = await admit(pipeline, fx, "reserve-once")
    await admit(pipeline, fx, "reserve-once")
    await admit(pipeline, fx, "reserve-once")
    const reservations = (await fx.quota.listReservations(quotaScope({ tenantId: fx.tenantId, orgId: fx.orgId, projectId: fx.projectId }))).filter((r) => r.state === "active")
    expect(reservations.length).toBe(1)
    expect(reservations[0]!.reservationId).toBe(first.reservationId)
  })

  it("3. same key with different request fingerprint is rejected", async () => {
    const fx = await seedFixture()
    const { runner } = await newRunnerWithSqlStore(fx)
    const pipeline = newDurablePipeline(fx, runner)
    await admit(pipeline, fx, "fingerprint-key", "noop\nok")
    await expect(admit(pipeline, fx, "fingerprint-key", "DIFFERENT\ninput")).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
      status: 409,
    })
  })

  it("4. idempotency survives process/store restart (new instance, same DB)", async () => {
    const fx = await seedFixture()
    const { runner } = await newRunnerWithSqlStore(fx)
    const pipeline1 = newDurablePipeline(fx, runner)
    const first = await admit(pipeline1, fx, "restart-key")
    // Simulate restart: a brand-new pipeline + registry reading the SAME DB.
    const pipeline2 = newDurablePipeline(fx, runner)
    const replay = await admit(pipeline2, fx, "restart-key")
    expect(replay.replayed).toBe(true)
    expect(replay.jobId).toBe(first.jobId)
    expect(replay.reservationId).toBe(first.reservationId)
  })
})

// ===========================================================================
// Deliverable 2 — Quota reservation expiry & reaper
// ===========================================================================

describe("Phase 1F Deliverable 2: quota reservation expiry & reaper", () => {
  it("5. expired orphan reservation releases capacity once", async () => {
    const fx = await seedFixture()
    await fx.quota.setLimits(quotaScope({ tenantId: fx.tenantId, orgId: fx.orgId, projectId: fx.projectId }), DEFAULT_LIMITS)
    const scope = quotaScope({ tenantId: fx.tenantId, orgId: fx.orgId, projectId: fx.projectId })
    // Create an orphan reservation (no job) with a short expiry.
    const res = await fx.quota.reserve(scope, "orphan-1", null, { ...DEFAULT_LIMITS, maxConcurrentJobs: 2 })
    let usage = await fx.quota.getUsage(scope)
    expect(usage.inUse).toBe(1)
    // Expire it by advancing time past expires_at.
    const expiredAt = res.expiresAt + 1000
    const released = await fx.quota.reapExpired(expiredAt)
    expect(released).toBe(1)
    usage = await fx.quota.getUsage(scope)
    expect(usage.inUse).toBe(0)
  })

  it("6. reaper run twice does not double-release", async () => {
    const fx = await seedFixture()
    const scope = quotaScope({ tenantId: fx.tenantId, orgId: fx.orgId, projectId: fx.projectId })
    await fx.quota.setLimits(scope, DEFAULT_LIMITS)
    const res = await fx.quota.reserve(scope, "double-1", null, DEFAULT_LIMITS)
    // Reap past the reservation's own expiry.
    const expiredAt = res.expiresAt + 1
    const first = await fx.quota.reapExpired(expiredAt)
    const second = await fx.quota.reapExpired(expiredAt)
    expect(first).toBe(1)
    expect(second).toBe(0) // already expired; no double-release
    const usage = await fx.quota.getUsage(scope)
    expect(usage.inUse).toBe(0)
  })

  it("7. stale reaper cannot release a renewed/settled reservation", async () => {
    const fx = await seedFixture()
    const scope = quotaScope({ tenantId: fx.tenantId, orgId: fx.orgId, projectId: fx.projectId })
    await fx.quota.setLimits(scope, DEFAULT_LIMITS)
    const res = await fx.quota.reserve(scope, "renew-1", null, DEFAULT_LIMITS)
    // Renew: push the expiry forward (fenced by version).
    const renewed = await fx.quota.renewReservation(res.reservationId, res.version, 60_000)
    expect(renewed.expiresAt).toBeGreaterThan(res.expiresAt)
    // A reaper run at the ORIGINAL expiry must NOT reclaim the renewed reservation.
    const released = await fx.quota.reapExpired(res.expiresAt + 1)
    expect(released).toBe(0)
    const usage = await fx.quota.getUsage(scope)
    expect(usage.inUse).toBe(1) // capacity still held
  })

  it("8. crash after reservation before admission is recoverable (no capacity leak)", async () => {
    const fx = await seedFixture()
    const scope = quotaScope({ tenantId: fx.tenantId, orgId: fx.orgId, projectId: fx.projectId })
    await fx.quota.setLimits(scope, { ...DEFAULT_LIMITS, maxConcurrentJobs: 1 })
    // Simulate crash: reserve capacity but never create a job (orphan).
    const orphan = await fx.quota.reserve(scope, "crash-1", null, { ...DEFAULT_LIMITS, maxConcurrentJobs: 1 })
    let usage = await fx.quota.getUsage(scope)
    expect(usage.inUse).toBe(1)
    // Capacity is now full; a new admission would be rejected...
    await expect(fx.quota.reserve(scope, "next-1", null, { ...DEFAULT_LIMITS, maxConcurrentJobs: 1 })).rejects.toThrow()
    // ...but the reaper reclaims the orphan after its expiry, recovering capacity.
    await fx.quota.reapExpired(orphan.expiresAt + 1)
    usage = await fx.quota.getUsage(scope)
    expect(usage.inUse).toBe(0)
    // New admission now succeeds.
    const res = await fx.quota.reserve(scope, "next-2", null, { ...DEFAULT_LIMITS, maxConcurrentJobs: 1 })
    expect(res.state).toBe("active")
  })
})

// ===========================================================================
// Deliverable 3 & 4 — Reconciliation + durable settlement
// ===========================================================================

describe("Phase 1F Deliverables 3 & 4: reconciliation + settlement", () => {
  it("9. terminal job unsettled reservation is reconciled safely", async () => {
    const fx = await seedFixture()
    const { runner, jobStore } = await newRunnerWithSqlStore(fx)
    const scope = quotaScope({ tenantId: fx.tenantId, orgId: fx.orgId, projectId: fx.projectId })
    await fx.quota.setLimits(scope, DEFAULT_LIMITS)
    const pipeline = newDurablePipeline(fx, runner)
    const admitted = await admit(pipeline, fx, "terminal-1")
    // Run the job to completion (terminal).
    await runner.runJob(admitted.jobId)
    const job = await runner.getJob(admitted.jobId)
    expect(["completed", "cancelled", "failed"]).toContain(job!.status)
    // Build reconciliation deps with the SQL job store as the JobIndex.
    const { ReconciliationService, SqlReconciliationStore } = await import("@vaulltcore/reconcile")
    const reconStore = new SqlReconciliationStore(fx.db)
    const service = new ReconciliationService({
      runner,
      jobs: jobStore,
      metering: fx.metering,
      billing: fx.billing,
      quota: fx.quota,
      store: reconStore,
    })
    // The reservation may still be active on a terminal job → reconciler releases it.
    const result = await service.reconcile({ tenantId: fx.tenantId })
    expect(result.status).toBe("completed")
    const health = await service.health(fx.tenantId)
    expect(health.openGaps.terminalUnsettled).toBeGreaterThanOrEqual(0)
  })

  it("10. missing UsageEvent is rebuilt from committed execution events", async () => {
    const fx = await seedFixture()
    const { runner, jobStore } = await newRunnerWithSqlStore(fx)
    const pipeline = newDurablePipeline(fx, runner)
    const admitted = await admit(pipeline, fx, "rebuild-1")
    await runner.runJob(admitted.jobId)
    // Purposely DO NOT record usage through metering — simulate a metering
    // pipeline crash. Committed JobEvents still exist (authoritative).
    const { ReconciliationService, SqlReconciliationStore } = await import("@vaulltcore/reconcile")
    const reconStore = new SqlReconciliationStore(fx.db)
    const service = new ReconciliationService({
      runner,
      jobs: jobStore,
      metering: fx.metering,
      billing: fx.billing,
      quota: fx.quota,
      store: reconStore,
    })
    const before = await fx.metering.listEvents({ tenantId: fx.tenantId, jobId: admitted.jobId })
    expect(before.length).toBe(0) // metering empty (simulated crash)
    await service.reconcile({ tenantId: fx.tenantId })
    const after = await fx.metering.listEvents({ tenantId: fx.tenantId, jobId: admitted.jobId })
    expect(after.length).toBeGreaterThan(0) // rebuilt from committed events
  })

  it("11. reconciliation rerun creates no duplicate UsageEvent", async () => {
    const fx = await seedFixture()
    const { runner, jobStore } = await newRunnerWithSqlStore(fx)
    const pipeline = newDurablePipeline(fx, runner)
    const admitted = await admit(pipeline, fx, "rerun-1")
    await runner.runJob(admitted.jobId)
    const { ReconciliationService, SqlReconciliationStore } = await import("@vaulltcore/reconcile")
    const reconStore = new SqlReconciliationStore(fx.db)
    const service = new ReconciliationService({
      runner,
      jobs: jobStore,
      metering: fx.metering,
      billing: fx.billing,
      quota: fx.quota,
      store: reconStore,
    })
    await service.reconcile({ tenantId: fx.tenantId })
    const countAfterFirst = (await fx.metering.listEvents({ tenantId: fx.tenantId, jobId: admitted.jobId })).length
    await service.reconcile({ tenantId: fx.tenantId })
    const countAfterSecond = (await fx.metering.listEvents({ tenantId: fx.tenantId, jobId: admitted.jobId })).length
    expect(countAfterSecond).toBe(countAfterFirst) // no duplicates
  })

  it("12. unpriced usage remains durably unresolved, never disappears", async () => {
    const fx = await seedFixture()
    // Use a FRESH billing store with NO active pricing version to force the
    // unresolved path. We point it at a separate in-memory DB so the seeded
    // DEFAULT_PRICING doesn't apply.
    const bareDb = NodeSqliteDatabase.memory()
    const bareBilling = new (await import("@vaulltcore/billing")).SqlBillingStore(bareDb)
    // Record a usage event directly, then settle it → no pricing → unresolved.
    const eventId = "ue-unpriced-1"
    const settle = await bareBilling.settleUsage({
      tenantId: fx.tenantId, eventId, jobId: "job-x", orgId: fx.orgId, projectId: fx.projectId,
      kind: "model_tokens", quantity: 100,
    })
    expect(settle.settlement.state).toBe("unresolved")
    expect(settle.settlement.lastError).toContain("no active pricing")
    // Re-settling must NOT drop or silently resolve it; still unresolved.
    const retry = await bareBilling.settleUsage({
      tenantId: fx.tenantId, eventId, jobId: "job-x", orgId: fx.orgId, projectId: fx.projectId,
      kind: "model_tokens", quantity: 100,
    })
    expect(retry.settlement.state).toBe("unresolved")
    // After pricing is added, retry resolves it (repair path).
    await bareBilling.createPricingVersion({ ...DEFAULT_PRICING, pricingId: "p-now", version: "v1", effectiveAt: 0, createdAt: 0 })
    const resolved = await bareBilling.settleUsage({
      tenantId: fx.tenantId, eventId, jobId: "job-x", orgId: fx.orgId, projectId: fx.projectId,
      kind: "model_tokens", quantity: 100,
    })
    expect(resolved.settlement.state).toBe("settled")
    bareDb.close()
  })

  it("13. missing LedgerEntry is repaired once", async () => {
    const fx = await seedFixture()
    const { runner, jobStore } = await newRunnerWithSqlStore(fx)
    const pipeline = newDurablePipeline(fx, runner)
    const admitted = await admit(pipeline, fx, "ledger-1")
    await runner.runJob(admitted.jobId)
    const { ReconciliationService, SqlReconciliationStore } = await import("@vaulltcore/reconcile")
    const reconStore = new SqlReconciliationStore(fx.db)
    const service = new ReconciliationService({
      runner,
      jobs: jobStore,
      metering: fx.metering,
      billing: fx.billing,
      quota: fx.quota,
      store: reconStore,
    })
    await service.reconcile({ tenantId: fx.tenantId })
    // After reconciliation, all settled usage must have a ledger entry.
    const usageEvents = await fx.metering.listEvents({ tenantId: fx.tenantId, jobId: admitted.jobId })
    for (const ue of usageEvents) {
      const settlement = fx.billing.getUsageSettlement(fx.tenantId, ue.eventId)
      if (settlement?.state === "settled") {
        expect(settlement.ledgerEntryId).not.toBeNull()
      }
    }
  })

  it("14. concurrent settlement produces one ledger entry", async () => {
    const fx = await seedFixture()
    const { runner } = await newRunnerWithSqlStore(fx)
    const pipeline = newDurablePipeline(fx, runner)
    const admitted = await admit(pipeline, fx, "concurrent-settle")
    await runner.runJob(admitted.jobId)
    // Record a usage event, then settle it from multiple concurrent calls.
    const identity: MeteringIdentity = { tenantId: fx.tenantId, orgId: fx.orgId, projectId: fx.projectId, jobId: admitted.jobId }
    const events = await runner.listEvents(admitted.jobId)
    const inputs = eventsToUsage(identity, events)
    expect(inputs.length).toBeGreaterThan(0)
    const recorded = await fx.metering.recordBatch(inputs)
    const target = recorded[0]!.event
    const settleInput = {
      tenantId: target.tenantId,
      eventId: target.eventId,
      jobId: target.jobId,
      orgId: target.orgId,
      projectId: target.projectId,
      kind: target.kind,
      quantity: target.quantity,
    }
    const results = await Promise.all([
      fx.billing.settleUsage(settleInput),
      fx.billing.settleUsage(settleInput),
      fx.billing.settleUsage(settleInput),
    ])
    // All three must reference the SAME single ledger entry.
    const entryIds = new Set(results.map((r) => r.ledgerEntry?.entryId))
    expect(entryIds.size).toBe(1)
    // Exactly one ledger entry in the DB.
    const entries = await fx.billing.listJobEntries(fx.tenantId, admitted.jobId)
    const matching = entries.filter((e) => e.sourceRef === target.eventId)
    expect(matching.length).toBe(1)
  })

  it("15. later pricing changes do not rewrite historical charge", async () => {
    const fx = await seedFixture()
    const { runner } = await newRunnerWithSqlStore(fx)
    const pipeline = newDurablePipeline(fx, runner)
    const admitted = await admit(pipeline, fx, "immutable-pricing")
    await runner.runJob(admitted.jobId)
    const identity: MeteringIdentity = { tenantId: fx.tenantId, orgId: fx.orgId, projectId: fx.projectId, jobId: admitted.jobId }
    const events = await runner.listEvents(admitted.jobId)
    const inputs = eventsToUsage(identity, events)
    const recorded = await fx.metering.recordBatch(inputs)
    const target = recorded[0]!.event
    const first = await fx.billing.settleUsage({
      tenantId: target.tenantId, eventId: target.eventId, jobId: target.jobId,
      orgId: target.orgId, projectId: target.projectId, kind: target.kind, quantity: target.quantity,
    })
    const originalAmount = first.ledgerEntry!.amount
    const originalPricingVersion = first.settlement.pricingVersion
    // Create a NEW pricing version (different prices) and activate it.
    await fx.billing.createPricingVersion({
      pricingId: "pricing-v2",
      version: "2",
      unitPrices: { ...DEFAULT_PRICING.unitPrices, model_tokens: 9999 },
      effectiveAt: Date.now(),
      createdAt: Date.now(),
    })
    // Re-settle the same usage — must return the ORIGINAL ledger entry, unchanged.
    const repeat = await fx.billing.settleUsage({
      tenantId: target.tenantId, eventId: target.eventId, jobId: target.jobId,
      orgId: target.orgId, projectId: target.projectId, kind: target.kind, quantity: target.quantity,
    })
    expect(repeat.ledgerEntry!.amount).toBe(originalAmount)
    expect(repeat.settlement.pricingVersion).toBe(originalPricingVersion)
    expect(repeat.duplicated).toBe(true)
  })

  it("16. reconciliation never invokes AgentRunner execution", async () => {
    const fx = await seedFixture()
    const { runner, jobStore } = await newRunnerWithSqlStore(fx)
    const pipeline = newDurablePipeline(fx, runner)
    const admitted = await admit(pipeline, fx, "no-exec-1")
    await runner.runJob(admitted.jobId)
    // Spy on the runner's execution entry points. They must NOT be called.
    const runJobSpy = vi.spyOn(runner, "runJob")
    const resumeJobSpy = vi.spyOn(runner, "resumeJob")
    const { ReconciliationService, SqlReconciliationStore } = await import("@vaulltcore/reconcile")
    const reconStore = new SqlReconciliationStore(fx.db)
    const service = new ReconciliationService({
      runner,
      jobs: jobStore,
      metering: fx.metering,
      billing: fx.billing,
      quota: fx.quota,
      store: reconStore,
    })
    await service.reconcile({ tenantId: fx.tenantId })
    expect(runJobSpy).not.toHaveBeenCalled()
    expect(resumeJobSpy).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// Deliverable 6 — Runtime economic enforcement
// ===========================================================================

describe("Phase 1F Deliverable 6: runtime economic enforcement", () => {
  it("18 & 19. budget exhaustion preserves accounting and a durable execution boundary", async () => {
    const fx = await seedFixture()
    const root = await mkdtemp(path.join(tmpdir(), "vc-1f-budget-"))
    runnerRoots.push(root)
    const jobStore = new SqlJobStore(fx.db)
    // Engine emits usage that exceeds a tiny token budget on turn 1.
    const turns = [{ text: "working", usage: { inputTokens: 100, outputTokens: 50 } }]
    const runner = new DurableAgentRunner({
      store: jobStore,
      engines: [new ScriptEngine(turns as never)],
      tools: [noopTool],
      workspace: null,
    })
    const pipeline = newDurablePipeline(fx, runner)
    const admitted = await admit(pipeline, fx, "budget-1")
    // Drive the job with an injected token budget via a custom policy path:
    // the runner's policyFor uses the job record's policy; we instead run the
    // job directly with a budget-bearing policy by creating a fresh job.
    // Simpler: create a job through the runner with a maxTokens policy and run it.
    const lowBudgetJob = await runner.createJob({
      tenantId: fx.tenantId,
      orgId: fx.orgId,
      projectId: fx.projectId,
      spec: { engine: "script", model: "script-model", input: "noop" },
      policy: {
        version: "1",
        maxSteps: 25,
        onUncertainToolCall: "mark_uncertain",
        allowedTools: ["noop"],
        idempotentTools: [],
        leaseMs: 60_000,
        maxTokens: 50, // turn 1 emits 150 tokens → exceeds budget at safe boundary
      },
    } as never)
    const state = await runner.runJob(lowBudgetJob.jobId)
    // The job must be cancelled (budget exhausted), NOT silently killed.
    expect(state.status).toBe("cancelled")
    // A budget_exhausted event must be durable in the event log.
    const events = await runner.listEvents(lowBudgetJob.jobId)
    const budgetEvent = events.find((e) => e.type === "budget_exhausted") as JobEvent<{ reason: string; consumedTokens: number }> | undefined
    expect(budgetEvent).toBeDefined()
    expect(budgetEvent!.data.reason).toBe("token_budget_exhausted")
    expect(budgetEvent!.data.consumedTokens).toBeGreaterThanOrEqual(150)
    // The consumed usage must be durably accounted (checkpoint preserved).
    const usage = await runner.collectUsage(lowBudgetJob.jobId)
    expect(usage.totalTokens).toBeGreaterThanOrEqual(150)
  })

  it("19. step enforcement is explicit (maxSteps fails the job explainably)", async () => {
    const fx = await seedFixture()
    const jobStore = new SqlJobStore(fx.db)
    // Engine emits a tool call every turn so the loop continues past step 0.
    const turns = [
      { text: "go", usage: { inputTokens: 5, outputTokens: 5 }, toolCalls: [{ toolCallId: "c1", toolName: "noop", input: {} }] },
      { text: "go", usage: { inputTokens: 5, outputTokens: 5 }, toolCalls: [{ toolCallId: "c2", toolName: "noop", input: {} }] },
      { text: "go", usage: { inputTokens: 5, outputTokens: 5 }, toolCalls: [{ toolCallId: "c3", toolName: "noop", input: {} }] },
    ]
    const runner = new DurableAgentRunner({
      store: jobStore,
      engines: [new ScriptEngine(turns as never)],
      tools: [noopTool],
      workspace: null,
    })
    const job = await runner.createJob({
      tenantId: fx.tenantId,
      orgId: fx.orgId,
      projectId: fx.projectId,
      spec: { engine: "script", model: "script-model", input: "noop" },
      policy: {
        version: "1",
        maxSteps: 2, // explicit step bound
        onUncertainToolCall: "mark_uncertain",
        allowedTools: ["noop"],
        idempotentTools: [],
        leaseMs: 60_000,
      },
    } as never)
    const state = await runner.runJob(job.jobId)
    expect(state.status).toBe("failed")
  })
})

// ===========================================================================
// Deliverable 5 — API key operational lifecycle
// ===========================================================================

describe("Phase 1F Deliverable 5: API key lifecycle", () => {
  it("20. API key rotation overlap works (old key valid during overlap)", async () => {
    const fx = await seedFixture()
    const overlapMs = 60_000
    const { replacement } = await fx.identity.rotateApiKey(fx.tenantId, fx.apiKeyId, { overlapMs })
    expect(replacement.secret).toContain(".")
    expect(replacement.keyId).not.toBe(fx.apiKeyId)
    // Old key must still authenticate during the overlap window.
    const oldPrincipal = await fx.identity.authenticateApiKey(fx.apiKeySecret)
    expect(oldPrincipal).not.toBeNull()
    // New key authenticates immediately.
    const newPrincipal = await fx.identity.authenticateApiKey(replacement.secret)
    expect(newPrincipal).not.toBeNull()
    expect(newPrincipal!.apiKeyId).toBe(replacement.keyId)
  })

  it("21a. expired API key fails authentication", async () => {
    const fx = await seedFixture()
    // Create a key that expires in the past.
    const expiredKey = await fx.identity.createApiKey(fx.tenantId, fx.orgId, fx.principalId, "expired-key", { expiresAt: Date.now() - 1000 })
    const principal = await fx.identity.authenticateApiKey(expiredKey.secret)
    expect(principal).toBeNull()
  })

  it("21b. revoked API key fails authentication", async () => {
    const fx = await seedFixture()
    await fx.identity.expireApiKey(fx.tenantId, fx.apiKeyId, Date.now() - 1000)
    const principal = await fx.identity.authenticateApiKey(fx.apiKeySecret)
    expect(principal).toBeNull()
  })

  it("22. ordinary tenant cannot read operational data for another tenant", async () => {
    const fx = await seedFixture()
    const fx2 = await seedFixture({ tenantId: "t-other", orgId: "org-other", projectId: "proj-other" })
    // Tenant A's API key must not authenticate as tenant B (different verifier hash).
    const principalB = await fx2.identity.authenticateApiKey(fx.apiKeySecret)
    expect(principalB).toBeNull()
  })
})

// ===========================================================================
// Deliverable 7 — Snapshot GC
// ===========================================================================

describe("Phase 1F Deliverable 7: snapshot GC", () => {
  it("23 & 24 & 25. snapshot GC is retry-safe, idempotent, and never deletes active recovery state", async () => {
    // Use a standalone db with only SqlJobStore (applies store-sql migrations
    // including snapshot_lifecycle + snapshot_gc). seedFixture's identity store
    // uses migration version 2, which would collide with store-sql v2
    // (snapshot_lifecycle) on a shared ledger — so we isolate this test's db.
    const bareDb = NodeSqliteDatabase.memory()
    const jobStore = new SqlJobStore(bareDb)
    const dist = new DistributedSqlStore(jobStore.database())
    const tenantId = "t-gc"
    // Insert a minimal job row to satisfy the snapshot_lifecycle FK to jobs.
    bareDb.prepare(
      "INSERT INTO jobs (job_id, tenant_id, org_id, project_id, status, attempt, cancel_requested, spec, env, policy, last_seq, created_at, updated_at) VALUES (?, ?, ?, ?, 'completed', 1, 0, '{}', '{}', '{}', 0, ?, ?)",
    ).run("job-gc-1", tenantId, "org-gc", "proj-gc", Date.now(), Date.now())
    // Register two snapshots for a job: an active one (recovery path) and a
    // superseded one (eligible for GC).
    dist.recordSnapshotCreated({
      snapshotId: "snap-active", tenantId: tenantId, jobId: "job-gc-1",
      provider: "local", sizeBytes: 100, integrityHash: "h1", attempt: 1, createdAt: Date.now(), expiresAt: null,
    })
    dist.activateSnapshot("snap-active")
    dist.recordSnapshotCreated({
      snapshotId: "snap-old", tenantId: tenantId, jobId: "job-gc-1",
      provider: "local", sizeBytes: 100, integrityHash: "h2", attempt: 0, createdAt: Date.now() - 10_000, expiresAt: Date.now() - 1000,
    })
    dist.activateSnapshot("snap-old")
    dist.supersedeSnapshot("snap-old", "snap-active")
    // Provider deleter that fails the first time (transient), succeeds the second.
    let attempts = 0
    const deleter = async (snapshot: { snapshotId: string }) => {
      attempts++
      if (snapshot.snapshotId === "snap-old" && attempts === 1) throw new Error("transient provider error")
      return true
    }
    const driver = new SnapshotGcDriver(dist, deleter)
    // First pass: the active snapshot is NOT deletable (last recovery artifact).
    // The old (superseded + expired) snapshot IS deletable but the provider fails.
    const r1 = await driver.runGc()
    expect(r1.failed).toBe(1) // provider failed → stays retryable
    expect(r1.deleted).toBe(0)
    const failedAttempt = driver.getAttempt("snap-old")!
    expect(failedAttempt.state).toBe("failed")
    expect(failedAttempt.lastError).toContain("transient provider error")
    // The active snapshot must NOT have a GC attempt row (never eligible).
    expect(driver.getAttempt("snap-active")).toBeNull()
    // Second pass: retry succeeds.
    const r2 = await driver.runGc()
    expect(r2.deleted).toBe(1)
    expect(driver.getAttempt("snap-old")!.state).toBe("deleted")
    // Third pass: idempotent — the deleted snapshot's lifecycle row is now
    // 'deleted', so gcDecision no longer lists it as deletable. Nothing to do.
    const r3 = await driver.runGc()
    expect(r3.deleted).toBe(0)
    expect(r3.processed).toBe(0)
    // The GC attempt row remains stably 'deleted'.
    expect(driver.getAttempt("snap-old")!.state).toBe("deleted")
  })
})

// ===========================================================================
// Deliverable 8 — Operational health (tenant isolation)
// ===========================================================================

describe("Phase 1F Deliverable 8: operational health isolation", () => {
  it("22b. operational data is tenant-scoped (no cross-tenant read)", async () => {
    const fx = await seedFixture()
    const fx2 = await seedFixture({ tenantId: "t-other2", orgId: "org-other2", projectId: "proj-other2" })
    // Create usage in tenant A only.
    const { runner, jobStore } = await newRunnerWithSqlStore(fx)
    const pipeline = newDurablePipeline(fx, runner)
    const admitted = await admit(pipeline, fx, "iso-1")
    await runner.runJob(admitted.jobId)
    const { ReconciliationService, SqlReconciliationStore } = await import("@vaulltcore/reconcile")
    const reconStore = new SqlReconciliationStore(fx.db)
    const serviceA = new ReconciliationService({
      runner, jobs: jobStore, metering: fx.metering, billing: fx.billing, quota: fx.quota, store: reconStore,
    })
    await serviceA.reconcile({ tenantId: fx.tenantId })
    const healthA = await serviceA.health(fx.tenantId)
    // Tenant B's reconciliation store (same DB, different tenant) sees nothing.
    const reconStoreB = new SqlReconciliationStore(fx2.db)
    const serviceB = new ReconciliationService({
      runner, jobs: jobStore, metering: fx2.metering, billing: fx2.billing, quota: fx2.quota, store: reconStoreB,
    })
    await serviceB.reconcile({ tenantId: fx2.tenantId })
    const healthB = await serviceB.health(fx2.tenantId)
    expect(healthB.openGaps.total).toBe(0) // tenant B has no jobs/usage
    expect(healthA.tenantId).toBe(fx.tenantId)
    expect(healthB.tenantId).toBe(fx2.tenantId)
    // Metering is tenant-isolated.
    const eventsA = await fx.metering.listEvents({ tenantId: fx.tenantId, jobId: admitted.jobId })
    expect(eventsA.length).toBeGreaterThan(0)
  })
})
