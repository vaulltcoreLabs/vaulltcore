/**
 * Phase 1C cloud execution environment proof: the six required scenarios plus
 * capability reporting and reattachment. All tests run against the
 * deterministic FakeCloudProvider — no cloud credentials.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import {
  canonicalize,
  DurableAgentRunner,
  FileJobStore,
  ScriptEngine,
  SimulatedCrashError,
  VaulltcoreError,
  type ExecutionSnapshot,
  type JobEvent,
  type Tool,
} from "@vaulltcore/runner"
import { CapabilityUnsupportedError, FakeCloudProvider } from "../src/index"
import { CloudExecutionEnvironment } from "../src/environment"

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vaulltcore-cloud-test-"))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const IDENTITY = { tenantId: "tenant-cloud", orgId: "org-cloud", projectId: "project-cloud" }

const noopTool: Tool = {
  definition: { name: "noop", description: "no-op tool", parameters: { type: "object" } },
  async execute() {
    return { ok: true }
  },
}
const NOOP_POLICY = { allowedTools: ["noop"], idempotentTools: ["noop"] }

const TURNS = [
  { text: "step-0", toolCalls: [{ toolName: "noop" }], usage: { inputTokens: 5, outputTokens: 2 } },
  { text: "step-1", usage: { inputTokens: 3, outputTokens: 1 } },
]

interface Rig {
  runner: DurableAgentRunner
  store: FileJobStore
  provider: FakeCloudProvider
  environment: CloudExecutionEnvironment
}

function makeRig(provider: FakeCloudProvider, opts: { crashAtStep?: number } = {}): Rig {
  const environment = new CloudExecutionEnvironment(provider)
  const store = new FileJobStore(path.join(root, "store"))
  const engine = new ScriptEngine(TURNS, {
    onTurnStart: (step) => {
      if (step === opts.crashAtStep) throw new SimulatedCrashError()
    },
  })
  const runner = new DurableAgentRunner({ store, engines: [engine], tools: [noopTool], workspace: null, environment })
  return { runner, store, provider, environment }
}

async function allEvents(rig: Rig, jobId: string): Promise<JobEvent[]> {
  return rig.store.listEvents(jobId)
}

/** Suspend a job safely (post-crash or post-completion boundary). */
async function runUntilCrash(rig: Rig, identity = IDENTITY) {
  const record = await rig.runner.createJob({ ...identity, spec: { engine: "script", model: "m", input: "go" }, policy: NOOP_POLICY })
  await expect(rig.runner.runJob(record.jobId)).rejects.toThrow(SimulatedCrashError)
  await rig.runner.suspendJob(record.jobId, "worker_loss")
  return record
}

describe("CloudExecutionProvider — lifecycle dispatch", () => {
  it("dispatches the full lifecycle through the provider seam", async () => {
    const provider = new FakeCloudProvider()
    const env = new CloudExecutionEnvironment(provider)
    const jobId = "job_dispatch"
    const name = `vaulltcore-${createHash("sha256").update(jobId).digest("hex")}`

    await env.create(jobId)
    const handle = (await provider.inspect({ name })).handle
    expect(provider.calls.slice(0, 3)).toEqual([`inspect:${name}`, `provision:${name}`, `start:${handle.sandboxId}`])

    // Deterministic reattach: a second create uses the same sandbox.
    await env.create(jobId)
    expect(provider.calls.filter((c) => c.startsWith("provision"))).toHaveLength(1)

    await provider.execute(handle, "write", ["a.txt", "hello"])
    const read = await provider.execute(handle, "read", ["a.txt"])
    expect(read.stdout).toBe("hello")

    const lines: string[] = []
    for await (const line of provider.stream(handle)) lines.push(line)
    expect(lines).toContain("wrote a.txt")

    const ref = await provider.snapshot(handle)
    await provider.suspend(handle)
    expect((await provider.inspect({ name })).status).toBe("suspended")
    await provider.resumeSandbox(handle)
    await provider.terminate(handle)
    expect((await provider.inspect({ name })).status).toBe("terminated")

    const expected = [
      "execute:write",
      "execute:read",
      "stream",
      "snapshot",
      "suspend",
      "inspect:" + name,
      "resumeSandbox",
      "terminate:" + handle.sandboxId,
    ]
    for (const op of expected) expect(provider.calls).toContain(op)
  })
})

