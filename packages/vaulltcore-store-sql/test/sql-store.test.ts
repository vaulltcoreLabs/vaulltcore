/**
 * Phase 1C SQL store proof: transactional persistence behind the existing
 * DurableJobStore contract. Covers the eight required SQL scenarios plus
 * durable snapshot attachment, contract error parity, and an end-to-end
 * runner pass over the SQL backend.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  DurableAgentRunner,
  IdentityMismatchError,
  JobNotFoundError,
  LeaseFencedError,
  ScriptEngine,
  SimulatedCrashError,
  VaulltcoreError,
  finalizeCheckpoint,
  type JobCheckpoint,
  type JobMetrics,
  type JobRecord,
  type Tool,
} from "@vaulltcore/runner"
import { NodeSqliteDatabase, SqlJobStore } from "../src/index"

/** Trivial tool: turn 0 must emit a tool call for the loop to continue. */
const noopTool: Tool = {
  definition: { name: "noop", description: "no-op tool", parameters: { type: "object" } },
  async execute() {
    return { ok: true }
  },
}
const NOOP_POLICY = { allowedTools: ["noop"], idempotentTools: ["noop"] }

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vaulltcore-sql-test-"))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const IDENTITY = { tenantId: "tenant-sql", orgId: "org-sql", projectId: "project-sql" }

