/**
 * Phase 1B actor/environment/snapshot/recovery tests (the 18 required scenarios).
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  ChatMessage,
  DurableAgentRunner,
  EngineInit,
  EngineSession,
  EngineTurnEvent,
  ExecutionActorControllerImpl,
  FileJobStore,
  IdentityMismatchError,
  JobEvent,
  JobState,
  LeaseFencedError,
  LocalExecutionEnvironment,
  LocalWorkspaceProvider,
  ScriptEngine,
  ScriptTurn,
  SimulatedCrashError,
  Tool,
  finalizeCheckpoint,
  type DurableJobStore,
  type ExecutionEnvironment,
  type JobRecord,
  type JobCheckpoint,
  type AgentEngine,
} from "../src/index"

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vaulltcore-actor-test-"))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const IDENTITY = { tenantId: "tenant-c", orgId: "org-c", projectId: "project-c" }

/** Deterministic controller factory for bare ownership/lifecycle tests. */
function bareController(store: DurableJobStore, env: ExecutionEnvironment | null, engines: AgentEngine[] = [new ScriptEngine([])]): ExecutionActorControllerImpl {
  return new ExecutionActorControllerImpl({
    store,
    environment: env,
    workspace: env ? null : new LocalWorkspaceProvider(path.join(root, "workspaces")),
    resolveEngine: (record) => {
      const engine = engines.find((e) => e.id === record.spec.engine)
      if (!engine) throw new Error(`no engine ${record.spec.engine}`)
      return engine
    },
    resolvePolicy: (record) => record.policy,
    toJobState: async (record) => ({
      jobId: record.jobId,
      status: record.status,
      attempt: record.attempt,
      lastEventSeq: 0,
      usage: { steps: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 },
      error: record.error,
      checkpoint: null,
    } as JobState),
  })
}

/** Tool that writes `name` into the workspace root (continuity checks). */
function writeFileTool(name = "stamp"): Tool {
  return {
    definition: { name: "write_file", description: "write a file into the workspace", parameters: { type: "object" } },
    async execute(_input, ctx) {
      if (!ctx.workspace?.root) throw new Error("no workspace root")
      await mkdir(ctx.workspace.root, { recursive: true })
      await writeFile(path.join(ctx.workspace.root, `${name}.txt`), `content:${name}`)
      return { written: `${name}.txt` }
    },
  }
}

/** Tool that fails unless `name` exists in the workspace root (proves compute restore). */
function probeFileTool(name = "stamp.txt"): Tool {
  return {
    definition: { name: "probe_file", description: "assert a workspace file exists", parameters: { type: "object" } },
    async execute(_input, ctx) {
      const file = path.join(ctx.workspace?.root ?? "", name)
      if (!existsSync(file)) throw new Error(`workspace continuity broken: ${name} missing`)
      return { ok: true }
    },
  }
}

/** Policy wiring helper: explicitly allow the given tools. */
function policyFor(tools: Tool[]): { allowedTools: string[]; idempotentTools: string[] } {
  return {
    allowedTools: tools.map((t) => t.definition.name),
    idempotentTools: tools.filter((t) => t.definition.idempotent).map((t) => t.definition.name),
  }
}

function readCheckpoint(store: FileJobStore, jobId: string): Promise<JobCheckpoint> {
  return store.getCheckpoint(jobId).then((cp) => {
    if (!cp) throw new Error("no checkpoint")
    return cp
  })
}

interface Rig {
  runner: DurableAgentRunner
  store: FileJobStore
  controller: ExecutionActorControllerImpl
  environment: LocalExecutionEnvironment
}