describe("CloudExecutionEnvironment — native snapshot/restore", () => {
  it("captures and restores natively when the capability exists", async () => {
    const provider = new FakeCloudProvider()
    const rig1 = makeRig(provider, { crashAtStep: 1 })
    const record = await runUntilCrash(rig1)
    const attached = (await rig1.store.getJobRecord(record.jobId))!.latestSnapshot
    expect(attached).not.toBeNull()
    expect(attached!.storage.kind).toBe("cloud-sandbox-image")

    const rig2 = makeRig(provider)
    const resumed = await rig2.runner.resumeJob(record.jobId)
    expect(resumed.status).toBe("completed")
    const events = await allEvents(rig2, record.jobId)
    const resumeEvent = events.find((e) => e.type === "resumed")
    expect((resumeEvent!.data as { restoredFromSnapshot: boolean }).restoredFromSnapshot).toBe(true)
    expect(provider.calls).toContain("restore")
  })

  it("returns an explicit unsupported result when native snapshot is missing", async () => {
    const provider = new FakeCloudProvider({ capabilities: { nativeSnapshot: false } })
    const env = new CloudExecutionEnvironment(provider)

    // Environment-level: explicit null (never a pretend VM snapshot).
    expect(await env.snapshot({ id: "cloud:x", root: null }, { jobId: "x", attempt: 0, engineVersion: "1" })).toBeNull()

    // Full suspend flow: nothing attaches; the checkpoint remains the source.
    const rig = makeRig(provider, { crashAtStep: 1 })
    const record = await runUntilCrash(rig)
    const events = await allEvents(rig, record.jobId)
    const explicit = events.find((e) => e.type === "warning" && (e.data as { reason?: string }).reason === "snapshot_unsupported")
    expect(explicit).toBeDefined()
    expect((await rig.store.getJobRecord(record.jobId))!.latestSnapshot).toBeNull()

    // And logical resume still completes the job.
    const rig2 = makeRig(provider)
    const resumed = await rig2.runner.resumeJob(record.jobId)
    expect(resumed.status).toBe("completed")
    const resumeEvent = (await allEvents(rig2, record.jobId)).find((e) => e.type === "resumed")
    expect((resumeEvent!.data as { restoredFromSnapshot: boolean }).restoredFromSnapshot).toBe(false)
  })

  it("throws explicitly on restore when nativeRestore is unavailable", async () => {
    const provider = new FakeCloudProvider({ capabilities: { nativeRestore: false } })
    const env = new CloudExecutionEnvironment(provider)
    const snapshot: ExecutionSnapshot = {
      snapshotId: "snap_x",
      jobId: "job_x",
      attempt: 1,
      engineVersion: "1",
      environmentVersion: env.environmentVersion,
      createdAt: Date.now(),
      integrity: { algorithm: "sha256", checksum: "unused" },
      storage: { kind: "cloud-sandbox-image", uri: "fake://snapshots/n/a" },
    }
    await expect(env.restore(snapshot)).rejects.toThrow(CapabilityUnsupportedError)
  })

  it("reported capabilities mirror the provider's honest report", () => {
    const full = new CloudExecutionEnvironment(new FakeCloudProvider())
    expect(full.capabilities()).toEqual({ nativeSuspend: true, nativeSnapshot: true, nativeRestore: true, durableWorkspace: true })
    const limited = new CloudExecutionEnvironment(new FakeCloudProvider({ capabilities: { nativeSnapshot: false, durableWorkspace: false } }))
    expect(limited.capabilities().nativeSnapshot).toBe(false)
    expect(limited.capabilities().durableWorkspace).toBe(false)
  })
})

