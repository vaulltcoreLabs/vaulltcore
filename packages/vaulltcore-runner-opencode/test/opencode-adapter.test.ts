/**
 * OpenCode adapter proof: the durable runner drives the extracted OpenCode
 * kernel (provider turns, event normalization, session projection) through
 * crash + resume, exercising the real AgentEngine seam.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  DurableAgentRunner,
  FileJobStore,
  JOB_EVENT_TYPES,
  LocalWorkspaceProvider,
  SimulatedCrashError,
  Tool,
  type ExecutionPolicy,
} from "@vaulltcore/runner"
import { OpenCodeEngine, ProviderRegistry, ScriptModelProvider, type ScriptedTurn } from "../src/index"

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vaulltcore-oc-test-"))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const IDENTITY = { tenantId: "tenant-b", orgId: "org-b", projectId: "project-b" }

function echoTool(): { tool: Tool; executions: () => number } {
  let executions = 0
  return {
    executions: () => executions,
    tool: {
      definition: { name: "echo", description: "echo back input", parameters: { type: "object" } },
      async execute(input) {
        executions++
        return { echoed: input }
      },
    },
  }
}

function makeRunner(provider: ScriptModelProvider, tools: Tool[]): DurableAgentRunner {
  const store = new FileJobStore(path.join(root, "store"))
  const registry = new ProviderRegistry([{ model: "script-model", provider }])
  const engine = new OpenCodeEngine(registry.resolver())
  const workspace = new LocalWorkspaceProvider(path.join(root, "workspaces"))
  return new DurableAgentRunner({ store, engines: [engine], tools, workspace })
}

const POLICY: Partial<ExecutionPolicy> = { allowedTools: ["echo"], idempotentTools: [] }

describe("OpenCode engine behind the AgentRunner seam", () => {
  it("admitted input during a run reaches the next provider turn (SessionPending semantics)", async () => {
    const requests: Array<{ messages: Array<{ role?: string }> }> = []
    let runnerRef: DurableAgentRunner | null = null
    let jobIdRef = ""
    // Tool steers mid-run: admission lands between turns, deterministically.
    const echo: Tool = {
      definition: { name: "echo", description: "echo", parameters: { type: "object" } },
      async execute() {
        await runnerRef!.submitInput(jobIdRef, "please also check the logs")
        return { ok: true }
      },
    }
    class CapturingProvider extends ScriptModelProvider {
      override async *stream(request: never, signal: AbortSignal) {
        requests.push(request as (typeof requests)[number])
        yield* super.stream(request, signal)
      }
    }
    const provider = new CapturingProvider([
      { text: "step-0", toolCalls: [{ toolName: "echo", input: {} }] },
      { text: "done" },
    ])
    const runner = makeRunner(provider, [echo])
    runnerRef = runner
    const record = await runner.createJob({ ...IDENTITY, spec: { engine: "opencode", model: "script-model", input: "initial" }, policy: POLICY })
    jobIdRef = record.jobId

    const state = await runner.runJob(record.jobId)
    expect(state.status).toBe("completed")
    expect(requests).toHaveLength(2)
    const turn1Text = JSON.stringify(requests[1]!.messages)
    expect(turn1Text).toContain("please also check the logs")
  })

  it("runs provider turns with fine-grained LLM events normalized into the neutral vocabulary", async () => {
    const echo = echoTool()
    const provider = new ScriptModelProvider([
      { text: "calling echo", toolCalls: [{ toolName: "echo", input: { value: 1 } }], usage: { inputTokens: 5, outputTokens: 3 } },
      { text: "final", usage: { inputTokens: 8, outputTokens: 2 } },
    ])
    const runner = makeRunner(provider, [echo.tool])
    const record = await runner.createJob({ ...IDENTITY, spec: { engine: "opencode", model: "script-model", input: "say hi" }, policy: POLICY })

    const seen: string[] = []
    const stream = (async () => {
      for await (const e of runner.streamEvents(record.jobId, 0)) seen.push(e.type)
    })()
    const state = await runner.runJob(record.jobId)
    await stream

    expect(state.status).toBe("completed")
    expect(state.usage.steps).toBe(2)
    expect(state.usage.totalTokens).toBe(18)
    expect(echo.executions()).toBe(1)
    // Only neutral event types leaked into the public stream.
    for (const type of seen) expect(JOB_EVENT_TYPES).toContain(type as (typeof JOB_EVENT_TYPES)[number])
    expect(seen).toContain("tool_request")
    expect(seen).toContain("tool_response")
    expect(seen).toContain("completed")
  })

  it("crashes after a committed step and resumes through a fresh adapter without rerunning work", async () => {
    const turns: ScriptedTurn[] = [
      { text: "step-0", toolCalls: [{ toolName: "echo", input: { value: "committed" } }], usage: { inputTokens: 4, outputTokens: 2 } },
      { text: "done", usage: { inputTokens: 3, outputTokens: 1 } },
    ]
    const echo1 = echoTool()
    // Crash the worker at the start of the SECOND provider turn.
    const provider1 = new ScriptModelProvider(turns, {
      onTurnStart: (step) => {
        if (step === 1) throw new SimulatedCrashError()
      },
    })
    const runner1 = makeRunner(provider1, [echo1.tool])
    const record = await runner1.createJob({ ...IDENTITY, spec: { engine: "opencode", model: "script-model", input: "crash" }, policy: POLICY })

    await expect(runner1.runJob(record.jobId)).rejects.toThrow(SimulatedCrashError)
    expect(echo1.executions()).toBe(1)
    await runner1.suspendJob(record.jobId, "worker_loss")

    const echo2 = echoTool()
    const runner2 = makeRunner(new ScriptModelProvider(turns), [echo2.tool])
    const resumed = await runner2.resumeJob(record.jobId)

    expect(resumed.status).toBe("completed")
    expect(resumed.usage.steps).toBe(2)
    expect(resumed.attempt).toBe(2)
    // The committed echo result from step 0 was reused — never re-executed.
    expect(echo2.executions()).toBe(0)
    expect(resumed.usage.totalTokens).toBe(10)

    const types: string[] = []
    for await (const e of runner2.streamEvents(record.jobId, 0)) types.push(e.type)
    expect(types).toContain("resumed")
  })
})
