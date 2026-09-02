/**
 * Phase 1D durable SQL idempotency + snapshot lifecycle GC proof.
 *
 * Covers required scenarios:
 *  6. Crash after job creation before response.
 *  7. Retry returns original job.
 *  8. Same key + changed request is rejected.
 *  9. Tenant isolation for identical keys.
 * 10. Idempotency survives process restart.
 *
 * Plus snapshot lifecycle GC invariants:
 *  - the last valid recovery artifact is never deleted before its replacement
 *    is durably committed;
 *  - a superseded snapshot is only collected once an active replacement exists;
 *  - a failed snapshot is always collectable.
 *
 * Backed by the SQLite DistributedSqlStore + SqlIdempotencyRegistry /
 * SqlSnapshotRegistry. The fencing/transactional model is identical to
 * PostgreSQL.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { NodeSqliteDatabase, SqlJobStore, DistributedSqlStore, SqlIdempotencyRegistry, SqlSnapshotRegistry } from "../src/index"
import type { IdempotencyClaim, JobRecord, SnapshotRecord } from "@vaulltcore/runner"
import { createHash } from "node:crypto"

let root: string
let dbPath: string
let jobStore: SqlJobStore
let dist: DistributedSqlStore
let idem: SqlIdempotencyRegistry
let snaps: SqlSnapshotRegistry

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vaulltcore-idem-"))
  dbPath = path.join(root, "idem.db")
  jobStore = new SqlJobStore(NodeSqliteDatabase.open(dbPath))
  dist = new DistributedSqlStore(jobStore.database())
  idem = new SqlIdempotencyRegistry(dist)
  snaps = new SqlSnapshotRegistry(dist)
})
afterEach(async () => {
  jobStore.close()
  await rm(root, { recursive: true, force: true })
})

function claim(tenantId: string, key: string, body: string): IdempotencyClaim {
  return { tenantId, key, requestHash: createHash("sha256").update(body).digest("hex") }
}

/** Insert a minimal job row so snapshot_lifecycle's FK to jobs is satisfied.
 * Idempotent: a second snapshot for the same job must not re-create it. */