describe("CloudExecutionEnvironment — recovery integrity", () => {
  it("corrupt snapshot falls back with a warning to logical resume", async () => {
    const provider = new FakeCloudProvider()
    const rig1 = makeRig(provider, { crashAtStep: 1 })
    const record = await runUntilCrash(rig1)
    const attached = (await rig1.store.getJobRecord(record.jobId))!.latestSnapshot!

    // Flip bits in the provider-side payload.
    provider.corruptSnapshot(attached.storage.uri)

    const rig2 = makeRig(provider)
    const resumed = await rig2.runner.resumeJob(record.jobId)
    expect(resumed.status).toBe("completed")
    const events = await allEvents(rig2, record.jobId)
    const warning = events.find((e) => e.type === "warning" && (e.data as { reason?: string }).reason === "snapshot_restore_failed")
    expect(warning).toBeDefined()
    expect((warning!.data as { snapshotId: string }).snapshotId).toBe(attached.snapshotId)
    const resumeEvent = events.find((e) => e.type === "resumed")
    expect((resumeEvent!.data as { restoredFromSnapshot: boolean }).restoredFromSnapshot).toBe(false)
  })

  it("rejects a snapshot bound to a different job (tenant binding mismatch)", async () => {
    const provider = new FakeCloudProvider()
    const env = new CloudExecutionEnvironment(provider)
    const issued = await provider.provision("vaulltcore-tenant-A")
    await provider.start(issued)
    const ref = await provider.snapshot(issued)

    const foreign: ExecutionSnapshot = {
      snapshotId: ref.snapshotId,
      jobId: "job-tenant-B", // different jobId → binding must fail
      attempt: 1,
      engineVersion: "1",
      environmentVersion: env.environmentVersion,
      createdAt: ref.createdAt,
      integrity: { algorithm: "sha256", checksum: "passes-nothing" },
      storage: { kind: "cloud-sandbox-image", uri: ref.uri },
    }
    await expect(env.restore(foreign)).rejects.toMatchObject({ code: "SNAPSHOT_BINDING_MISMATCH" })
  })

  it("rejects a snapshot with a tampered integrity tag", async () => {
    const provider = new FakeCloudProvider()
    const env = new CloudExecutionEnvironment(provider)
    const name = `vaulltcore-${createHash("sha256").update("testjob").digest("hex")}`
    const issued = await provider.provision(name)
    await provider.start(issued)
    const ref = await provider.snapshot(issued)

    // First message: fully valid snapshot for job "testjob".
    const meta = await provider.inspectSnapshot(ref.uri)
    const tagInput = {
      jobId: "testjob",
      sandboxName: meta.sandboxName,
      payloadChecksum: meta.payloadChecksum,
      engineVersion: "1",
      environmentVersion: env.environmentVersion,
    }
    const tag = createHash("sha256").update(canonicalize(tagInput)).digest("hex")
    const valid: ExecutionSnapshot = {
      snapshotId: ref.snapshotId,
      jobId: "testjob",
      attempt: 1,
      engineVersion: "1",
      environmentVersion: env.environmentVersion,
      createdAt: ref.createdAt,
      integrity: { algorithm: "sha256", checksum: tag },
      storage: { kind: "cloud-sandbox-image", uri: ref.uri },
    }
    expect(await env.restore(valid)).toEqual({ id: "cloud:testjob", root: null })

    // One bit different in the tag → rejected.
    const tampered: ExecutionSnapshot = {
      ...valid,
      integrity: { algorithm: "sha256", checksum: tag.replace(/^./, tag[0] === "0" ? "1" : "0") },
    }
    await expect(env.restore(tampered)).rejects.toMatchObject({ code: "SNAPSHOT_INTEGRITY_MISMATCH" })
  })

  it("a fresh runner recovers with zero in-memory environment state", async () => {
    // The provider registry (the "cloud account") persists; the environment
    // object built for recovery holds nothing in memory.
    const provider = new FakeCloudProvider()
    const rig1 = makeRig(provider, { crashAtStep: 1 })
    const record = await runUntilCrash(rig1)

    const env2 = new CloudExecutionEnvironment(provider)
    const store2 = new FileJobStore(path.join(root, "store"))
    const runner2 = new DurableAgentRunner({ store: store2, engines: [new ScriptEngine(TURNS)], tools: [noopTool], workspace: null, environment: env2 })
    const resumed = await runner2.resumeJob(record.jobId)
    expect(resumed.status).toBe("completed")

    // Native compute continuity was actually used (not the logical fallback).
    const events = await store2.listEvents(record.jobId)
    const resumeEvent = events.find((e) => e.type === "resumed")
    expect((resumeEvent!.data as { restoredFromSnapshot: boolean }).restoredFromSnapshot).toBe(true)
    expect(provider.calls).toContain("restore")
  })
})