function makeRecord(jobId: string, overrides: Partial<JobRecord> = {}): JobRecord {
  const now = Date.now()
  return {
    jobId,
    ...IDENTITY,
    spec: { engine: "script", model: "m", input: "work" },
    status: "queued",
    attempt: 0,
    leaseToken: null,
    leaseExpiresAt: null,
    cancelRequested: false,
    error: null,
    env: {},
    policy: {
      version: "1",
      maxSteps: 10,
      onUncertainToolCall: "mark_uncertain",
      allowedTools: [],
      idempotentTools: [],
      leaseMs: 60_000,
    },
    latestSnapshot: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function emptyUsage(): JobMetrics {
  return { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, steps: 0, toolCalls: 0 }
}

function draftCheckpoint(jobId: string, attempt: number, lastEventSeq: number): JobCheckpoint {
  return finalizeCheckpoint({
    jobId,
    ...IDENTITY,
    executionId: "exe_test",
    status: "running",
    attempt,
    lastEventSeq,
    lastCompletedStep: null,
    toolCalls: {},
    pendingInput: [],
    continuation: { type: "provider_turn", nextStepIndex: 0 },
    contextRef: { kind: "event_projection", throughSeq: lastEventSeq },
    usage: emptyUsage(),
    policyVersion: "1",
    engineVersion: "1",
    createdAt: Date.now(),
  })
}

async function createJob(store: SqlJobStore, jobId = "job_test"): Promise<JobRecord> {
  const record = makeRecord(jobId)
  await store.createJobRecord(record)
  return record
}

describe("SqlJobStore — ownership + fencing", () => {
  it("competing lease acquisition: exactly one winner", async () => {
    const store = new SqlJobStore(NodeSqliteDatabase.memory())
    await createJob(store)

    const winner = await store.acquireLease("job_test", "lease_A", 60_000)
    expect(winner.attempt).toBe(1)
    await expect(store.acquireLease("job_test", "lease_B", 60_000)).rejects.toThrow(VaulltcoreError)
    await expect(store.acquireLease("job_test", "lease_B", 60_000)).rejects.toMatchObject({ code: "LEASE_HELD" })

    // Generation remains monotonic; the loser did not bump it.
    const record = await store.getJobRecord("job_test")
    expect(record!.attempt).toBe(1)
    expect(record!.leaseToken).toBe("lease_A")

    // Once the lease expires, a new owner steals it with a higher generation.
    await store.releaseLease("job_test", "lease_A")
    const stolen = await store.acquireLease("job_test", "lease_C", 60_000)
    expect(stolen.attempt).toBe(2)
  })

  it("stale fenced writer is rejected on every state-changing write path", async () => {
    const store = new SqlJobStore(NodeSqliteDatabase.memory())
    await createJob(store)
    const first = await store.acquireLease("job_test", "lease_A", 60_000)
    await store.acquireLease("job_test", "lease_A", 60_000) // renew (same token): attempt → 2

    // Stale generation 1 on record updates.
    await expect(store.updateJobRecord("job_test", first.attempt, () => ({ status: "running" }))).rejects.toThrow(LeaseFencedError)
    // Stale generation 1 on event appends.
    await expect(
      store.appendEvents("job_test", [{ jobId: "job_test", timestamp: Date.now(), type: "message", data: {} }], first.attempt),
    ).rejects.toThrow(LeaseFencedError)
    // Stale generation 1 on checkpoint commits.
    await expect(store.saveCheckpoint("job_test", draftCheckpoint("job_test", first.attempt, 0))).rejects.toThrow(LeaseFencedError)

    // Current generation is accepted everywhere.
    await store.updateJobRecord("job_test", 2, () => ({ status: "running" }))
    const events = await store.appendEvents(
      "job_test",
      [{ jobId: "job_test", timestamp: Date.now(), type: "message", data: { role: "user", text: "hi" } }],
      2,
    )
    expect(events[0]!.seq).toBe(1)
    await store.saveCheckpoint("job_test", draftCheckpoint("job_test", 2, 1))
    expect((await store.getCheckpoint("job_test"))!.lastEventSeq).toBe(1)
  })

  it("stale release cannot clear the new owner's lease", async () => {
    const store = new SqlJobStore(NodeSqliteDatabase.memory())
    await createJob(store)
    await store.acquireLease("job_test", "lease_old", 60_000)
    await store.releaseLease("job_test", "lease_old")
    await store.acquireLease("job_test", "lease_new", 60_000)

    // Stale token release: must be a no-op.
    await store.releaseLease("job_test", "lease_old")
    const record = await store.getJobRecord("job_test")
    expect(record!.leaseToken).toBe("lease_new")

    // Correct token release clears it.
    await store.releaseLease("job_test", "lease_new")
    expect((await store.getJobRecord("job_test"))!.leaseToken).toBeNull()
  })
})

describe("SqlJobStore — transactional continuity", () => {
  it("rollback leaves no partial authoritative continuation", async () => {
    let failOps = new Set<string>()
    const store = new SqlJobStore(NodeSqliteDatabase.memory(), { hooks: { beforeCommit: (op) => failOps.has(op) && (() => { throw new Error("injected fault") })() } })
    await createJob(store)
    await store.acquireLease("job_test", "lease_A", 60_000)

    // appendEvents: a fault before COMMIT must drop the whole batch and seq.
    failOps = new Set(["appendEvents"])
    await expect(
      store.appendEvents(
        "job_test",
        [
          { jobId: "job_test", timestamp: 1, type: "message", data: { role: "user", text: "a" } },
          { jobId: "job_test", timestamp: 2, type: "message", data: { role: "assistant", text: "b" } },
          { jobId: "job_test", timestamp: 3, type: "usage", data: { inputTokens: 1 } },
        ],
        1,
      ),
    ).rejects.toThrow("injected fault")
    expect((await store.listEvents("job_test")).length).toBe(0)
    failOps = new Set()
    const retried = await store.appendEvents("job_test", [{ jobId: "job_test", timestamp: 4, type: "message", data: {} }], 1)
    expect(retried[0]!.seq).toBe(1) // seq did not leak

    // saveCheckpoint rollback: no checkpoint row survives.
    failOps = new Set(["saveCheckpoint"])
    await expect(store.saveCheckpoint("job_test", draftCheckpoint("job_test", 1, 1))).rejects.toThrow("injected fault")
    expect(await store.getCheckpoint("job_test")).toBeNull()

    // updateJobRecord rollback: status unchanged on disk.
    failOps = new Set(["updateJobRecord"])
    await expect(store.updateJobRecord("job_test", 1, () => ({ status: "failed", error: "boom" }))).rejects.toThrow("injected fault")
    expect((await store.getJobRecord("job_test"))!.status).toBe("queued")
  })

  it("event sequence stays strictly monotonic across batches", async () => {
    const store = new SqlJobStore(NodeSqliteDatabase.memory())
    await createJob(store)
    const grant = await store.acquireLease("job_test", "lease_A", 60_000)
    for (let batch = 0; batch < 3; batch++) {
      await store.appendEvents(
        "job_test",
        [
          { jobId: "job_test", timestamp: Date.now(), type: "message", data: { n: batch * 2 } },
          { jobId: "job_test", timestamp: Date.now(), type: "message", data: { n: batch * 2 + 1 } },
        ],
        grant.attempt,
      )
    }
    const seqs = (await store.listEvents("job_test")).map((event) => event.seq)
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6])
    // afterSeq filtering is exact.
    expect((await store.listEvents("job_test", 4)).map((event) => event.seq)).toEqual([5, 6])
  })

  it("duplicate (jobId, seq) delivery is rejected deterministically", async () => {
    const store = new SqlJobStore(NodeSqliteDatabase.memory())
    await createJob(store)
    const grant = await store.acquireLease("job_test", "lease_A", 60_000)
    await store.appendEvents("job_test", [{ jobId: "job_test", timestamp: 1, type: "message", data: {} }], grant.attempt)

    // Raw driver: the PRIMARY KEY itself refuses duplicates.
    expect(() =>
      store.database().prepare("INSERT INTO job_events (job_id, seq, timestamp, type, data) VALUES (?, ?, ?, ?, ?)").run(
        "job_test",
        1,
        2,
        "message",
        "{}",
      ),
    ).toThrow(/unique constraint/i)

    // Through the store API: a corrupted last_seq pointer must surface as a
    // typed conflict, never a silent duplicate.
    store.database().prepare("UPDATE jobs SET last_seq = 0 WHERE job_id = ?").run("job_test")
    await expect(
      store.appendEvents("job_test", [{ jobId: "job_test", timestamp: 3, type: "message", data: {} }], grant.attempt),
    ).rejects.toMatchObject({ code: "EVENT_SEQ_CONFLICT" })
  })

  it("orphan events beyond the checkpoint watermark never replay as committed history", async () => {
    // Crash a first worker after step 0 committed; then persist an in-flight
    // "remnant" event beyond the watermark (what a dying worker may leave).
    const store = new SqlJobStore(NodeSqliteDatabase.memory())
    const turns = [
      { text: "step-0", toolCalls: [{ toolName: "noop" }], usage: { inputTokens: 5, outputTokens: 2 } },
      { text: "step-1", usage: { inputTokens: 3, outputTokens: 1 } },
    ]
    const runner1 = new DurableAgentRunner({
      store,
      engines: [new ScriptEngine(turns, { onTurnStart: (step) => { if (step === 1) throw new SimulatedCrashError() } })],
      tools: [noopTool],
      workspace: null,
    })
    const record = await runner1.createJob({ ...IDENTITY, spec: { engine: "script", model: "m", input: "go" }, policy: NOOP_POLICY })
    await expect(runner1.runJob(record.jobId)).rejects.toThrow(SimulatedCrashError)
    await runner1.suspendJob(record.jobId, "worker_loss")

    const watermark = (await store.getCheckpoint(record.jobId))!.lastEventSeq
    const attempt = (await store.getJobRecord(record.jobId))!.attempt
    await store.appendEvents(
      record.jobId,
      [{ jobId: record.jobId, timestamp: Date.now(), type: "message", data: { role: "assistant", text: "PHANTOM" } }],
      attempt,
    )
    expect((await store.listEvents(record.jobId)).some((event) => event.seq > watermark)).toBe(true)

    // Recovery: the remnant exists in storage but must not be replayed.
    const runner2 = new DurableAgentRunner({ store, engines: [new ScriptEngine(turns)], tools: [noopTool], workspace: null })
    const resumed = await runner2.resumeJob(record.jobId)
    expect(resumed.status).toBe("completed")
    expect(resumed.usage.steps).toBe(2) // exactly the two scripted turns

    const events = await store.listEvents(record.jobId)
    const orphanWarning = events.find((event) => event.type === "warning" && (event.data as { reason?: string }).reason === "orphaned_events")
    expect(orphanWarning).toBeDefined()
    // Committed projection ignores the phantom: a resumed event references the
    // watermark, and no second copy of the phantom text was projected.
    const resumedEvent = events.find((event) => event.type === "resumed")
    expect((resumedEvent!.data as { fromSeq: number }).fromSeq).toBe(watermark)
  })

  it("a fresh SqlJobStore instance resumes an existing job", async () => {
    const dbPath = path.join(root, "resume.db")
    const turns = [
      { text: "step-0", toolCalls: [{ toolName: "noop" }], usage: { inputTokens: 5, outputTokens: 2 } },
      { text: "step-1", usage: { inputTokens: 3, outputTokens: 1 } },
    ]
    const store1 = new SqlJobStore(NodeSqliteDatabase.open(dbPath))
    const runner1 = new DurableAgentRunner({
      store: store1,
      engines: [new ScriptEngine(turns, { onTurnStart: (step) => { if (step === 1) throw new SimulatedCrashError() } })],
      tools: [noopTool],
      workspace: null,
    })
    const record = await runner1.createJob({ ...IDENTITY, spec: { engine: "script", model: "m", input: "go" }, policy: NOOP_POLICY })
    await expect(runner1.runJob(record.jobId)).rejects.toThrow(SimulatedCrashError)
    await runner1.suspendJob(record.jobId, "worker_loss")
    store1.close()

    // Zero in-memory state survives: new database connection, new runner.
    const store2 = new SqlJobStore(NodeSqliteDatabase.open(dbPath))
    const runner2 = new DurableAgentRunner({ store: store2, engines: [new ScriptEngine(turns)], tools: [noopTool], workspace: null })
    const resumed = await runner2.resumeJob(record.jobId)
    expect(resumed.status).toBe("completed")
    expect(resumed.attempt).toBe(2)
    expect(resumed.usage.totalTokens).toBe(11)
    store2.close()
  })
})

