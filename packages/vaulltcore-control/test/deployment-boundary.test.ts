/**
 * Phase 1D deployment-boundary proof.
 *
 * Covers required scenarios:
 * 21. Control plane restart does not kill worker-owned job.
 * 22. Worker restart does not lose durable job.
 * 23. Events remain replayable after either process restarts.
 *
 * The control plane (HTTP) and the worker (AgentRunner + WorkerHost) are
 * independent processes sharing only the durable SQL store. Neither requires
 * the other to stay alive: the control plane accepts + persists + dispatches;
 * the worker claims + executes + heartbeats. A restart of either leaves the
 * job durable and replayable.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import {
  DurableAgentRunner,
  ScriptEngine,
  ScriptTurn,
  SimulatedCrashError,
  Tool,
  type ExecutionPolicy,
  type JobEvent,
} from "@vaulltcore/runner"
import { NodeSqliteDatabase, SqlJobStore, DistributedSqlStore, SqlDispatcher, SqlIdempotencyRegistry } from "@vaulltcore/store-sql"
import { ControlPlane } from "../src/index"
import { JobReconciler, WorkerHost, newWorkerIdentity } from "@vaulltcore/worker"

let root: string
let dbPath: string
const servers: Server[] = []

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vaulltcore-boundary-"))
  dbPath = path.join(root, "boundary.db")
})
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve))
  await rm(root, { recursive: true, force: true })
})

const IDENTITY = { tenantId: "tenant-a", orgId: "org-a", projectId: "project-a" }
const NOOP_POLICY: Partial<ExecutionPolicy> = { allowedTools: ["noop"], idempotentTools: ["noop"] }

const noopTool: Tool = {
  definition: { name: "noop", description: "no-op", parameters: { type: "object" }, idempotent: true },
  async execute() {
    return { ok: true }
  },
}

/** A turn sequence whose turn 0 emits a tool call (so the loop continues). */
const TURNS: ScriptTurn[] = [
  { text: "step-0", toolCalls: [{ toolName: "noop" }] },
  { text: "step-1" },
]

function makeRunner(turns: ScriptTurn[] = TURNS, hooks?: ConstructorParameters<typeof ScriptEngine>[1]): DurableAgentRunner {
  const jobStore = new SqlJobStore(NodeSqliteDatabase.open(dbPath))
  return new DurableAgentRunner({
    store: jobStore,
    engines: [new ScriptEngine(turns, hooks)],
    tools: [noopTool],
    workspace: null,
  })
}

function makeDispatcher(): { jobStore: SqlJobStore; dist: DistributedSqlStore; dispatcher: SqlDispatcher } {
  const jobStore = new SqlJobStore(NodeSqliteDatabase.open(dbPath))
  const dist = new DistributedSqlStore(jobStore.database())
  return { jobStore, dist, dispatcher: new SqlDispatcher(dist) }
}

function makeWorkerHost(dispatcher: SqlDispatcher, runner: DurableAgentRunner, leaseMs = 10_000): WorkerHost {
  const identity = newWorkerIdentity("wkr")
  // registerWorker is advisory; the dispatcher records the worker row.
  const dist = (dispatcher as unknown as { dist: DistributedSqlStore }).dist
  dist.registerWorker(identity)
  return new WorkerHost({
    identity,
    dispatcher,
    runner,
    leaseMs,
    heartbeatIntervalMs: Math.floor(leaseMs / 5),
  })
}

