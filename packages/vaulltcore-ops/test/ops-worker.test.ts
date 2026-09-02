/**
 * Operational worker tests (Phase 2B): fenced claiming, worker replacement,
 * heartbeat fencing, idempotent enqueue, retry classification, expired-claim
 * reaping, and concurrent worker contention.
 */
import { describe, it, expect, beforeEach } from "vitest"
import { NodeSqliteDatabase } from "@vaulltcore/store-sql"
import { SqlOpsStore, OperationalWorker, type OperationalWorkerDeps, type OpsWorkKind, type OpsReaper, type OpsWorkResult } from "../src"

function newStore(): SqlOpsStore {
  return new SqlOpsStore(NodeSqliteDatabase.memory())
}

function enqueue(store: SqlOpsStore, id: string, kind: OpsWorkKind, tenant = "t1"): void {
  store.enqueue({ id, tenantId: tenant, orgId: "o", projectId: "p", kind, targetRef: id, idempotencyKey: `${kind}:${id}` })
}

/** A reaper that records calls and returns a configurable result. */
function recordingReaper(results: OpsWorkResult[] = [{ kind: "succeeded" }]): OpsReaper & { calls: number } {
  const r = { calls: 0, kind: "delivery_retry" as OpsWorkKind, async process(): Promise<OpsWorkResult> { r.calls++; return results[Math.min(r.calls - 1, results.length - 1)] ?? { kind: "succeeded" } } }
  return r
}

describe("SqlOpsStore enqueue + claim", () => {
  let store: SqlOpsStore
  beforeEach(() => { store = newStore() })

  it("enqueue is idempotent on (tenant, idempotencyKey) — no duplicate work", () => {
    enqueue(store, "w1", "delivery_retry")
    enqueue(store, "w1", "delivery_retry") // same idempotency key
    const items = store.list("t1", "delivery_retry", null)
    expect(items).toHaveLength(1)
  })

  it("claim returns null when empty; claims the oldest eligible item", () => {
    expect(store.claim("w", 1000, 0)).toBeNull()
    enqueue(store, "w1", "approval_expiry")
    const claim = store.claim("w", 1000, 0)
    expect(claim).not.toBeNull()
    expect(claim!.claimant).toBe("w")
    const item = store.getById("w1")!
    expect(item.state).toBe("claimed")
    expect(item.generation).toBe(1)
  })

  it("failed_retriable items are not claimable until nextRetryAt", () => {
    enqueue(store, "w1", "delivery_retry")
    const claim = store.claim("w", 1000, 0)!
    store.complete(claim, { kind: "failed_retriable", reason: "x", retryClass: "transient", nextRetryAt: 5000 }, 5, 0)
    // Not claimable before nextRetryAt.
    expect(store.claim("w", 1000, 1000)).toBeNull()
    // Claimable after.
    const claim2 = store.claim("w", 1000, 5000)
    expect(claim2).not.toBeNull()
    expect(claim2!.generation).toBe(3)
  })
})

