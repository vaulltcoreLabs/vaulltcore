/**
 * Bridge proof: BYOK ModelProviderAdapter (models plane) ↔ OpenCode wire
 * ModelProvider, through the real OpenCodeEngine + DurableAgentRunner path.
 *
 * These tests use a fake ModelProviderAdapter (no network) to prove the
 * production composition shape end-to-end deterministically, while keeping the
 * credential-backed adapter path honest (secrets never cross the bridge).
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { ModelDescriptor, ModelProviderAdapter, ModelRequest, ModelStreamEvent, ModelTool } from "@vaulltcore/models"
import { DurableAgentRunner, FileJobStore, JOB_EVENT_TYPES, LocalWorkspaceProvider, Tool, type ExecutionPolicy } from "@vaulltcore/runner"
import type { LLMRequest } from "../src/kernel/llm"
import { modelsAdapterToProvider, modelStreamEventToWire, OpenCodeEngine, type SessionProviderResolver } from "../src/index"

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vaulltcore-bridge-"))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const IDENTITY = { tenantId: "tenant-r", orgId: "org-r", projectId: "project-r" }

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

const DESCRIPTOR: ModelDescriptor = {
  provider: "test-provider",
  model: "test-model",
  label: "test",
  contextWindow: 100,
  maxOutputTokens: null,
  supportsTools: true,
  supportsReasoning: false,
  pricing: { inputPerMillion: 1, outputPerMillion: 2 },
  metadata: {},
}

/** Deterministic fake adapter capturing the translated request. */
function fakeAdapter(opts: {
  turns: ReadonlyArray<{
    readonly text?: string
    readonly toolCalls?: ReadonlyArray<{ readonly toolCallId: string; readonly name: string; readonly input: unknown }>
    readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number }
  }>
  readonly captured: Array<{ readonly request: ModelRequest; readonly tools?: readonly ModelTool[] }>
}): ModelProviderAdapter {
  return {
    descriptor: DESCRIPTOR,
    async *stream(request: ModelRequest, _signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
      opts.captured.push({ request, tools: request.tools })
      const stepIndex = request.messages.filter((m) => m.role === "assistant").length
      const turn = opts.turns[stepIndex]
      yield { type: "step-start" }
      if (!turn) {
        yield { type: "finish", reason: "stop" }
        return
      }
      if (turn.text) yield { type: "text-delta", text: turn.text }
      if (turn.usage) yield { type: "usage", usage: turn.usage }
      for (const call of turn.toolCalls ?? []) {
        yield { type: "tool-call", toolCallId: call.toolCallId, name: call.name, input: call.input }
      }
      yield { type: "step-finish" }
      yield { type: "finish", reason: turn.toolCalls?.length ? "tool_calls" : "stop" }
    },
  }
}

/** Direct session resolver for the bridge unit tests; the real ModelRegistry
 *  wiring (modelsProviderResolver) is exercised in the control composition
 *  test, where the full credential-backed stack is available. */
function adapterResolver(adapter: ModelProviderAdapter): SessionProviderResolver {
  return async () => modelsAdapterToProvider(adapter)
}

const POLICY: Partial<ExecutionPolicy> = { allowedTools: ["echo"], idempotentTools: [] }