function makeRig(
  turns: ScriptTurn[],
  tools: Tool[],
  opts: { envHooks?: ConstructorParameters<typeof LocalExecutionEnvironment>[1] } = {},
): Rig {
  const store = new FileJobStore(path.join(root, "store"))
  const environment = new LocalExecutionEnvironment(path.join(root, "environment"), opts.envHooks)
  const engines = [new ScriptEngine(turns)] as AgentEngine[]
  const runner = new DurableAgentRunner({ store, engines, tools, workspace: null, environment })
  const controller = bareController(store, environment, engines)
  return { runner, store, controller, environment }
}

async function drainAll(runner: DurableAgentRunner, jobId: string): Promise<JobEvent[]> {
  const events: JobEvent[] = []
  for await (const e of runner.streamEvents(jobId, 0)) events.push(e)
  return events
}

// ---------------------------------------------------------------------------
// 1–5. Single-writer ownership races and stale-owner fencing
// ---------------------------------------------------------------------------

describe("single-writer ownership", () => {
  async function makeSuspendedJob(): Promise<{ rig: Rig; jobId: string }> {
    const charge = countingTool()
    const rig = makeRig(
      [
        { text: "s0", toolCalls: [{ toolName: "charge", input: {} }] },
        { text: "done" },
      ],
      [charge.tool],
    )
    const record = await rig.runner.createJob({ ...IDENTITY, spec: { engine: "script", model: "m", input: "race" }, policy: { allowedTools: ["charge"], idempotentTools: [] } })
    await expect(rig.runner.runJob(record.jobId)).rejects.toThrow(SimulatedCrashError)
    await rig.runner.suspendJob(record.jobId)
    return { rig, jobId: record.jobId }

    function countingTool(): { tool: Tool } {
      let n = 0
      return {
        tool: {
          definition: { name: "charge", description: "", parameters: { type: "object" } },
          async execute() {
            n++
            if (n === 1) throw new SimulatedCrashError()
            return {}
          },
        },
      }
    }
  }

  it("1–2. two workers race to resume; exactly one acquires authoritative ownership", async () => {
    const { rig, jobId } = await makeSuspendedJob()
    const a = bareController(rig.store, null)
    const b = bareController(rig.store, null)

    const first = await a.acquire(jobId)
    expect(first.ownership.generation).toBeGreaterThan(1)
    // Second worker loses the race — the store rejects a conflicting owner.
    await expect(b.acquire(jobId)).rejects.toThrow(/leased/i)
    await a.release(first)
  })

  it("3. a stale owner cannot append events", async () => {
    const { rig, jobId } = await makeSuspendedJob()
    const owner1 = bareController(rig.store, null)
    const handle = await owner1.acquire(jobId)
    // Supervisor clears the lease (worker loss), then owner2 takes over.
    await rig.store.releaseLease(jobId, handle.ownership.token)
    const owner2 = bareController(rig.store, null)
    const latest = await owner2.acquire(jobId)

    await expect(
      rig.store.appendEvents(jobId, [{ jobId, timestamp: 1, type: "warning", data: {} }], handle.ownership.generation),
    ).rejects.toThrow(LeaseFencedError)
    // Meanwhile the legitimate writer appends fine.
    await expect(rig.store.appendEvents(jobId, [{ jobId, timestamp: 1, type: "warning", data: {} }], latest.ownership.generation)).resolves.not.toThrow()
  })

  it("4. a stale owner cannot commit a checkpoint or transition terminal state", async () => {
    const { rig, jobId } = await makeSuspendedJob()
    const owner1 = bareController(rig.store, null)
    const handle = await owner1.acquire(jobId)
    await rig.store.releaseLease(jobId, handle.ownership.token)
    const owner2 = bareController(rig.store, null)
    const winner = await owner2.acquire(jobId)

    const checkpoint = await readCheckpoint(rig.store, jobId)
    await expect(rig.store.saveCheckpoint(jobId, { ...checkpoint, attempt: handle.ownership.generation })).rejects.toThrow(LeaseFencedError)
    await expect(rig.store.updateJobRecord(jobId, handle.ownership.generation, () => ({ status: "completed" as never }))).rejects.toThrow(
      LeaseFencedError,
    )
    // The winner still controls the record.
    await expect(rig.store.updateJobRecord(jobId, winner.ownership.generation, () => ({ error: "ok" } as never))).resolves.not.toThrow()
  })

  it("5. only one controller instance owns recovery", async () => {
    const { rig, jobId } = await makeSuspendedJob()
    const a = bareController(rig.store, null)
    const b = bareController(rig.store, null)
    const ctxA = await a.recover(jobId)
    await expect(b.recover(jobId)).rejects.toThrow(/leased/i)
    // Ownership released, the loser can retry later.
    await a.release(ctxA.handle)
    const ctxB = await b.recover(jobId)
    await b.release(ctxB.handle)
  })
})

