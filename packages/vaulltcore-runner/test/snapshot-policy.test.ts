/**
 * Phase 1C cost-aware snapshot policy proof. Unit-level: the threshold policy
 * chooses logical_checkpoint_only / defer / skip / snapshot_now deterministically.
 * Integration-level: the decision lands as an observable sanitized event and
 * never suppresses checkpoint durability.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  DurableAgentRunner,
  FileJobStore,
  LocalExecutionEnvironment,
  ScriptEngine,
  SimulatedCrashError,
  ThresholdSnapshotPolicy,
  type ExecutionCapabilities,
  type JobEvent,
  type SnapshotFacts,
  type Tool,
} from "../src/index"

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vaulltcore-policy-test-"))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const NO_CAP: ExecutionCapabilities = { nativeSuspend: true, nativeSnapshot: false, nativeRestore: true, durableWorkspace: true }
const FULL: ExecutionCapabilities = { nativeSuspend: true, nativeSnapshot: true, nativeRestore: true, durableWorkspace: true }

function facts(overrides: Partial<SnapshotFacts> = {}): SnapshotFacts {
  return {
    elapsedMs: 60_000,
    stepsSinceLastSnapshot: 0,
    cumulativeTokens: 100,
    workspaceBytes: null,
    lastSnapshot: null,
    capabilities: FULL,
    suspensionRisk: "none",
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Policy unit decisions
// ---------------------------------------------------------------------------

describe("ThresholdSnapshotPolicy — decisions", () => {
  it("22. a cheap/short job chooses logical checkpoint only", () => {
    const policy = new ThresholdSnapshotPolicy()
    const decision = policy.decide(facts({ cumulativeTokens: 100 }))
    expect(decision.decision).toBe("logical_checkpoint_only")
    expect(decision.reason).toMatch(/cheap-job floor/)
    expect(decision.estimate).not.toBeNull()
  })

  it("23. an expensive long-running job triggers a snapshot", () => {
    const policy = new ThresholdSnapshotPolicy()
    const decision = policy.decide(facts({ cumulativeTokens: 1_000_000 }))
    expect(decision.decision).toBe("snapshot_now")
    expect(decision.reason).toMatch(/meets threshold/)
  })

  it("24. missing native snapshot/restore capability yields an explicit fallback decision", () => {
    const policy = new ThresholdSnapshotPolicy()
    const missing = policy.decide(facts({ capabilities: NO_CAP }))
    expect(missing.decision).toBe("logical_checkpoint_only")
    expect(missing.reason).toMatch(/lacks native snapshot/)
    const missingRestore = policy.decide(
      facts({ capabilities: { ...FULL, nativeRestore: false } }),
    )
    expect(missingRestore.decision).toBe("logical_checkpoint_only")
    expect(missingRestore.reason).toMatch(/lacks native restore/)
  })

  it("defers while a fresh snapshot is attached and too few steps accrued", () => {
    const policy = new ThresholdSnapshotPolicy({ minStepsBetweenSnapshots: 10 })
    const decision = policy.decide(facts({ cumulativeTokens: 1_000_000, stepsSinceLastSnapshot: 3, lastSnapshot: { durationMs: 1, costUsd: 0 } }))
    expect(decision.decision).toBe("defer")
    expect(decision.reason).toMatch(/only 3 committed/)
  })

  it("an eviction signal discounts the threshold (snapshot sooner)", () => {
    // resumeValue $1.2 default; threshold is $1.0, discount multiplies to
    // $0.25 under high risk — so a $0.30 resume value becomes snapshot-worthy.
    const policy = new ThresholdSnapshotPolicy({ snapshotThresholdUsd: 1.0, evictionRiskDiscount: 0.25 })
    const low = policy.decide(facts({ cumulativeTokens: 150_000, suspensionRisk: "none" }))
    expect(low.decision).toBe("skip")
    const high = policy.decide(facts({ cumulativeTokens: 150_000, suspensionRisk: "high" }))
    expect(high.decision).toBe("snapshot_now")
    expect(high.reason).toMatch(/eviction risk discount/)
  })

  it("skips (but never lies) when value sits between floor and threshold", () => {
    // 60k tokens × $2e-6 = $0.12: above the $0.05 floor, below the $1.0 threshold.
    const policy = new ThresholdSnapshotPolicy()
    const decision = policy.decide(facts({ cumulativeTokens: 60_000, suspensionRisk: "none" }))
    expect(decision.decision).toBe("skip")
    expect(decision.reason).toMatch(/below threshold/)
  })
})

// ---------------------------------------------------------------------------
// Integration: the decision lands as an observable event; durability preserved
// ---------------------------------------------------------------------------

const noopTool: Tool = {
  definition: { name: "noop", description: "nope", parameters: { type: "object" } },
  async execute() {
    return { ok: true }
  },
}
const NOOP_POLICY = { allowedTools: ["noop"], idempotentTools: ["noop"] }
const IDENTITY = { tenantId: "tenant-p", orgId: "org-p", projectId: "project-p" }

function makeEnvironmentRig(tokens: { inputTokens: number; outputTokens: number }, snapshotPolicy?: ThresholdSnapshotPolicy) {
  const store = new FileJobStore(path.join(root, "store"))
  const environment = new LocalExecutionEnvironment(path.join(root, "env"))
  const runner = new DurableAgentRunner({
    store,
    engines: [
      new ScriptEngine(
        [
          { text: "step-0", toolCalls: [{ toolName: "noop" }], usage: tokens },
          { text: "step-1", usage: {} },
        ],
        { onTurnStart: (step) => { if (step === 1) throw new SimulatedCrashError() } },
      ),
    ],
    tools: [noopTool],
    workspace: null,
    environment,
    snapshotPolicy,
  })
  return { store, runner }
}

async function findDecisionEvent(store: FileJobStore, jobId: string): Promise<JobEvent | undefined> {
  const events = await store.listEvents(jobId)
  return events.find((event) => event.type === "warning" && (event.data as { reason?: string }).reason === "snapshot_decision")
}

describe("threshold policy integrated into suspension boundaries", () => {
  it("22i. cheap suspend captures nothing and emits the decision event", async () => {
    const policy = new ThresholdSnapshotPolicy()
    const { store, runner } = makeEnvironmentRig({ inputTokens: 3, outputTokens: 2 }, policy)
    const record = await runner.createJob({ ...IDENTITY, spec: { engine: "script", model: "m", input: "go" }, policy: NOOP_POLICY })
    await expect(runner.runJob(record.jobId)).rejects.toThrow(SimulatedCrashError)
    await runner.suspendJob(record.jobId, "worker_loss")

    const decisionEvent = await findDecisionEvent(store, record.jobId)
    expect(decisionEvent).toBeDefined()
    expect((decisionEvent!.data as { decision: string }).decision).toBe("logical_checkpoint_only")
    expect((await store.getJobRecord(record.jobId))!.latestSnapshot).toBeNull()
  })

  it("23i. expensive suspend captures the compute snapshot", async () => {
    const policy = new ThresholdSnapshotPolicy()
    const { store, runner } = makeEnvironmentRig({ inputTokens: 600_000, outputTokens: 400_000 }, policy)
    const record = await runner.createJob({ ...IDENTITY, spec: { engine: "script", model: "m", input: "go" }, policy: NOOP_POLICY })
    await expect(runner.runJob(record.jobId)).rejects.toThrow(SimulatedCrashError)
    await runner.suspendJob(record.jobId, "worker_loss")

    const decisionEvent = await findDecisionEvent(store, record.jobId)
    expect((decisionEvent!.data as { decision: string }).decision).toBe("snapshot_now")
    const attached = (await store.getJobRecord(record.jobId))!.latestSnapshot
    expect(attached).not.toBeNull()
    expect(attached!.storage.kind).toBe("local-directory")

    // The suspended warning reports the captured snapshot id honestly.
    const events = await store.listEvents(record.jobId)
    const suspendedEvent = events.find((event) => event.type === "warning" && (event.data as { reason?: string }).reason === "suspended")
    expect((suspendedEvent!.data as { snapshotId: string }).snapshotId).toBe(attached!.snapshotId)
  })

  it("25. a skip decision suppresses nothing: checkpoint durability is unaffected", async () => {
    // 60k tokens → $0.12: above the $0.01 floor, below the $10 threshold → skip.
    const policy = new ThresholdSnapshotPolicy({ cheapJobFloorUsd: 0.01, snapshotThresholdUsd: 10.0 })
    const { store, runner } = makeEnvironmentRig({ inputTokens: 30_000, outputTokens: 30_000 }, policy)
    const record = await runner.createJob({ ...IDENTITY, spec: { engine: "script", model: "m", input: "go" }, policy: NOOP_POLICY })
    await expect(runner.runJob(record.jobId)).rejects.toThrow(SimulatedCrashError)
    await runner.suspendJob(record.jobId, "worker_loss")

    // The checkpoint is authoritative and complete despite the skip.
    const checkpoint = await store.getCheckpoint(record.jobId)
    expect(checkpoint).not.toBeNull()
    expect(checkpoint!.lastEventSeq).toBeGreaterThan(0)

    // A fresh runner still resumes from the checkpoint (no snapshot needed).
    const store2 = new FileJobStore(path.join(root, "store"))
    const fresh = new DurableAgentRunner({
      store: store2,
      engines: [new ScriptEngine([{ text: "step-0", toolCalls: [{ toolName: "noop" }], usage: {} }, { text: "step-1", usage: {} }])],
      tools: [noopTool],
      workspace: null,
      environment: new LocalExecutionEnvironment(path.join(root, "env")),
      snapshotPolicy: new ThresholdSnapshotPolicy(),
    })
    const resumed = await fresh.resumeJob(record.jobId)
    expect(resumed.status).toBe("completed")
  })
})