describe("models bridge → OpenCode wire → runner", () => {
  it("translates a ModelStreamEvent into the wire vocabulary", () => {
    const wire = modelStreamEventToWire({ type: "text-delta", text: "hello" })
    expect(wire).toEqual({ type: "text-delta", text: "hello" })
    expect(modelStreamEventToWire({ type: "usage", usage: { inputTokens: 1, outputTokens: 2 } })).toEqual({
      type: "usage",
      usage: { inputTokens: 1, outputTokens: 2 },
    })
    expect(modelStreamEventToWire({ type: "tool-call", toolCallId: "c1", name: "echo", input: { x: 1 } })).toEqual({
      type: "tool-call",
      toolCallId: "c1",
      toolName: "echo",
      input: { x: 1 },
    })
    expect(modelStreamEventToWire({ type: "finish", reason: "tool_calls" })).toEqual({
      type: "finish",
      reason: "tool_calls",
    })
  })

  it("maps a provider error to a sanitized wire provider-error (never the secret)", () => {
    const wire = modelStreamEventToWire({
      type: "error",
      error: { code: "MODEL_UNAUTHORIZED", message: "model unauthorized", retryClass: "auth_config", status: 401 },
    } as never)
    expect(wire.type).toBe("provider-error")
    const msg = (wire as { message: string }).message
    expect(msg).toContain("auth_config")
    expect(msg).toContain("model unauthorized")
    expect(msg).not.toContain("super-secret-key")
  })

  it("translates wire history/tools into the models request (tool results split, text joined)", async () => {
    const captured: Array<{ request: ModelRequest }> = []
    // Always emit one text turn regardless of step index (single exchange).
    const adapter: ModelProviderAdapter = {
      descriptor: DESCRIPTOR,
      async *stream(request: ModelRequest, _signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
        captured.push({ request })
        yield { type: "step-start" }
        yield { type: "text-delta", text: "done" }
        yield { type: "step-finish" }
        yield { type: "finish", reason: "stop" }
      },
    }
    const provider = modelsAdapterToProvider(adapter)
    const request: LLMRequest = {
      model: "test-model",
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }, { type: "text", text: " there" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "calling" },
            { type: "tool-call", toolCallId: "c1", toolName: "echo", input: { v: 1 } },
          ],
        },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "echo", output: "ok", isError: false }] },
      ],
      tools: [{ name: "echo", description: "desc", parameters: { type: "object" } }],
      system: "sys",
      options: { maxTokens: 100, temperature: 0.2 },
    }
    const evts: string[] = []
    for await (const e of provider.stream(request, new AbortController().signal)) evts.push(e.type)
    expect(evts).toContain("step-start")
    expect(evts).toContain("text-delta")
    expect(evts).toContain("finish")

    const req = captured[0]!.request
    expect(req.system).toBe("sys")
    expect(req.maxTokens).toBe(100)
    expect(req.temperature).toBe(0.2)
    expect(req.tools?.[0]).toEqual({ name: "echo", description: "desc", inputSchema: { type: "object" } })
    // user text joined
    const user = req.messages.find((m) => m.role === "user")
    expect(user?.content).toBe("hi\n there")
    // assistant text + tool call on one message
    const asst = req.messages.find((m) => m.role === "assistant")
    expect(asst?.content).toBe("calling")
    expect(asst?.toolCalls).toEqual([{ id: "c1", name: "echo", input: { v: 1 } }])
    // tool result becomes its own role:tool message
    const toolMsg = req.messages.find((m) => m.role === "tool")
    expect(toolMsg?.toolCallId).toBe("c1")
    expect(toolMsg?.content).toBe("ok")
  })

  it("rejects malformed wire content (no unsafe casts into trusted state)", async () => {
    const captured: Array<{ request: ModelRequest }> = []
    const adapter = fakeAdapter({ turns: [{ text: "x" }], captured })
    const provider = modelsAdapterToProvider(adapter)
    const bad: LLMRequest = {
      model: "m",
      messages: [{ role: "assistant", content: [{ type: "weird", blob: "nonsense" }] }],
    }
    // The translation happens lazily during iteration (async generator).
    await expect(async () => {
      for await (const _ of provider.stream(bad, new AbortController().signal)) {
        /* consume */
      }
    }).rejects.toThrow(/malformed message part/)
  })

  it("runs end-to-end through the DurableAgentRunner (production composition shape, no network)", async () => {
    const captured: Array<{ request: ModelRequest }> = []
    const adapter = fakeAdapter({
      turns: [
        { text: "calling", toolCalls: [{ toolCallId: "c0", name: "echo", input: { value: 1 } }], usage: { inputTokens: 5, outputTokens: 2 } },
        { text: "final", usage: { inputTokens: 3, outputTokens: 1 } },
      ],
      captured,
    })
    const echo = echoTool()
    const engine = new OpenCodeEngine(adapterResolver(adapter))
    const store = new FileJobStore(path.join(root, "store"))
    const workspace = new LocalWorkspaceProvider(path.join(root, "ws"))
    const runner = new DurableAgentRunner({ store, engines: [engine], tools: [echo.tool], workspace })

    const record = await runner.createJob(
      {
        ...IDENTITY,
        spec: { engine: "opencode", model: "test-model", input: "go", engineOptions: { connectionId: "conn-1", provider: "test-provider" } },
        policy: POLICY,
      },
    )
    const events: string[] = []
    const stream = (async () => {
      for await (const e of runner.streamEvents(record.jobId, 0)) events.push(e.type)
    })()
    const state = await runner.runJob(record.jobId)
    await stream

    expect(state.status).toBe("completed")
    expect(state.usage.steps).toBe(2)
    expect(echo.executions()).toBe(1)
    // The provider saw the tool-calling assistant turn (step 0) committed.
    expect(captured).toHaveLength(2)
    for (const c of captured) {
      const flat = JSON.stringify(c.request)
      expect(flat).not.toContain("secret")
    }
    // Only neutral event types leaked into the public stream.
    for (const t of events) expect(JOB_EVENT_TYPES).toContain(t as (typeof JOB_EVENT_TYPES)[number])
    expect(events).toContain("tool_request")
    expect(events).toContain("tool_response")
  })

  it("routes provider errors through the runner's honest failure path (terminal failed, no secret)", async () => {
    const failing: ModelProviderAdapter = {
      descriptor: DESCRIPTOR,
      async *stream(): AsyncIterable<ModelStreamEvent> {
        yield { type: "step-start" }
        yield {
          type: "error",
          error: { code: "MODEL_UNAUTHORIZED", message: "model unauthorized", retryClass: "auth_config", status: 401 },
        } as never
        yield { type: "finish", reason: "stop" }
      },
    }
    const engine = new OpenCodeEngine(adapterResolver(failing))
    const store = new FileJobStore(path.join(root, "store"))
    const runner = new DurableAgentRunner({ store, engines: [engine], tools: [echoTool().tool], workspace: null })

    const record = await runner.createJob({
      ...IDENTITY,
      spec: { engine: "opencode", model: "test-model", input: "go", engineOptions: { connectionId: "c", provider: "p" } },
      policy: POLICY,
    })
    const state = await runner.runJob(record.jobId)
    // Non-simulated engine error → runner transitions to terminal `failed`
    // (no fabricated success, no engine-level retry) with a sanitized message.
    expect(state.status).toBe("failed")
    const events = await runner.listEvents(record.jobId, 0)
    const err = events.find((e) => e.type === "error")
    expect(err).toBeDefined()
    const message = (err?.data as { message: string }).message
    expect(message).toContain("auth_config")
    expect(message).toContain("model unauthorized")
    expect(message).not.toContain("secret")
    const serialized = JSON.stringify({ state, events })
    expect(serialized).not.toContain("secret")
  })

  it("passes the runner's AbortSignal through to the adapter (runner owns cancellation)", async () => {
    let sawAbort = false
    const cancelAware: ModelProviderAdapter = {
      descriptor: DESCRIPTOR,
      async *stream(_req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
        yield { type: "step-start" }
        // An aborted signal must reach the adapter; the adapter returns a
        // single terminal finish (runner decides the terminal outcome).
        if (signal.aborted) {
          sawAbort = true
          yield { type: "finish", reason: "stop" }
          return
        }
        yield { type: "step-finish" }
        yield { type: "finish", reason: "stop" }
      },
    }
    const provider = modelsAdapterToProvider(cancelAware)
    const ctrl = new AbortController()
    ctrl.abort()
    const types: string[] = []
    for await (const e of provider.stream({ model: "m", messages: [] }, ctrl.signal)) types.push(e.type)
    expect(sawAbort).toBe(true)
    // Exactly one terminal finish (no duplicate outcomes).
    expect(types.filter((t) => t === "finish")).toHaveLength(1)
    expect(types.filter((t) => t === "step-finish")).toHaveLength(0)
  })

  it("does not fabricate success when the adapter yields no finish", async () => {
    const incomplete: ModelProviderAdapter = {
      descriptor: DESCRIPTOR,
      async *stream(): AsyncIterable<ModelStreamEvent> {
        yield { type: "step-start" }
        yield { type: "text-delta", text: "incomplete" }
        // never finishes
      },
    }
    const events: string[] = []
    for await (const e of modelsAdapterToProvider(incomplete).stream({ model: "m", messages: [] }, new AbortController().signal)) {
      events.push(e.type)
    }
    expect(events).toContain("text-delta")
    expect(events).not.toContain("finish")
  })
})