describe("OperationalWorker fencing + replacement", () => {
  let store: SqlOpsStore
  beforeEach(() => { store = newStore() })

  it("succeeds and marks item succeeded; reaper called once", async () => {
    enqueue(store, "w1", "delivery_retry")
    const reaper = recordingReaper()
    const deps: OperationalWorkerDeps = { store, reapers: new Map([["delivery_retry", reaper]]), maxAttempts: 5 }
    const worker = new OperationalWorker({ workerId: "wk1", leaseMs: 1000, heartbeatIntervalMs: 100, sleep: async () => {} }, deps)
    const res = await worker.runOnce()
    expect(res!.state).toBe("succeeded")
    expect(reaper.calls).toBe(1)
    expect(store.getById("w1")!.state).toBe("succeeded")
  })

  it("crashed worker's expired claim is reaped and reclaimed by a replacement worker", async () => {
    enqueue(store, "w1", "delivery_retry")
    // Worker A claims but never completes (simulated crash).
    const claimA = store.claim("A", 100, 0)!
    expect(claimA).not.toBeNull()
    // Lease expires; reapExpiredClaims resets it.
    store.reapExpiredClaims(200)
    const item = store.getById("w1")!
    expect(item.state).toBe("failed_retriable")
    // Worker B claims and completes.
    const reaper = recordingReaper()
    const deps: OperationalWorkerDeps = { store, reapers: new Map([["delivery_retry", reaper]]), maxAttempts: 5 }
    const workerB = new OperationalWorker({ workerId: "B", leaseMs: 1000, heartbeatIntervalMs: 100, now: () => 300, sleep: async () => {} }, deps)
    const res = await workerB.runOnce()
    expect(res!.state).toBe("succeeded")
    expect(reaper.calls).toBe(1)
    expect(store.getById("w1")!.generation).toBeGreaterThanOrEqual(2)
  })

  it("fenced worker does not complete; superseding generation owns the item", async () => {
    enqueue(store, "w1", "delivery_retry")
    let reaperResolve: () => void
    const reaperBlocked = new Promise<void>((r) => { reaperResolve = r })
    const reaper: OpsReaper = {
      kind: "delivery_retry",
      async process() { await reaperBlocked; return { kind: "succeeded" } },
    }
    const deps: OperationalWorkerDeps = { store, reapers: new Map([["delivery_retry", reaper]]), maxAttempts: 5 }
    // Worker A claims with a short lease and fast heartbeat. The sleep yields to
    // the event loop so the test can interleave the fencing.
    const workerA = new OperationalWorker({ workerId: "A", leaseMs: 50, heartbeatIntervalMs: 5, now: () => 0, sleep: async (ms) => { await new Promise<void>((r) => setTimeout(r, ms)) } }, deps)
    const runP = workerA.runOnce()
    // Wait for A to be mid-processing, then let A's lease expire and have B
    // reap + reclaim (superseding the generation). A's next heartbeat must fail.
    await new Promise((r) => setTimeout(r, 20))
    store.reapExpiredClaims(100) // A's lease (expiresAt=50) has lapsed at now=100
    const claimB = store.claim("B", 5000, 100) // B claims a new generation
    expect(claimB).not.toBeNull()
    const item = store.getById("w1")!
    expect(item.claimant).toBe("B")
    expect(item.generation).toBeGreaterThanOrEqual(2)
    // Give A's heartbeat a tick to detect the superseded generation (fencing).
    await new Promise((r) => setTimeout(r, 20))
    // Release A's reaper; A must detect fencing and NOT complete.
    reaperResolve!()
    const res = await runP
    expect(res!.fenced).toBe(true)
    // A did not overwrite B's claim.
    expect(store.getById("w1")!.claimant).toBe("B")
  })

  it("retriable failure schedules retry; terminal exhaustion enters dead-letter after max attempts", async () => {
    enqueue(store, "w1", "delivery_retry")
    const reaper = recordingReaper([{ kind: "failed_retriable", reason: "boom", retryClass: "transient", nextRetryAt: 100 }])
    const deps: OperationalWorkerDeps = { store, reapers: new Map([["delivery_retry", reaper]]), maxAttempts: 2 }
    const worker = new OperationalWorker({ workerId: "w", leaseMs: 1000, heartbeatIntervalMs: 100, now: () => 0, sleep: async () => {} }, deps)
    let res = await worker.runOnce()
    expect(res!.state).toBe("failed_retriable")
    // Retry once (after nextRetryAt). Exceeding max attempts dead-letters.
    const worker2 = new OperationalWorker({ workerId: "w", leaseMs: 1000, heartbeatIntervalMs: 100, now: () => 100, sleep: async () => {} }, deps)
    res = await worker2.runOnce()
    // Phase 2E: exhausted retries enter an explicit dead-letter state (a
    // distinct terminal state operators can redrive from).
    expect(res!.state).toBe("dead_letter")
    expect(store.getById("w1")!.attempts).toBe(2)
    // The dead-lettered item is no longer claimable.
    expect(store.claim("w", 1000, 200)).toBeNull()
  })

  it("no reaper wired → terminal failure (config error, not retriable)", async () => {
    enqueue(store, "w1", "artifact_lifecycle")
    const deps: OperationalWorkerDeps = { store, reapers: new Map(), maxAttempts: 5 }
    const worker = new OperationalWorker({ workerId: "w", leaseMs: 1000, heartbeatIntervalMs: 100, sleep: async () => {} }, deps)
    const res = await worker.runOnce()
    expect(res!.state).toBe("failed_terminal")
  })
})

describe("concurrent workers (single-process contention)", () => {
  it("two workers do not both process the same item (CAS fencing)", () => {
    const store = newStore()
    enqueue(store, "w1", "delivery_retry")
    const a = store.claim("A", 1000, 0)
    const b = store.claim("B", 1000, 0)
    expect(a).not.toBeNull()
    expect(b).toBeNull()
    const item = store.getById("w1")!
    expect(item.claimant).toBe("A")
  })

  it("tenant isolation: list is tenant-scoped", () => {
    const store = newStore()
    enqueue(store, "w1", "delivery_retry", "t1")
    enqueue(store, "w2", "delivery_retry", "t2")
    expect(store.list("t1", null, null)).toHaveLength(1)
    expect(store.list("t2", null, null)).toHaveLength(1)
    expect(store.get("t1", "w2")).toBeNull()
  })
})