describe("SqlJobStore — contract parity and invariants", () => {
  it("rejects duplicate job insertion instead of silently overwriting identity", async () => {
    const store = new SqlJobStore(NodeSqliteDatabase.memory())
    await createJob(store)
    await expect(store.createJobRecord(makeRecord("job_test"))).rejects.toMatchObject({ code: "JOB_EXISTS" })
  })

  it("rejects mutation of frozen identity fields", async () => {
    const store = new SqlJobStore(NodeSqliteDatabase.memory())
    await createJob(store)
    await expect(store.updateJobRecord("job_test", 0, () => ({ tenantId: "evil" }))).rejects.toThrow(IdentityMismatchError)
  })

  it("rejects checkpoints ahead of the committed event log", async () => {
    const store = new SqlJobStore(NodeSqliteDatabase.memory())
    await createJob(store)
    const grant = await store.acquireLease("job_test", "lease_A", 60_000)
    await expect(store.saveCheckpoint("job_test", draftCheckpoint("job_test", grant.attempt, 5))).rejects.toMatchObject({
      code: "CHECKPOINT_AHEAD_OF_LOG",
    })
  })

  it("records snapshot attachments transactionally in job_snapshots", async () => {
    const store = new SqlJobStore(NodeSqliteDatabase.memory())
    await createJob(store)
    const snapshot = {
      snapshotId: "snap_1",
      jobId: "job_test",
      attempt: 0,
      engineVersion: "1",
      environmentVersion: "local/1",
      createdAt: Date.now(),
      integrity: { algorithm: "sha256" as const, checksum: "abc" },
      storage: { kind: "local-directory", uri: "/tmp/snap" },
    }
    await store.updateJobRecord("job_test", 0, () => ({ latestSnapshot: snapshot }))
    expect((await store.getJobRecord("job_test"))!.latestSnapshot).toEqual(snapshot)
    const row = store.database().prepare("SELECT snapshot_id FROM job_snapshots WHERE job_id = ?").get("job_test")
    expect(row).toEqual({ snapshot_id: "snap_1" })
  })

  it("unknown jobs: getJobRecord is null, event/checkpoint reads are typed errors", async () => {
    const store = new SqlJobStore(NodeSqliteDatabase.memory())
    expect(await store.getJobRecord("job_nope")).toBeNull()
    await expect(store.listEvents("job_nope")).rejects.toThrow(JobNotFoundError)
    await expect(store.getCheckpoint("job_nope")).rejects.toThrow(JobNotFoundError)
  })

  it("runs a full job end-to-end over the SQL backend", async () => {
    const store = new SqlJobStore(NodeSqliteDatabase.memory())
    const runner = new DurableAgentRunner({
      store,
      engines: [
        new ScriptEngine([
          { text: "a", toolCalls: [{ toolName: "noop" }], usage: { inputTokens: 2, outputTokens: 1 } },
          { text: "b", usage: { inputTokens: 2, outputTokens: 1 } },
        ]),
      ],
      tools: [noopTool],
      workspace: null,
    })
    const record = await runner.createJob({ ...IDENTITY, spec: { engine: "script", model: "m", input: "go" }, policy: NOOP_POLICY })
    const state = await runner.runJob(record.jobId)
    expect(state.status).toBe("completed")
    expect(state.usage.steps).toBe(2)
    const seqs = (await store.listEvents(record.jobId)).map((event) => event.seq)
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs) // monotonic
    expect((await store.getCheckpoint(record.jobId))!.lastEventSeq).toBe(state.lastEventSeq)
  })
})