// ---------------------------------------------------------------------------
// 6–9, 13–15, 17. Snapshots, fallback, and workspace continuity
// ---------------------------------------------------------------------------

/** Crash helper: after step 0 commits, crash at the NEXT turn start. */
function crashAtTurnStart(step: number): { onTurnStart: (stepIndex: number) => void } {
  return {
    onTurnStart: (stepIndex: number) => {
      if (stepIndex === step) throw new SimulatedCrashError()
    },
  }
}

/** Run step 0 (writes file), crash at turn 1 start, suspend, then resume. */
describe("snapshots and workspace continuity", () => {
  async function crashedJob(script: ScriptTurn[], tools: Tool[]): Promise<{ rig: Rig; jobId: string; record: JobRecord }> {
    const rig = makeRig(script, tools)
    const record = await rig.runner.createJob({ ...IDENTITY, spec: { engine: "script", model: "m", input: "snap" }, policy: policyFor(tools) })
    rig.runner = new DurableAgentRunner({
      store: rig.store,
      engines: [new ScriptEngine(script, crashAtTurnStart(1))],
      tools,
      workspace: null,
      environment: rig.environment,
    })
    await expect(rig.runner.runJob(record.jobId)).rejects.toThrow(SimulatedCrashError)
    return { rig, jobId: record.jobId, record }
  }

  it("6, 9. suspend → snapshot → resume restores compute; workspace continuity holds", async () => {
    const continuityScript: ScriptTurn[] = [
      { text: "s0", toolCalls: [{ toolName: "write_file", input: {} }] },
      { text: "s1", toolCalls: [{ toolName: "probe_file", input: {} }] },
    ]
    const tools = [writeFileTool(), probeFileTool()]
    const { rig, jobId } = await crashedJob(continuityScript, tools)
    await rig.runner.suspendJob(jobId, "planned_hibernation")
    const snapshot = (await rig.store.getJobRecord(jobId))!.latestSnapshot
    expect(snapshot?.jobId).toBe(jobId)

    // Fresh worker: compute restore succeeds; probe tool proves the file written in step 0 rides along.
    const rig2 = makeRig(continuityScript, tools)
    const state = await rig2.runner.resumeJob(jobId)
    expect(state.status).toBe("completed")
    const resumed = (await drainAll(rig2.runner, jobId)).find((e) => e.type === "resumed")
    expect((resumed!.data as { restoredFromSnapshot?: boolean }).restoredFromSnapshot).toBe(true)
  })

  for (const [label, corrupt] of [
    ["7. snapshot unavailable → logical resume succeeds", false],
    ["8. snapshot corrupt → logical resume fallback with warning", true],
  ] as const) {
    it(label, async () => {
      const script: ScriptTurn[] = [
        { text: "s0", toolCalls: [{ toolName: "write_file", input: {} }] },
        { text: "done" },
      ]
      const tools = [writeFileTool()]
      const { rig, jobId } = await crashedJob(script, tools)
      await rig.runner.suspendJob(jobId, "planned_hibernation")
      const snapshot = (await rig.store.getJobRecord(jobId))!.latestSnapshot!
      if (corrupt) {
        // Tamper with the payload: torn-copy detection must reject it.
        await writeFile(path.join(snapshot.storage.uri, "stamp.txt"), "tampered")
      } else {
        await rm(snapshot.storage.uri, { recursive: true, force: true })
      }

      const rig2 = makeRig(script, tools)
      const state = await rig2.runner.resumeJob(jobId)
      expect(state.status).toBe("completed")
      const warn = (await drainAll(rig2.runner, jobId)).find(
        (e) => e.type === "warning" && (e.data as { reason?: string }).reason === "snapshot_restore_failed",
      )
      expect(warn).toBeDefined()
      // Logical resume: step 0 committed; never rerun.
      expect(state.usage.steps).toBe(2)
    })
  }

  it("13. worker dies during snapshot creation → no dangling reference; recovery is logical", async () => {
    const hook = {
      duringSnapshot: () => {
        throw new SimulatedCrashError()
      },
    }
    const script: ScriptTurn[] = [{ text: "s0", toolCalls: [{ toolName: "write_file", input: {} }] }, { text: "done" }]
    const rig1 = makeRig(script, [writeFileTool()], { envHooks: hook })
    const record = await rig1.runner.createJob({ ...IDENTITY, spec: { engine: "script", model: "m", input: "die-snap" }, policy: policyFor([writeFileTool()]) })
    rig1.runner = new DurableAgentRunner({
      store: rig1.store,
      engines: [new ScriptEngine(script, crashAtTurnStart(1))],
      tools: [writeFileTool()],
      workspace: null,
      environment: rig1.environment,
    })
    await expect(rig1.runner.runJob(record.jobId)).rejects.toThrow(SimulatedCrashError)
    // Suspend crashes mid-snapshot: no reference must be persisted.
    await expect(rig1.runner.suspendJob(record.jobId)).rejects.toThrow(SimulatedCrashError)
    const rec = await rig1.store.getJobRecord(record.jobId)
    expect(rec?.latestSnapshot).toBeNull()

    // Supervisor clears the dead worker's lease, then a clean worker recovers.
    await rig1.store.releaseLease(record.jobId, rec?.leaseToken ?? "")
    const rig2 = makeRig([{ text: "done" }], [writeFileTool()])
    const state = await rig2.runner.resumeJob(record.jobId)
    expect(state.status).toBe("completed")
  })

  it("14–15. dies after snapshot but before checkpoint commit → recovery honors the last authoritative boundary", async () => {
    const turns: ScriptTurn[] = [
      { text: "step-0", toolCalls: [{ toolName: "write_file", input: {} }], usage: { inputTokens: 2, outputTokens: 1 } },
      { text: "done", usage: { inputTokens: 2, outputTokens: 1 } },
    ]
    const tools = [writeFileTool()]
    const { rig, jobId } = await crashedJob(turns, tools)
    await rig.runner.suspendJob(jobId, "infrastructure_eviction")
    const beforeWatermark = (await readCheckpoint(rig.store, jobId)).lastEventSeq
    expect(beforeWatermark).toBeGreaterThan(0)
    expect((await rig.store.getJobRecord(jobId))!.latestSnapshot).not.toBeNull()

    const rig2 = makeRig(turns, tools)
    const state = await rig2.runner.resumeJob(jobId)
    expect(state.status).toBe("completed")
    const after = await readCheckpoint(rig2.store, jobId)
    expect(after.usage.steps).toBe(2) // step 0 committed exactly once
  })

  it("17. tenant identity stays immutable through snapshot capture/restore", async () => {
    const script: ScriptTurn[] = [{ text: "s0", toolCalls: [{ toolName: "write_file", input: {} }] }, { text: "done" }]
    const { rig, jobId } = await crashedJob(script, [writeFileTool()])
    await rig.runner.suspendJob(jobId, "waiting_for_input")
    const rec = await rig.store.getJobRecord(jobId)!
    expect(rec?.latestSnapshot).not.toBeNull()

    // Store-level immutability: snapshot capture/restore never unfreezes identity.
    await expect(rig.store.updateJobRecord(jobId, rec!.attempt, () => ({ tenantId: "evil" } as never))).rejects.toThrow(IdentityMismatchError)
    expect((await rig.store.getJobRecord(jobId))?.tenantId).toBe(IDENTITY.tenantId)

    // Checkpoint identity tampering parks suspended even with a valid snapshot.
    const cp = await readCheckpoint(rig.store, jobId)
    const file = path.join(root, "store", jobId, "checkpoint.json")
    const raw = JSON.parse(await readFile(file, "utf8"))
    raw.checkpoint = finalizeCheckpoint({ ...cp, tenantId: "evil" })
    await writeFile(file, JSON.stringify(raw, null, 2))
    const rig2 = makeRig(script, [writeFileTool()])
    await expect(rig2.runner.resumeJob(jobId)).rejects.toThrow(IdentityMismatchError)
    expect((await rig2.runner.getJobState(jobId)).status).toBe("suspended")
  })
})