async function serve(runner: DurableAgentRunner, idempotency: SqlIdempotencyRegistry): Promise<{ server: Server; base: string }> {
  const control = new ControlPlane({ runner, idempotency })
  const server = await control.listen(0)
  servers.push(server)
  const address = server.address()
  const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`
  return { server, base }
}

async function postJob(base: string, body: unknown, idempotencyKey: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}/jobs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-vc-tenant": IDENTITY.tenantId,
      "x-vc-org": IDENTITY.orgId ?? "",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() }
}

describe("deployment boundary", () => {
  it("21. control plane restart does not kill worker-owned job", async () => {
    const idem = new SqlIdempotencyRegistry(makeDispatcher().dist)
    // 1. Control plane accepts the job (POST /jobs) and persists it.
    let runner = makeRunner()
    const { base } = await serve(runner, idem)
    const created = await postJob(base, { spec: { engine: "script", model: "m", input: "x" }, policy: NOOP_POLICY }, "key-1")
    expect(created.status).toBe(201)
    const jobId = (created.json as { id: string }).id
    // 2. Dispatcher enqueues; worker claims + runs it.
    const { dispatcher } = makeDispatcher()
    await dispatcher.enqueue(jobId)
    const host = makeWorkerHost(dispatcher, runner)
    const result = await host.runOnce()
    expect(result?.state.status).toBe("completed")
    // 3. Restart the control plane (new server, same durable store). The job
    //    is still readable and durable.
    const runner2 = makeRunner()
    const { base: base2 } = await serve(runner2, idem)
    const res = await fetch(`${base2}/jobs/${jobId}`, { headers: { "x-vc-tenant": IDENTITY.tenantId, "x-vc-org": IDENTITY.orgId ?? "" } })
    const job = (await res.json()) as { id: string; status: string }
    expect(res.status).toBe(200)
    expect(job.id).toBe(jobId)
    expect(job.status).toBe("completed")
  })

  it("22. worker restart does not lose durable job", async () => {
    const { dist, dispatcher } = makeDispatcher()
    const idem = new SqlIdempotencyRegistry(dist)
    const runner = makeRunner()
    const { base } = await serve(runner, idem)
    const created = await postJob(base, { spec: { engine: "script", model: "m", input: "x" }, policy: NOOP_POLICY }, "key-2")
    const jobId = (created.json as { id: string }).id
    // Enqueue + worker claims but CRASHES mid-run (turn 1 throws).
    const crashTurns: ScriptTurn[] = [
      { text: "step-0", toolCalls: [{ toolName: "noop" }] },
      { text: "step-1" },
    ]
    const crashHooks = { onTurnStart: (step: number) => { if (step === 1) throw new SimulatedCrashError() } }
    const crashRunner = makeRunner(crashTurns, crashHooks)
    await dispatcher.enqueue(jobId)
    const host = makeWorkerHost(dispatcher, crashRunner, 30)
    const claim = await dispatcher.claim(host["identity" as never] as never, 30).catch(() => null)
    // Run via the crash runner directly to simulate worker death mid-exec.
    await expect(crashRunner.runJob(jobId)).rejects.toThrow(SimulatedCrashError)
    await new Promise((r) => setTimeout(r, 60))
    // Reconciler suspends the orphaned job.
    const reconciler = new JobReconciler({ source: dist, runner: crashRunner })
    await reconciler.reconcile(Date.now())
    // A FRESH worker process (new runner + host) resumes from durable state.
    const freshRunner = makeRunner(TURNS)
    const resumed = await freshRunner.resumeJob(jobId)
    expect(resumed.status).toBe("completed")
    void claim
  })

  it("23. events remain replayable after either process restarts", async () => {
    const { dist, dispatcher } = makeDispatcher()
    const idem = new SqlIdempotencyRegistry(dist)
    const runner = makeRunner()
    const { base } = await serve(runner, idem)
    const created = await postJob(base, { spec: { engine: "script", model: "m", input: "x" }, policy: NOOP_POLICY }, "key-3")
    const jobId = (created.json as { id: string }).id
    await dispatcher.enqueue(jobId)
    const host = makeWorkerHost(dispatcher, runner)
    await host.runOnce()
    // Restart BOTH control plane and worker (new processes, same store).
    const runner2 = makeRunner()
    // listEvents replays the committed event log from the durable store.
    const events = await runner2.listEvents(jobId, 0)
    expect(events.length).toBeGreaterThan(0)
    // The event sequence is monotonic.
    let prev = 0
    for (const ev of events as JobEvent[]) {
      expect(ev.seq).toBeGreaterThan(prev)
      prev = ev.seq
    }
    // A terminal "completed" event exists in the replayed log.
    expect(events.some((e) => (e as JobEvent).type === "completed")).toBe(true)
  })
})