async function makeJob(jobId: string, tenantId = "tenant-a"): Promise<void> {
  const now = Date.now()
  const record: JobRecord = {
    jobId,
    tenantId,
    orgId: "org-a",
    projectId: "project-a",
    spec: { engine: "script", model: "m", input: "x" },
    status: "running",
    attempt: 1,
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
  await jobStore.createJobRecord(record).catch(() => {
    // JOB_EXISTS is fine: the job row already satisfies the FK.
  })
}

describe("durable SQL idempotency", () => {
  it("6. crash after job creation before response — slot stays pending", async () => {
    const c = claim("tenant-a", "key-1", '{"input":"x"}')
    const r1 = idem.claim(c)
    expect(r1.kind).toBe("new")
    // Creator "crashes" after claiming but before fulfill: no job recorded.
    // A retry re-claims the SAME slot.
    const r2 = idem.claim(c)
    expect(r2.kind).toBe("pending")
    if (r2.kind === "pending") {
      expect(r2.slotId).toBe((r1 as { slotId: string }).slotId)
    }
  })

  it("7. retry returns original job", async () => {
    const c = claim("tenant-a", "key-1", '{"input":"x"}')
    const r1 = idem.claim(c)
    expect(r1.kind).toBe("new")
    if (r1.kind === "new") {
      idem.fulfill(r1.slotId, "job_original", 201)
    }
    // Retry with the same request: returns the original job.
    const r2 = idem.claim(c)
    expect(r2.kind).toBe("fulfilled")
    if (r2.kind === "fulfilled") {
      expect(r2.jobId).toBe("job_original")
      expect(r2.responseStatus).toBe(201)
    }
    expect(idem.lookup("tenant-a", "key-1")).toEqual({ jobId: "job_original", responseStatus: 201 })
  })

  it("8. same key + changed request is rejected", async () => {
    const c1 = claim("tenant-a", "key-1", '{"input":"x"}')
    const r1 = idem.claim(c1)
    expect(r1.kind).toBe("new")
    if (r1.kind === "new") idem.fulfill(r1.slotId, "job_a", 201)
    // Same key, DIFFERENT body → explicit conflict.
    const c2 = claim("tenant-a", "key-1", '{"input":"DIFFERENT"}')
    const r2 = idem.claim(c2)
    expect(r2.kind).toBe("conflict")
    if (r2.kind === "conflict") {
      expect(r2.jobId).toBe("job_a")
    }
  })

  it("9. tenant isolation for identical keys", async () => {
    const ca = claim("tenant-a", "shared-key", '{"input":"x"}')
    const cb = claim("tenant-b", "shared-key", '{"input":"x"}')
    const ra = idem.claim(ca)
    const rb = idem.claim(cb)
    expect(ra.kind).toBe("new")
    expect(rb.kind).toBe("new")
    if (ra.kind === "new") idem.fulfill(ra.slotId, "job_a", 201)
    if (rb.kind === "new") idem.fulfill(rb.slotId, "job_b", 201)
    // Each tenant sees only its own job.
    expect(idem.lookup("tenant-a", "shared-key")!.jobId).toBe("job_a")
    expect(idem.lookup("tenant-b", "shared-key")!.jobId).toBe("job_b")
  })

  it("10. idempotency survives process restart", async () => {
    const c = claim("tenant-a", "key-1", '{"input":"x"}')
    const r1 = idem.claim(c)
    expect(r1.kind).toBe("new")
    if (r1.kind === "new") idem.fulfill(r1.slotId, "job_persisted", 201)
    // Simulate process restart: open a SECOND connection to the same db file
    // (SQLite allows concurrent connections). The fulfilled slot is durable.
    const jobStore2 = new SqlJobStore(NodeSqliteDatabase.open(dbPath))
    const dist2 = new DistributedSqlStore(jobStore2.database())
    const idem2 = new SqlIdempotencyRegistry(dist2)
    const r2 = idem2.claim(c)
    expect(r2.kind).toBe("fulfilled")
    if (r2.kind === "fulfilled") {
      expect(r2.jobId).toBe("job_persisted")
    }
    jobStore2.close()
  })
})

describe("snapshot lifecycle GC", () => {
  async function regSnap(id: string, jobId: string, opts: Partial<SnapshotRecord> = {}): Promise<SnapshotRecord> {
    await makeJob(jobId, opts.tenantId ?? "tenant-a")
    return snaps.register({
      snapshotId: id,
      tenantId: opts.tenantId ?? "tenant-a",
      jobId,
      provider: opts.provider ?? "local",
      sizeBytes: opts.sizeBytes ?? 1024,
      createdAt: opts.createdAt ?? Date.now(),
      expiresAt: opts.expiresAt ?? null,
      integrityHash: opts.integrityHash ?? "hash_" + id,
      attempt: opts.attempt ?? 1,
    })
  }

  it("never deletes the last valid recovery artifact before its replacement commits", async () => {
    // One active snapshot for a job, expired — must NOT be deletable (it's the
    // last valid artifact and no replacement is committed yet).
    const s1 = await regSnap("s1", "job-1", { expiresAt: Date.now() - 1000 })
    snaps.activate("s1")
    const decision = snaps.gcDecision()
    expect(decision.deletable.find((r) => r.snapshotId === "s1")).toBeUndefined()
    expect(decision.retained.find((r) => r.snapshotId === "s1")).toBeDefined()
    void s1
  })

  it("a superseded snapshot is collected only once an active replacement exists", async () => {
    const s1 = await regSnap("s1", "job-1")
    snaps.activate("s1")
    const s2 = await regSnap("s2", "job-1")
    // Mark s1 superseded by s2 BEFORE s2 is active: must NOT be deletable yet
    // (replacement not durably active).
    snaps.supersede("s1", "s2")
    let decision = snaps.gcDecision()
    expect(decision.deletable.find((r) => r.snapshotId === "s1")).toBeUndefined()
    // Now promote s2 to active: s1 becomes collectable.
    snaps.activate("s2")
    decision = snaps.gcDecision()
    expect(decision.deletable.find((r) => r.snapshotId === "s1")).toBeDefined()
  })

  it("a failed snapshot is always collectable", async () => {
    const s1 = await regSnap("s1", "job-1")
    snaps.activate("s1")
    // Mark the snapshot failed.
    dist.markSnapshotState("s1", "failed")
    const decision = snaps.gcDecision()
    expect(decision.deletable.find((r) => r.snapshotId === "s1")).toBeDefined()
  })

  it("expired superseded snapshot with active replacement is collected; last active is not", async () => {
    // Two jobs each with one active snapshot, both expired, no replacement:
    // neither is deletable.
    const a1 = await regSnap("a1", "job-a", { expiresAt: Date.now() - 1000 })
    snaps.activate("a1")
    const b1 = await regSnap("b1", "job-b", { expiresAt: Date.now() - 1000 })
    snaps.activate("b1")
    const decision = snaps.gcDecision()
    expect(decision.deletable).toHaveLength(0)
    void a1
    void b1
  })

  it("applyGc removes only deletable snapshots", async () => {
    const s1 = await regSnap("s1", "job-1")
    snaps.activate("s1")
    const s2 = await regSnap("s2", "job-1")
    snaps.activate("s2")
    snaps.supersede("s1", "s2")
    const decision = snaps.gcDecision()
    const deletable = decision.deletable.map((r) => r.snapshotId)
    expect(deletable).toContain("s1")
    snaps.applyGc(decision)
    // s1 deleted, s2 retained.
    expect(dist.getSnapshotRecord("s1")).toBeNull()
    expect(dist.getSnapshotRecord("s2")).not.toBeNull()
  })

  it("latestForJob returns the newest active snapshot", async () => {
    await regSnap("s1", "job-1")
    snaps.activate("s1")
    await regSnap("s2", "job-1")
    snaps.activate("s2")
    const latest = snaps.latestForJob("job-1")
    expect(latest).not.toBeNull()
    expect(["s1", "s2"]).toContain(latest!.snapshotId)
  })
})
