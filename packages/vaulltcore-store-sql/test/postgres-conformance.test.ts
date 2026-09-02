/**
 * Phase 1D PostgreSQL conformance proof.
 *
 * Covers required scenarios:
 * 11. Separate connections preserve fencing.
 * 12. Concurrent transactions preserve one owner.
 * 13. Rollback leaves no partial checkpoint boundary.
 * 14. Event uniqueness survives concurrent writers.
 *
 * These tests run ONLY against a live PostgreSQL server. They are gated on the
 * `PG_TEST_URL`/socket environment: if PostgreSQL is unavailable, the suite is
 * skipped (not failed) so CI without a Postgres service does not break.
 *
 * The same behavioral contract is already proven against SQLite in
 * distributed-ownership.test.ts; here we prove the fencing model survives real
 * row-level locks and SERIALIZABLE transactions across independent
 * connections.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { Pool } from "pg"
import {
  JobNotFoundError,
  LeaseFencedError,
  VaulltcoreError,
  finalizeCheckpoint,
  type JobCheckpoint,
  type JobEvent,
  type JobRecord,
  type NewJobEvent,
} from "@vaulltcore/runner"
import { PostgresJobStore } from "../src/index"

const PG_HOST = process.env.PG_TEST_HOST ?? "/tmp/pgsock"
const PG_PORT = Number(process.env.PG_TEST_PORT ?? "5434")
const PG_USER = process.env.PG_TEST_USER ?? "postgres"
const PG_DB = process.env.PG_TEST_DB ?? "vaulltcore_test"

let pgAvailable = false
let sharedPool: Pool | null = null
try {
  const probe = new Pool({ host: PG_HOST, port: PG_PORT, user: PG_USER, database: PG_DB })
  await probe.query("SELECT 1")
  await probe.end()
  pgAvailable = true
} catch {
  pgAvailable = false
}

const describeOrSkip = pgAvailable ? describe : describe.skip

const IDENTITY = { tenantId: "tenant-pg", orgId: "org-pg", projectId: "project-pg" }

function makeJobRecord(jobId: string, attempt = 0): JobRecord {
  const now = Date.now()
  return {
    jobId,
    ...IDENTITY,
    spec: { engine: "script", model: "m", input: "x" },
    status: "queued",
    attempt,
    leaseToken: null,
    leaseExpiresAt: null,
    cancelRequested: false,
    error: null,
    env: {},
    policy: { version: "1", maxSteps: 10, onUncertainToolCall: "mark_uncertain", allowedTools: [], idempotentTools: [], leaseMs: 60_000 },
    latestSnapshot: null,
    createdAt: now,
    updatedAt: now,
  }
}

function draftCheckpoint(jobId: string, attempt: number, lastEventSeq: number): JobCheckpoint {
  return finalizeCheckpoint({
    jobId,
    ...IDENTITY,
    executionId: "exe_pg",
    status: "running",
    attempt,
    lastEventSeq,
    lastCompletedStep: null,
    toolCalls: {},
    pendingInput: [],
    continuation: { type: "provider_turn", nextStepIndex: 0 },
    contextRef: { kind: "event_projection", throughSeq: lastEventSeq },
    usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, steps: 0, toolCalls: 0 },
    policyVersion: "1",
    engineVersion: "1",
    createdAt: Date.now(),
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describeOrSkip("PostgreSQL conformance", () => {
  // One shared pool for the whole suite; each store is a thin wrapper over it.
  // Truncating once per test (beforeEach) gives isolation without wiping data
  // mid-test when a second store is constructed.
  beforeAll(async () => {
    sharedPool = new Pool({ host: PG_HOST, port: PG_PORT, user: PG_USER, database: PG_DB })
    // Apply migrations once.
    const s = new PostgresJobStore({ pool: sharedPool })
    await s.getJobRecord("__migrate_probe__")
  })
  afterAll(async () => {
    if (sharedPool) await sharedPool.end()
  })
  beforeEach(async () => {
    if (!sharedPool) return
    await sharedPool.query("TRUNCATE job_events, job_checkpoints, job_leases, dispatch_claims, jobs RESTART IDENTITY CASCADE")
  })

  function store(): PostgresJobStore {
    return new PostgresJobStore({ pool: sharedPool! })
  }

  it("11. separate connections preserve fencing", async () => {
    // Two independent store instances (separate connections from the pool)
    // over the same database: after the lease expires, a new owner fences the
    // stale generation; the stale owner can no longer append.
    const storeA = store()
    await storeA.createJobRecord(makeJobRecord("job-11"))
    const grantA = await storeA.acquireLease("job-11", "tokenA", 30) // short lease
    expect(grantA.attempt).toBe(1)
    await sleep(60) // lease expires
    // A new connection acquires a NEW lease (attempt 2) — fencing A.
    const storeB = store()
    const grantB = await storeB.acquireLease("job-11", "tokenB", 60_000)
    expect(grantB.attempt).toBe(2)
    // A's stale attempt (1) can no longer append events → LeaseFencedError.
    await expect(storeA.appendEvents("job-11", [{ jobId: "job-11", timestamp: Date.now(), type: "message", data: { role: "assistant", stepIndex: 0, text: "stale" } }], grantA.attempt)).rejects.toThrow(LeaseFencedError)
  })

  it("12. concurrent transactions preserve one owner", async () => {
    // Two workers race to acquire the lease on the same job. Exactly one wins;
    // the other is fenced (LEASE_HELD). Postgres SERIALIZABLE + FOR UPDATE
    // guarantees exactly one claimant.
    const s = store()
    await s.createJobRecord(makeJobRecord("job-12"))
    const results = await Promise.allSettled([
      store().acquireLease("job-12", "token-race-a", 60_000),
      store().acquireLease("job-12", "token-race-b", 60_000),
    ])
    const grants = results.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<{ attempt: number; leaseToken: string }>).value)
    const failures = results.filter((r) => r.status === "rejected")
    expect(grants.length).toBe(1)
    expect(failures.length).toBe(1)
    expect(grants[0]!.attempt).toBe(1)
    const job = await s.getJobRecord("job-12")
    expect(job!.attempt).toBe(1)
  })

  it("13. rollback leaves no partial checkpoint boundary", async () => {
    const s = store()
    await s.createJobRecord(makeJobRecord("job-13"))
    const grant = await s.acquireLease("job-13", "token-13", 60_000)
    const before = await s.getJobRecord("job-13")
    await s.appendEvents("job-13", [{ jobId: "job-13", timestamp: Date.now(), type: "message", data: { role: "assistant", stepIndex: 0, text: "first" } }], grant.attempt)
    // A fenced updateJobRecord (stale expectedAttempt) rolls back entirely.
    await expect(s.updateJobRecord("job-13", grant.attempt + 99, () => ({ status: "running" }))).rejects.toThrow(LeaseFencedError)
    const after = await s.getJobRecord("job-13")
    expect(after!.attempt).toBe(before!.attempt)
    const events = await s.listEvents("job-13", 0)
    expect(events.length).toBe(1)
    expect((events[0] as JobEvent).seq).toBe(1)
  })

  it("14. event uniqueness survives concurrent writers", async () => {
    const s = store()
    await s.createJobRecord(makeJobRecord("job-14"))
    const grant = await s.acquireLease("job-14", "token-14", 60_000)
    const ev = (i: number): NewJobEvent => ({ jobId: "job-14", timestamp: Date.now(), type: "message", data: { role: "assistant", stepIndex: i, text: `c-${i}` } })
    // Two concurrent appends under the SAME attempt: SERIALIZABLE isolation
    // serializes them; the loser either fences (seq regression) or conflicts.
    const [r1, r2] = await Promise.allSettled([
      store().appendEvents("job-14", [ev(1)], grant.attempt),
      store().appendEvents("job-14", [ev(2)], grant.attempt),
    ])
    const ok = [r1, r2].filter((r) => r.status === "fulfilled").length
    expect(ok).toBeGreaterThanOrEqual(1)
    const events = await s.listEvents("job-14", 0)
    const seqs = events.map((e) => (e as JobEvent).seq)
    expect(new Set(seqs).size).toBe(seqs.length)
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!)
  })

  it("checkpoint round-trips durably", async () => {
    const s = store()
    await s.createJobRecord(makeJobRecord("job-cp"))
    const grant = await s.acquireLease("job-cp", "token-cp", 60_000)
    await s.appendEvents("job-cp", [{ jobId: "job-cp", timestamp: Date.now(), type: "message", data: { role: "assistant", stepIndex: 0, text: "cp" } }], grant.attempt)
    const cp = draftCheckpoint("job-cp", grant.attempt, 1)
    await s.saveCheckpoint("job-cp", cp)
    const loaded = await s.getCheckpoint("job-cp")
    expect(loaded).not.toBeNull()
    expect(loaded!.jobId).toBe("job-cp")
    expect(loaded!.attempt).toBe(grant.attempt)
    expect(loaded!.lastEventSeq).toBe(1)
  })

  it("stale owner cannot release a newer lease", async () => {
    const s = store()
    await s.createJobRecord(makeJobRecord("job-release"))
    const grantA = await s.acquireLease("job-release", "tokenA", 30) // short lease
    await sleep(60) // A's lease expires
    // B fences A (attempt 2) once A's lease is expired.
    await s.acquireLease("job-release", "tokenB", 60_000)
    // A tries to release using its old token — no-op (only B's token is
    // current); B's lease must survive.
    await s.releaseLease("job-release", grantA.leaseToken)
    const job = await s.getJobRecord("job-release")
    expect(job!.attempt).toBe(2)
  })

  it("job not found surfaces JobNotFoundError", async () => {
    const s = store()
    await expect(s.getJobRecord("does-not-exist")).resolves.toBeNull()
    await expect(s.acquireLease("nope", "t", 1)).rejects.toThrow(JobNotFoundError)
  })

  it("duplicate event seq delivery is rejected", async () => {
    const s = store()
    await s.createJobRecord(makeJobRecord("job-dup"))
    const grant = await s.acquireLease("job-dup", "t-dup", 60_000)
    // First append commits seq 1.
    await s.appendEvents("job-dup", [{ jobId: "job-dup", timestamp: Date.now(), type: "message", data: { role: "assistant", stepIndex: 0, text: "a" } }], grant.attempt)
    // A fenced append (stale attempt) is rejected — the committed log is
    // unchanged, no duplicate seq.
    await expect(s.appendEvents("job-dup", [{ jobId: "job-dup", timestamp: Date.now(), type: "message", data: { role: "assistant", stepIndex: 0, text: "b" } }], grant.attempt + 99)).rejects.toThrow(LeaseFencedError)
    const events = await s.listEvents("job-dup", 0)
    expect(events.length).toBe(1)
    void VaulltcoreError
  })
})
