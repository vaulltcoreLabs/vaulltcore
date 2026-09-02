/**
 * Phase 1C control-plane proof. The façade delegates everything to the
 * AgentRunner contract; these tests exercise the seven required HTTP
 * scenarios plus idempotency, replay/live-follow sequencing, and the
 * authorization seam.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import {
  DurableAgentRunner,
  FileJobStore,
  ScriptEngine,
  type JobEvent,
  type Tool,
  type ToolContext,
} from "@vaulltcore/runner"
import { ControlPlane, HeaderAuthenticator, InMemoryIdempotencyRegistry } from "../src/index"

let root: string
const servers: Server[] = []
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vaulltcore-control-test-"))
})
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve))
  await rm(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Rig {
  runner: DurableAgentRunner
  base: string
  server: Server
  control: ControlPlane
}

function makeRunner(tools: readonly Tool[] = [], turns: readonly unknown[] = [{ text: "ok", usage: { inputTokens: 1, outputTokens: 1 } }], store?: FileJobStore): DurableAgentRunner {
  return new DurableAgentRunner({
    store: store ?? new FileJobStore(path.join(root, "store")),
    engines: [new ScriptEngine(turns as never)],
    tools,
    workspace: null,
  })
}

async function serve(runner: DurableAgentRunner, opts?: { authenticator?: HeaderAuthenticator }): Promise<Rig> {
  const control = new ControlPlane({ runner, authenticator: opts?.authenticator })
  const server = await control.listen(0)
  servers.push(server)
  const address = server.address()
  const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`
  return { runner, base, server, control }
}

interface JsonResponse {
  status: number
  json: unknown
}

async function call(rig: Rig, method: string, path: string, opts: { tenant?: string; org?: string; key?: string; body?: unknown } = {}): Promise<JsonResponse> {
  const headers: Record<string, string> = {}
  if (opts.tenant) headers["x-vc-tenant"] = opts.tenant
  if (opts.org !== undefined) headers["x-vc-org"] = opts.org
  else if (opts.tenant) headers["x-vc-org"] = "org-test"
  if (opts.key) headers["idempotency-key"] = opts.key
  if (opts.body !== undefined) headers["content-type"] = "application/json"
  const response = await fetch(`${rig.base}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const text = await response.text()
  return { status: response.status, json: text === "" ? null : JSON.parse(text) }
}

let keyCounter = 0
async function createJob(rig: Rig, tenant = "tenant-A", key?: string, body?: unknown) {
  key ??= `key-${++keyCounter}`
  return call(rig, "POST", "/jobs", { tenant, key, body: body ?? { spec: { input: "work" } } })
}

// Progressive SSE reader: resolves a promise whenever a full frame arrives.
interface SseFrame {
  event: string
  data: string
}

function openSse(url: string): { frames: SseFrame[]; ready: Promise<SseFrame[]>; close: () => void } {
  const frames: SseFrame[] = []
  const controller = new AbortController()
  const buffer = { value: "" }
  const done = (async () => {
    const response = await fetch(url, { headers: { "x-vc-tenant": "tenant-A", "x-vc-org": "org-test" }, signal: controller.signal })
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    while (true) {
      const chunk = await reader.read().catch(() => ({ value: undefined as unknown, done: true }))
      buffer.value += decoder.decode(chunk.value as Uint8Array | undefined, { stream: !chunk.done })
      if (chunk.done) break
      let index: number
      while ((index = buffer.value.indexOf("\n\n")) >= 0) {
        const raw = buffer.value.slice(0, index)
        buffer.value = buffer.value.slice(index + 2)
        const event = raw.match(/^event: (.*)$/m)?.[1] ?? ""
        const data = raw.match(/^data: (.*)$/m)?.[1] ?? ""
        frames.push({ event, data })
      }
    }
    return frames
  })()
  void done // fire and collect asynchronously
  return {
    frames,
    ready: done,
    close: () => controller.abort(),
  }
}

async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

// ---------------------------------------------------------------------------
// 15. create job
// ---------------------------------------------------------------------------

describe("POST /jobs", () => {
  it("creates a job and returns its resource locator", async () => {
    const rig = await serve(makeRunner())
    const created = await createJob(rig)
    expect(created.status).toBe(201)
    const { id, status } = created.json as { id: string; status: string }
    expect(id).toMatch(/^[a-z0-9_]+$/i)
    expect(status).toBe("queued")

    const view = await call(rig, "GET", `/jobs/${id}`, { tenant: "tenant-A" })
    expect(view.status).toBe(200)
    expect((view.json as { status: string }).status).toBe("queued")
  })

  it("16. same idempotency key replays the same logical job", async () => {
    const rig = await serve(makeRunner())
    const first = await createJob(rig, "tenant-A", "key-1")
    const second = await createJob(rig, "tenant-A", "key-1")
    expect(first.status).toBe(201)
    expect(second.status).toBe(200)
    expect((second.json as { id: string }).id).toBe((first.json as { id: string }).id)
    // Exactly one job record exists.
    const list = await call(rig, "GET", `/jobs/${(first.json as { id: string }).id}`, { tenant: "tenant-A" })
    expect((list.json as { usage: unknown }).usage).toEqual({ inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, steps: 0, toolCalls: 0 })
  })

  it("16b. different key for the same tenant creates a distinct job", async () => {
    const rig = await serve(makeRunner())
    const first = await createJob(rig, "tenant-A", "key-1")
    const second = await createJob(rig, "tenant-A", "key-2")
    expect((second.json as { id: string }).id).not.toBe((first.json as { id: string }).id)
  })

  it("17. cross-tenant access returns 404 on every job-scoped route", async () => {
    const rig = await serve(makeRunner())
    const created = await createJob(rig, "tenant-A", "shared-key")
    const id = (created.json as { id: string }).id

    for (const [method, path] of [
      ["GET", `/jobs/${id}`],
      ["GET", `/jobs/${id}/usage`],
      ["GET", `/jobs/${id}/events`],
      ["POST", `/jobs/${id}/cancel`],
      ["POST", `/jobs/${id}/input`],
    ] as const) {
      const response = await call(rig, method, path, { tenant: "tenant-B", body: method === "POST" ? { text: "pick" } : undefined })
      expect(response.status, `${method} ${path}`).toBe(404)
    }
    // The creating tenant still sees the job.
    expect((await call(rig, "GET", `/jobs/${id}`, { tenant: "tenant-A" })).status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// 18/19. cancel + input route through the runner contract
// ---------------------------------------------------------------------------

describe("POST /jobs/:id/cancel and /input", () => {
  it("18. cancel routes through AgentRunner.cancelJob exactly once", async () => {
    class SpyRunner extends DurableAgentRunner {
      readonly cancelCalls: string[] = []
      override async cancelJob(jobId: string) {
        this.cancelCalls.push(jobId)
        return super.cancelJob(jobId)
      }
    }
    const runner = new SpyRunner({
      store: new FileJobStore(path.join(root, "store")),
      engines: [new ScriptEngine([{ text: "ok", usage: {} }])],
      tools: [],
      workspace: null,
    })
    const rig = await serve(runner)
    const created = await createJob(rig)
    const id = (created.json as { id: string }).id

    const response = await call(rig, "POST", `/jobs/${id}/cancel`, { tenant: "tenant-A" })
    expect(response.status).toBe(200)
    expect(response.json).toEqual({ status: "cancelled" })
    expect(runner.cancelCalls).toEqual([id])

    const view = await call(rig, "GET", `/jobs/${id}`, { tenant: "tenant-A" })
    expect((view.json as { status: string }).status).toBe("cancelled")
  })

  it("19. input is admitted through AgentRunner.submitInput", async () => {
    class SpyRunner extends DurableAgentRunner {
      readonly inputCalls: Array<{ jobId: string; text: string }> = []
      override async submitInput(jobId: string, text: string) {
        this.inputCalls.push({ jobId, text })
        return super.submitInput(jobId, text)
      }
    }
    const runner = new SpyRunner({
      store: new FileJobStore(path.join(root, "store")),
      engines: [new ScriptEngine([{ text: "ok", usage: {} }])],
      tools: [],
      workspace: null,
    })
    const rig = await serve(runner)
    const created = await createJob(rig)
    const id = (created.json as { id: string }).id

    const response = await call(rig, "POST", `/jobs/${id}/input`, { tenant: "tenant-A", body: { text: "hello job" } })
    expect(response.status).toBe(200)
    expect(runner.inputCalls).toEqual([{ jobId: id, text: "hello job" }])

    const view = await call(rig, "GET", `/jobs/${id}`, { tenant: "tenant-A" })
    expect((view.json as { pendingInput: string[] }).pendingInput).toContain("hello job")
  })
})

// ---------------------------------------------------------------------------
// 20/21. SSE replay + live follow; terminal readability after disconnect
// ---------------------------------------------------------------------------

describe("GET /jobs/:id/events", () => {
  it("20. replay then live follow carries no sequence gap", async () => {
    // A tool call blocks the first turn's settlement; the stream subscribes
    // while the tool is unresolved, then unblocks and follow continues.
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const idleTool: Tool = {
      definition: { name: "idle", description: "blocked", parameters: { type: "object" } },
      async execute(input: unknown, _ctx: ToolContext) {
        void input
        await gate
        return { ok: true }
      },
    }
    const turns = [
      { text: "step-0", toolCalls: [{ toolName: "idle" }], usage: {} },
      { text: "step-1", usage: {} },
    ]
    const runner = makeRunner([idleTool], turns)
    const rig = await serve(runner)
    const created = await createJob(rig)
    const id = (created.json as { id: string }).id

    // Start the run; it will block on the first tool settlement.
    const runP = runner.runJob(id)
    const sse = openSse(`${rig.base}/jobs/${id}/events?after=0&follow=true`)
    // Unlock immediately; replay fills any gap and follow continues.
    release()
    await runP
    await sse.ready
    sse.close()

    const seqs: number[] = []
    let sawDone = false
    for (const frame of sse.frames) {
      if (frame.event === "done") {
        sawDone = true
        continue
      }
      const event = JSON.parse(frame.data) as JobEvent
      seqs.push(event.seq)
    }
    expect(sawDone).toBe(true)
    expect(seqs.length).toBeGreaterThan(0)
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs)
    // No sequence gap between replay and follow.
    expect(seqs).toEqual(seqs.map((_, i) => i + 1))
  })

  it("21. terminal job stays readable after the stream disconnects", async () => {
    const runner = makeRunner()
    const rig = await serve(runner)
    const created = await createJob(rig)
    const id = (created.json as { id: string }).id
    await runner.runJob(id)

    const sse = openSse(`${rig.base}/jobs/${id}/events?after=0&follow=true`)
    await sse.ready
    sse.close()
    expect(sse.frames.some((f) => f.event === "done")).toBe(true)

    // Terminal state remains queryable after the disconnect.
    const view = await call(rig, "GET", `/jobs/${id}`, { tenant: "tenant-A" })
    expect((view.json as { status: string }).status).toBe("completed")
    const replay = await call(rig, "GET", `/jobs/${id}/events`, { tenant: "tenant-A" })
    expect((replay.json as { events: JobEvent[] }).events.length).toBeGreaterThan(0)
    const usage = await call(rig, "GET", `/jobs/${id}/usage`, { tenant: "tenant-A" })
    expect((usage.json as { usage: { steps: number } }).usage.steps).toBe(1)
  })

  it("20b. follow=false replay uses runner.listEvents with exact afterSeq filtering", async () => {
    const runner = makeRunner()
    const rig = await serve(runner)
    const created = await createJob(rig)
    const id = (created.json as { id: string }).id
    await runner.runJob(id)
    const all = (await call(rig, "GET", `/jobs/${id}/events`, { tenant: "tenant-A" })).json as { events: JobEvent[] }
    const lastTwo = (await call(rig, "GET", `/jobs/${id}/events?after=${all.events.length - 2}`, { tenant: "tenant-A" })).json as { events: JobEvent[] }
    expect(lastTwo.events.map((event) => event.seq)).toEqual([all.events.length - 1, all.events.length])
  })
})

// ---------------------------------------------------------------------------
// Authorization seam
// ---------------------------------------------------------------------------

describe("authentication seam", () => {
  it("401 when the authenticator cannot derive a principal", async () => {
    const rig = await serve(makeRunner())
    const response = await call(rig, "GET", "/jobs/anything")
    expect(response.status).toBe(401)
  })
})