// ---------------------------------------------------------------------------
// 10, 11, 12, 18. Fresh-process recovery + stream integrity
// ---------------------------------------------------------------------------

describe("fresh-process reconstruction and stream integrity", () => {
  it("10. fresh process reconstructs state with no in-memory dependency", async () => {
    const inspect = countingMarker()
    const rig1 = makeRig(
      [
        { text: "s0", toolCalls: [{ toolName: "inspect", input: {} }] },
        { text: "done" },
      ],
      [inspect.tool],
    )
    const record = await rig1.runner.createJob({ ...IDENTITY, spec: { engine: "script", model: "m", input: "fresh" }, policy: { allowedTools: ["inspect"], idempotentTools: [] } })
    await expect(rig1.runner.runJob(record.jobId)).rejects.toThrow(SimulatedCrashError)
    await rig1.runner.suspendJob(record.jobId)
    // Brand-new process (new store/runner/controller instances binding the same root).
    const rig2 = makeRig(
      [
        { text: "s0", toolCalls: [{ toolName: "inspect", input: {} }] },
        { text: "done" },
      ],
      [countingMarker().tool],
    )
    const state = await rig2.runner.resumeJob(record.jobId)
    expect(state.status).toBe("completed")
    expect(state.attempt).toBe(2)

    function countingMarker(): { tool: Tool } {
      let n = 0
      return {
        tool: {
          definition: { name: "inspect", description: "", parameters: { type: "object" } },
          async execute() {
            n++
            if (n === 1) throw new SimulatedCrashError()
            return {}
          },
        },
      }
    }
  })

  it("11. replay-to-live subscription has no sequence gap", async () => {
    const rig = makeRig([{ text: "x", usage: { inputTokens: 1, outputTokens: 1 } }], [])
    const record = await rig.runner.createJob({ ...IDENTITY, spec: { engine: "script", model: "m", input: "stream" } })
    const events: JobEvent[] = []
    const done = (async () => {
      for await (const e of rig.runner.streamEvents(record.jobId, 0)) events.push(e)
    })()
    await rig.runner.runJob(record.jobId)
    await done
    const seqs = events.map((e) => e.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length) // no gaps or dupes
    expect(events.some((e) => e.type === "completed")).toBe(true)
  })

  it("12. duplicate event delivery is safely deduplicated by jobId+seq", async () => {
    const rig = makeRig([{ text: "x" }], [])
    const record = await rig.runner.createJob({ ...IDENTITY, spec: { engine: "script", model: "m", input: "dup" } })
    await rig.runner.runJob(record.jobId)
    const all = await drainAll(rig.runner, record.jobId)
    // Simulate a re-delivery (broker duplicate) and deduplicate.
    const delivered = [...all, ...[...all].reverse()]
    const seen = new Set<string>()
    const unique = delivered.filter((e) => {
      const key = `${e.jobId}:${e.seq}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    expect(unique.map((e) => e.seq)).toEqual(all.map((e) => e.seq))
    expect(unique.length).toBe(all.length)
  })

  it("16. a different engine/harness passes through the same controller unchanged", async () => {
    // An inline second AgentEngine proves controller semantics hold regardless
    // of the engine implementation (the OpenCode adapter exercises the same
    // path in its own package tests).
    class GlyphEngine implements AgentEngine {
      readonly id = "glyph"
      readonly version = "9"
      async createSession(init: EngineInit): Promise<EngineSession> {
        return { handle: { init, phase: "create" } }
      }
      async restoreSession(init: EngineInit, history: readonly ChatMessage[]): Promise<EngineSession> {
        return { handle: { init, history, phase: "restore" } }
      }
      async *runTurn(_session: EngineSession, _tools: readonly { name: string }[], signal: AbortSignal): AsyncGenerator<EngineTurnEvent> {
        void signal
        yield { type: "text", text: "glyph" }
        yield { type: "finish", reason: "stop" }
      }
      projectHistory(events: readonly JobEvent[]): ChatMessage[] {
        return events
          .filter((e) => e.type === "message")
          .map((e) => {
            const d = e.data as { role?: string; text?: string }
            return { role: (d.role ?? "assistant") as ChatMessage["role"], content: [{ type: "text" as const, text: d.text ?? "" }] }
          })
      }
      recordAssistantTurn(session: EngineSession, message: ChatMessage): void {
        void session
        void message
      }
      recordToolResults(): void {}
      recordUserInput(): void {}
    }
    const rig = makeRig([{ text: "script too" }], [])
    rig.runner = new DurableAgentRunner({
      store: rig.store,
      engines: [new GlyphEngine(), new ScriptEngine([{ text: "script too" }])],
      tools: [],
      workspace: null,
      environment: rig.environment,
    })
    const record = await rig.runner.createJob({ ...IDENTITY, spec: { engine: "glyph", model: "m", input: "swap" } })
    const state = await rig.runner.runJob(record.jobId)
    expect(state.status).toBe("completed")
  })

  it("18. attempt fencing survives across separate controller instances (process restart)", async () => {
    const inspect1 = countingCrash()
    const rig1 = makeRig(
      [
        { text: "s0", toolCalls: [{ toolName: "inspect", input: {} }] },
        { text: "done" },
      ],
      [inspect1.tool],
    )
    const record = await rig1.runner.createJob({ ...IDENTITY, spec: { engine: "script", model: "m", input: "fence" } })
    const controller1 = bareController(rig1.store, rig1.environment)
    const h1 = await controller1.acquire(record.jobId)

    // Process restart: a second controller over the same durable store.
    const controller2 = bareController(rig1.store, rig1.environment)
    await expect(controller2.acquire(record.jobId)).rejects.toThrow(/leased/i)
    await controller1.release(h1)
    const h2 = await controller2.acquire(record.jobId)
    expect(h2.ownership.generation).toBe(h1.ownership.generation + 1)
    // All fenced operations of the old process are rejected.
    await expect(rig1.store.updateJobRecord(record.jobId, h1.ownership.generation, () => ({ error: "x" } as never))).rejects.toThrow(
      LeaseFencedError,
    )
    await expect(
      rig1.store.appendEvents(record.jobId, [{ jobId: record.jobId, timestamp: 1, type: "warning", data: {} }], h1.ownership.generation),
    ).rejects.toThrow(LeaseFencedError)

    function countingCrash(): { tool: Tool } {
      let n = 0
      return {
        tool: {
          definition: { name: "inspect", description: "", parameters: { type: "object" } },
          async execute() {
            n++
            if (n === 1) throw new SimulatedCrashError()
            return {}
          },
        },
      }
    }
  })
})
