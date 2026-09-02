/**
 * Phase 1A durable-runner proof: the 11 required scenarios.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  DurableAgentRunner,
  FileJobStore,
  IdentityMismatchError,
  InvalidCheckpointError,
  JOB_EVENT_TYPES,
  LocalWorkspaceProvider,
  SimulatedCrashError,
  ScriptEngine,
  ScriptTurn,
  Tool,
  finalizeCheckpoint,
  type ExecutionPolicy,
  type JobCheckpoint,
  type JobEvent,
} from "../src/index"

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vaulltcore-test-"))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const IDENTITY = { tenantId: "tenant-a", orgId: "org-a", projectId: "project-a" }

function countingTool(
  name: string,
  opts: { idempotent?: boolean; crashOnExecution?: number } = {},
): { tool: Tool; executions: () => number; contexts: () => Array<Record<string, unknown>> } {
  let executions = 0
  const contexts: Array<Record<string, unknown>> = []
  return {
    executions: () => executions,
    contexts: () => contexts,
    tool: {
      definition: {
        name,
        description: `${name} tool`,
        parameters: { type: "object", properties: { value: { type: "string" } } },
        ...(opts.idempotent ? { idempotent: true } : {}),
      },
      async execute(input, ctx) {
        executions++
        contexts.push({ idempotencyKey: ctx.idempotencyKey, env: ctx.env, hasWorkspace: ctx.workspace !== null })
        if (opts.crashOnExecution !== undefined && executions === opts.crashOnExecution) throw new SimulatedCrashError()
        return { echoed: input, executions }
      },
    },
  }
}

interface Rig {
  runner: DurableAgentRunner
  store: FileJobStore
  engine: ScriptEngine
  workspace: TrackingWorkspace
}

class TrackingWorkspace extends LocalWorkspaceProvider {
  prepared = 0
  destroyed = 0
  override async prepare(jobId: string) {
    this.prepared++
    return super.prepare(jobId)
  }
  override async destroy(handle: { id: string; root: string | null }) {
    this.destroyed++
    return super.destroy(handle)
  }
}

function makeRig(turns: ScriptTurn[], tools: Tool[], policy: Partial<ExecutionPolicy> = {}, hooks?: ConstructorParameters<typeof ScriptEngine>[1]): Rig {
  const store = new FileJobStore(path.join(root, "store"))
  const engine = new ScriptEngine(turns, hooks)
  const workspace = new TrackingWorkspace(path.join(root, "workspaces"))
  const runner = new DurableAgentRunner({ store, engines: [engine], tools, workspace })
  return { runner, store, engine, workspace }
}

function policyFor(tools: Tool[], extra: Partial<ExecutionPolicy> = {}): Partial<ExecutionPolicy> {
  return {
    allowedTools: tools.map((t) => t.definition.name),
    idempotentTools: tools.filter((t) => t.definition.idempotent).map((t) => t.definition.name),
    ...extra,
  }
}

async function readCheckpoint(store: FileJobStore, jobId: string): Promise<JobCheckpoint> {
  const checkpoint = await store.getCheckpoint(jobId)
  expect(checkpoint).not.toBeNull()
  return checkpoint!
}

async function rewriteCheckpointFile(store: FileJobStore, jobId: string, mutate: (cp: JobCheckpoint) => JobCheckpoint): Promise<void> {
  // Simulates a corrupted/stale writer: rewrite the checkpoint file with a
  // mutated (but checksummed) payload.
  const cp = await readCheckpoint(store, jobId)
  const mutated = finalizeCheckpoint(mutate({ ...cp }))
  const file = path.join(root, "store", jobId, "checkpoint.json")
  const raw = JSON.parse(await readFile(file, "utf8"))
  raw.checkpoint = mutated
  await writeFile(file, JSON.stringify(raw, null, 2))
}

function collect<T>(iterable: AsyncIterable<T>, into: T[]): { done: Promise<void> } {
  const done = (async () => {
    for await (const item of iterable) into.push(item)
  })()
  return { done }
}

async function drainEvents(runner: DurableAgentRunner, jobId: string, afterSeq = 0): Promise<JobEvent[]> {
  const out: JobEvent[] = []
  for await (const e of runner.streamEvents(jobId, afterSeq)) out.push(e)
  return out
}

// ---------------------------------------------------------------------------
// 1–2. Durable progress + multi-step execution
// ---------------------------------------------------------------------------

describe("durable progress and multi-step execution", () => {
  it("1. starts a job and persists durable progress (events + checkpoint)", async () => {
    const { runner, store } = makeRig([{ text: "hello", usage: { inputTokens: 3, outputTokens: 5 } }], [])
    const record = await runner.createJob({ ...IDENTITY, spec: { engine: "script", model: "test-model", input: "do work" } })

    const state = await runner.runJob(record.jobId)
    expect(state.status).toBe("completed")

    // Append-only event log on disk with monotonic seq.
    const events = await store.listEvents(record.jobId)
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1))
    expect(events[0]!.type).toBe("queued")
    expect(events.map((e) => e.type)).toContain("started")
    expect(events.map((e) => e.type)).toContain("checkpoint")
    expect(events[events.length - 1]!.type).toBe("checkpoint")

    // Checkpoint on disk, watermark covering the whole log.
    const checkpoint = await readCheckpoint(store, record.jobId)
    expect(checkpoint.lastEventSeq).toBe(events.length)
    expect(checkpoint.jobId).toBe(record.jobId)
    expect(checkpoint.tenantId).toBe(IDENTITY.tenantId)
    expect(checkpoint.usage.steps).toBe(1)
    expect(checkpoint.usage.inputTokens).toBe(3)
    expect(checkpoint.usage.totalTokens).toBe(8)
    expect(checkpoint.continuation).toEqual({ type: "done" })
    expect(checkpoint.executionId).toMatch(/^exe_/)
    expect(checkpoint.attempt).toBe(1)
  })

  it("2. completes multiple agent/tool steps with committed results", async () => {
    const inspect = countingTool("inspect")
    const { runner, workspace } = makeRig(
      [
        { text: "step-1", toolCalls: [{ toolName: "inspect", input: { value: "a" } }], usage: { inputTokens: 2, outputTokens: 1 } },
        { text: "step-2", toolCalls: [{ toolName: "inspect", input: { value: "b" } }], usage: { inputTokens: 4, outputTokens: 2 } },
        { text: "done", usage: { inputTokens: 6, outputTokens: 3 } },
      ],
      [inspect.tool],
    )
    const record = await runner.createJob({
      ...IDENTITY,
      spec: { engine: "script", model: "test-model", input: "multi-step" },
      policy: policyFor([inspect.tool]),
    })
    const state = await runner.runJob(record.jobId)

    expect(state.status).toBe("completed")
    expect(state.usage.steps).toBe(3)
    expect(state.usage.toolCalls).toBe(2)
    expect(state.usage.inputTokens).toBe(12)
    expect(inspect.executions()).toBe(2)
    expect(inspect.contexts().every((c) => c.hasWorkspace === true)).toBe(true)

    // Tool requests recorded before responses, each result committed.
    const events = await drainEvents(runner, record.jobId)
    const toolRequests = events.filter((e) => e.type === "tool_request")
    const toolResponses = events.filter((e) => e.type === "tool_response")
    expect(toolRequests).toHaveLength(2)
    expect(toolResponses).toHaveLength(2)
    for (const request of toolRequests) {
      const key = (request.data as { idempotencyKey: string }).idempotencyKey
      const response = toolResponses.find((r) => (r.data as { idempotencyKey: string }).idempotencyKey === key)
      expect(response).toBeDefined()
      expect(response!.seq).toBeGreaterThan(request.seq)
    }

    // Workspace disposed on terminal state.
    expect(workspace.prepared).toBe(1)
    expect(workspace.destroyed).toBe(1)

    const usage = await runner.collectUsage(record.jobId)
    expect(usage.totalTokens).toBe(18)
  })

  it("2b. tools never receive the worker's process.env (explicit env only)", async () => {
    process.env.VAULLTCORE_SECRET_MARKER = "worker-secret"
    const inspect = countingTool("inspect")
    const { runner } = makeRig(
      [
        { text: "step", toolCalls: [{ toolName: "inspect", input: {} }] },
        { text: "done" },
      ],
      [inspect.tool],
    )
    const record = await runner.createJob({
      ...IDENTITY,
      spec: { engine: "script", model: "test-model", input: "env" },
      env: { JOB_SCOPED: "yes" },
      policy: policyFor([inspect.tool]),
    })
    await runner.runJob(record.jobId)
    const env = inspect.contexts()[0]!.env as Record<string, string>
    expect(env.JOB_SCOPED).toBe("yes")
    expect(env.VAULLTCORE_SECRET_MARKER).toBeUndefined()
    expect(env.HOME).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 3–7. Crash, resume, no-rerun, result reuse
// ---------------------------------------------------------------------------

describe("worker loss and durable resumption", () => {
  const crashScript = (): ScriptTurn[] => [
    {
      text: "step-0",
      toolCalls: [
        { toolName: "inspect", input: { value: "committed" } },
        { toolName: "charge", input: { value: "interrupted" } },
      ],
      usage: { inputTokens: 10, outputTokens: 5 },
    },
    { text: "final answer", usage: { inputTokens: 7, outputTokens: 4 } },
  ]

  it("3–6. worker dies after a committed step; a fresh runner resumes without rerunning completed steps", async () => {
    // Worker 1: crashes inside the second tool execution of step 0.
    const inspect1 = countingTool("inspect")
    const charge1 = countingTool("charge", { crashOnExecution: 1 })
    const rig1 = makeRig(crashScript(), [inspect1.tool, charge1.tool])
    const record = await rig1.runner.createJob({
      ...IDENTITY,
      spec: { engine: "script", model: "test-model", input: "crash me" },
      policy: policyFor([inspect1.tool, charge1.tool]),
    })

    await expect(rig1.runner.runJob(record.jobId)).rejects.toThrow(SimulatedCrashError)
    expect(inspect1.executions()).toBe(1)
    expect(charge1.executions()).toBe(1)

    // The worker died: the job is NOT failed, it is suspended (supervisor action).
    const afterCrash = await rig1.runner.suspendJob(record.jobId, "worker_loss")
    expect(afterCrash.status).toBe("suspended")
    const checkpoint = await readCheckpoint(rig1.store, record.jobId)
    expect(checkpoint.lastCompletedStep).toMatchObject({ stepIndex: 0 })
    expect(checkpoint.toolCalls["0:call_0_0"]).toMatchObject({ status: "completed" })
    expect(checkpoint.toolCalls["0:call_0_1"]).toMatchObject({ status: "recorded" })

    // Worker 2: brand-new runner instance over the same durable store.
    const inspect2 = countingTool("inspect")
    const charge2 = countingTool("charge")
    const rig2 = makeRig(crashScript(), [inspect2.tool, charge2.tool])
    const resumed = await rig2.runner.resumeJob(record.jobId)

    expect(resumed.status).toBe("completed")
    expect(resumed.attempt).toBe(2)
    // Step 0 was NOT rerun: the engine continued from the checkpoint.
    expect(resumed.usage.steps).toBe(2)
    // Committed tool result reused: inspect never executed on worker 2.
    expect(inspect2.executions()).toBe(0)
    // Interrupted non-idempotent tool: NOT blindly duplicated — marked uncertain.
    expect(charge2.executions()).toBe(0)

    const events = await rig2.store.listEvents(record.jobId)
    expect(events.map((e) => e.type)).toContain("resumed")
    const uncertain = events.find((e) => e.type === "tool_response" && (e.data as { uncertain?: boolean }).uncertain === true)
    expect(uncertain).toBeDefined()
    expect((uncertain!.data as { toolName: string }).toolName).toBe("charge")
    // Event seq remains strictly monotonic across attempts.
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1))
  })

  it("7a. recorded non-idempotent tool call is reconciled as uncertain, never duplicated", async () => {
    const charge1 = countingTool("charge", { crashOnExecution: 1 })
    const rig1 = makeRig(
      [
        { text: "step-0", toolCalls: [{ toolName: "charge", input: { value: "x" } }] },
        { text: "done" },
      ],
      [charge1.tool],
    )
    const record = await rig1.runner.createJob({
      ...IDENTITY,
      spec: { engine: "script", model: "test-model", input: "uncertain" },
      policy: policyFor([charge1.tool], { onUncertainToolCall: "mark_uncertain" }),
    })
    await expect(rig1.runner.runJob(record.jobId)).rejects.toThrow(SimulatedCrashError)
    await rig1.runner.suspendJob(record.jobId)

    const charge2 = countingTool("charge")
    const rig2 = makeRig(
      [
        { text: "step-0", toolCalls: [{ toolName: "charge", input: { value: "x" } }] },
        { text: "done" },
      ],
      [charge2.tool],
    )
    const state = await rig2.runner.resumeJob(record.jobId)
    expect(state.status).toBe("completed")
    expect(charge2.executions()).toBe(0) // side effect not duplicated
    const checkpoint = await readCheckpoint(rig2.store, record.jobId)
    expect(checkpoint.toolCalls["0:call_0_0"]).toMatchObject({ status: "uncertain" })
  })

  it("7b. recorded idempotent tool call is safely re-executed on resume", async () => {
    const charge1 = countingTool("charge", { idempotent: true, crashOnExecution: 1 })
    const rig1 = makeRig(
      [
        { text: "step-0", toolCalls: [{ toolName: "charge", input: { value: "x" } }] },
        { text: "done" },
      ],
      [charge1.tool],
    )
    const record = await rig1.runner.createJob({
      ...IDENTITY,
      spec: { engine: "script", model: "test-model", input: "idempotent" },
      policy: policyFor([charge1.tool]),
    })
    await expect(rig1.runner.runJob(record.jobId)).rejects.toThrow(SimulatedCrashError)
    await rig1.runner.suspendJob(record.jobId)

    const charge2 = countingTool("charge", { idempotent: true })
    const rig2 = makeRig(
      [
        { text: "step-0", toolCalls: [{ toolName: "charge", input: { value: "x" } }] },
        { text: "done" },
      ],
      [charge2.tool],
    )
    const state = await rig2.runner.resumeJob(record.jobId)
    expect(state.status).toBe("completed")
    expect(charge2.executions()).toBe(1) // safe re-execution with same idempotency key
    const checkpoint = await readCheckpoint(rig2.store, record.jobId)
    expect(checkpoint.toolCalls["0:call_0_0"]).toMatchObject({ status: "completed" })
    const events = await rig2.store.listEvents(record.jobId)
    const reconciled = events.find((e) => e.type === "tool_response" && (e.data as { reconciled?: boolean }).reconciled === true)
    expect(reconciled).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// 8. Event replay from afterSeq
// ---------------------------------------------------------------------------

describe("event replay", () => {
  it("8. streamEvents(jobId, afterSeq) replays only events after the watermark, then follows live", async () => {
    const inspect = countingTool("inspect")
    const { runner } = makeRig(
      [
        { text: "one", toolCalls: [{ toolName: "inspect", input: {} }] },
        { text: "two" },
      ],
      [inspect.tool],
    )
    const record = await runner.createJob({ ...IDENTITY, spec: { engine: "script", model: "m", input: "replay" }, policy: policyFor([inspect.tool]) })
    await runner.runJob(record.jobId)

    const all = await drainEvents(runner, record.jobId)
    const mid = Math.floor(all.length / 2)
    const tail = await drainEvents(runner, record.jobId, all[mid]!.seq)
    expect(tail.length).toBeGreaterThan(0)
    expect(tail.every((e) => e.seq > all[mid]!.seq)).toBe(true)
    expect(tail[tail.length - 1]!.type).toBe("checkpoint")
    // Public vocabulary only.
    expect(new Set(all.map((e) => e.type)).size).toBeGreaterThan(0)
    for (const e of all) expect(JOB_EVENT_TYPES).toContain(e.type)
  })

  it("8b. a live subscriber follows events as they are committed", async () => {
    const { runner } = makeRig([{ text: "live" }], [])
    const record = await runner.createJob({ ...IDENTITY, spec: { engine: "script", model: "m", input: "live" } })
    const seen: JobEvent[] = []
    const { done } = collect(runner.streamEvents(record.jobId, 0), seen)
    await runner.runJob(record.jobId)
    await done
    const types = seen.map((e) => e.type)
    expect(types).toContain("queued")
    expect(types).toContain("started")
    expect(types).toContain("message")
    expect(types).toContain("completed")
    expect(seen.map((e) => e.seq)).toEqual([...seen.map((e) => e.seq)].sort((a, b) => a - b))
  })
})

// ---------------------------------------------------------------------------
// 9. Cancellation
// ---------------------------------------------------------------------------

describe("cancellation", () => {
  it("9. cancelling mid-run prevents further continuation; resume does not continue", async () => {
    const inspect = countingTool("inspect")
    let runnerRef: DurableAgentRunner | null = null
    let jobIdRef = ""
    const rig = makeRig(
      [
        { text: "step-0", toolCalls: [{ toolName: "inspect", input: { value: "keep-going" } }] },
        { text: "step-1" },
        { text: "never reached" },
      ],
      [inspect.tool],
      {},
      {
        onTurnStart: async (stepIndex) => {
          if (stepIndex === 1 && runnerRef) await runnerRef.cancelJob(jobIdRef)
        },
      },
    )
    runnerRef = rig.runner
    const record = await rig.runner.createJob({ ...IDENTITY, spec: { engine: "script", model: "m", input: "cancel" }, policy: policyFor([inspect.tool]) })
    jobIdRef = record.jobId

    const state = await rig.runner.runJob(record.jobId)
    expect(state.status).toBe("cancelled")
    expect(state.usage.steps).toBe(1) // step 0 committed, step 1 aborted

    // Resume on a cancelled job is a no-op: no continuation.
    const rig2 = makeRig([{ text: "x" }], [inspect.tool])
    const resumed = await rig2.runner.resumeJob(record.jobId)
    expect(resumed.status).toBe("cancelled")
    const events = await rig.store.listEvents(record.jobId)
    expect(events.filter((e) => e.type === "message" && (e.data as { role?: string }).role === "assistant")).toHaveLength(1)
    expect(events[events.length - 1]!.type).toBe("checkpoint")
    expect(events.map((e) => e.type)).toContain("cancelled")
  })

  it("9b. cancelling a queued job prevents it from ever running", async () => {
    const { runner } = makeRig([{ text: "nope" }], [])
    const record = await runner.createJob({ ...IDENTITY, spec: { engine: "script", model: "m", input: "cancel" } })
    const cancelled = await runner.cancelJob(record.jobId)
    expect(cancelled.status).toBe("cancelled")
    const state = await runner.runJob(record.jobId)
    expect(state.status).toBe("cancelled")
    const state2 = await runner.getJobState(record.jobId)
    expect(state2.usage.steps).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 10. Stale/invalid checkpoints rejected
// ---------------------------------------------------------------------------

describe("checkpoint integrity", () => {
  async function makeSuspendedJob(): Promise<{ store: FileJobStore; jobId: string; rig1: Rig }> {
    const charge = countingTool("charge", { crashOnExecution: 1 })
    const rig1 = makeRig(
      [
        { text: "step-0", toolCalls: [{ toolName: "charge", input: {} }] },
        { text: "done" },
      ],
      [charge.tool],
    )
    const record = await rig1.runner.createJob({
      ...IDENTITY,
      spec: { engine: "script", model: "m", input: "integrity" },
      policy: policyFor([charge.tool]),
    })
    await expect(rig1.runner.runJob(record.jobId)).rejects.toThrow(SimulatedCrashError)
    await rig1.runner.suspendJob(record.jobId)
    return { store: rig1.store, jobId: record.jobId, rig1 }
  }

  it("10a. tampered checkpoint payload (bad checksum) is rejected", async () => {
    const { store, jobId } = await makeSuspendedJob()
    const file = path.join(root, "store", jobId, "checkpoint.json")
    const raw = JSON.parse(await readFile(file, "utf8"))
    raw.checkpoint.usage.steps = 999 // tamper without fixing the checksum
    await writeFile(file, JSON.stringify(raw))

    const rig2 = makeRig([{ text: "x" }], [])
    await expect(rig2.runner.resumeJob(jobId)).rejects.toThrow(InvalidCheckpointError)
    expect((await rig2.runner.getJobState(jobId)).status).toBe("suspended")
    // No new events were committed by the refused resume.
    const events = await store.listEvents(jobId)
    expect(events.map((e) => e.type)).not.toContain("resumed")
  })

  it("10b. checkpoint watermark beyond the durable log is rejected", async () => {
    const { store, jobId } = await makeSuspendedJob()
    await rewriteCheckpointFile(store, jobId, (cp) => ({ ...cp, lastEventSeq: cp.lastEventSeq + 100 }))
    const rig2 = makeRig([{ text: "x" }], [])
    await expect(rig2.runner.resumeJob(jobId)).rejects.toThrow(InvalidCheckpointError)
  })

  it("10c. policy-version drift between checkpoint and job policy is rejected", async () => {
    const { store, jobId } = await makeSuspendedJob()
    await rewriteCheckpointFile(store, jobId, (cp) => ({ ...cp, policyVersion: "999" }))
    const rig2 = makeRig([{ text: "x" }], [])
    await expect(rig2.runner.resumeJob(jobId)).rejects.toThrow(InvalidCheckpointError)
  })

  it("10d. engine-version drift between checkpoint and registered engine is rejected", async () => {
    const { store, jobId } = await makeSuspendedJob()
    await rewriteCheckpointFile(store, jobId, (cp) => ({ ...cp, engineVersion: "999" }))
    const rig2 = makeRig([{ text: "x" }], [])
    await expect(rig2.runner.resumeJob(jobId)).rejects.toThrow(InvalidCheckpointError)
  })
})

// ---------------------------------------------------------------------------
// 11. Tenant identity cannot change during resume
// ---------------------------------------------------------------------------

describe("tenant identity", () => {
  it("11a. checkpoint identity mismatch is rejected during resume", async () => {
    const charge = countingTool("charge", { crashOnExecution: 1 })
    const rig1 = makeRig(
      [
        { text: "s0", toolCalls: [{ toolName: "charge", input: {} }] },
        { text: "done" },
      ],
      [charge.tool],
    )
    const record = await rig1.runner.createJob({
      ...IDENTITY,
      spec: { engine: "script", model: "m", input: "identity" },
      policy: policyFor([charge.tool]),
    })
    await expect(rig1.runner.runJob(record.jobId)).rejects.toThrow(SimulatedCrashError)
    await rig1.runner.suspendJob(record.jobId)
    await rewriteCheckpointFile(rig1.store, record.jobId, (cp) => ({ ...cp, tenantId: "tenant-evil" }))

    const rig2 = makeRig([{ text: "x" }], [])
    await expect(rig2.runner.resumeJob(record.jobId)).rejects.toThrow(IdentityMismatchError)
    expect((await rig2.runner.getJobState(record.jobId)).status).toBe("suspended")
  })

  it("11b. job record identity fields are immutable in the store", async () => {
    const { runner, store } = makeRig([{ text: "ok" }], [])
    const record = await runner.createJob({ ...IDENTITY, spec: { engine: "script", model: "m", input: "x" } })
    await expect(store.updateJobRecord(record.jobId, 0, () => ({ tenantId: "tenant-evil" } as never))).rejects.toThrow(IdentityMismatchError)
    const fresh = await runner.getJobState(record.jobId)
    expect(fresh.jobId).toBe(record.jobId)
  })
})
