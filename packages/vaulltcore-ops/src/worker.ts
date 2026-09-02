/**
 * OperationalWorker (Phase 2B).
 *
 * A worker that claims durable operational work items from {@link SqlOpsStore},
 * dispatches them to the matching {@link OpsReaper}, and renews its fenced
 * lease on a heartbeat cadence for the duration of processing. A crashed worker
 * is safely replaceable: its lease lapses and another worker reclaims.
 *
 * Fencing (reuses the Phase 1D invariant): the claim grants a fenced
 * generation. Every complete/heartbeat is CAS-checked against that generation.
 * A stale worker waking up after a partition cannot complete — its generation
 * was superseded and the write affects 0 rows; the worker detects this and
 * abandons the item (never blindly reruns). The reaper itself is idempotent, so
 * even if a superseded worker had partially processed the item, the new worker's
 * re-execution is safe.
 *
 * This worker never invokes agent execution. Reapers perform only safe
 * operational cleanup derived from authoritative state.
 */

import {
  type OpsReaper,
  type OpsWorkerOptions,
  type OpsWorkKind,
} from "./contracts"
import type { SqlOpsStore } from "./store"

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export interface OperationalWorkerDeps {
  readonly store: SqlOpsStore
  readonly reapers: ReadonlyMap<OpsWorkKind, OpsReaper>
  readonly maxAttempts: number
}

/** Result of processing a single work item. */
export interface OpsWorkJobResult {
  readonly itemId: string
  readonly state: string
  readonly fenced: boolean
}

export class OperationalWorker {
  private readonly store: SqlOpsStore
  private readonly reapers: ReadonlyMap<OpsWorkKind, OpsReaper>
  private readonly maxAttempts: number
  private readonly workerId: string
  private readonly leaseMs: number
  private readonly heartbeatIntervalMs: number
  private readonly maxEmptyPolls: number
  private readonly now: () => number
  private readonly doSleep: (ms: number) => Promise<void>
  private stopped = false
  private active = new Set<string>()

  constructor(options: OpsWorkerOptions, deps: OperationalWorkerDeps) {
    this.workerId = options.workerId
    this.leaseMs = options.leaseMs
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? Math.floor(options.leaseMs / 3)
    this.maxEmptyPolls = options.maxEmptyPolls ?? Number.POSITIVE_INFINITY
    this.now = options.now ?? Date.now
    this.doSleep = options.sleep ?? sleep
    this.store = deps.store
    this.reapers = deps.reapers
    this.maxAttempts = deps.maxAttempts
    if (this.heartbeatIntervalMs >= this.leaseMs) throw new Error("heartbeatIntervalMs must be < leaseMs")
  }

  stop(): void {
    this.stopped = true
  }

  get id(): string {
    return this.workerId
  }

  /** Claim and process the next available work item. Returns null when idle. */
  async runOnce(): Promise<OpsWorkJobResult | null> {
    // Reap any expired/abandoned claims first (so a crashed worker's stuck
    // item becomes re-claimable).
    this.store.reapExpiredClaims(this.now())
    const claim = this.store.claim(this.workerId, this.leaseMs, this.now())
    if (!claim) return null
    this.active.add(claim.itemId)
    const item = this.store.getById(claim.itemId)
    if (!item) {
      // Item vanished (shouldn't happen); abandon the claim.
      this.active.delete(claim.itemId)
      return { itemId: claim.itemId, state: "missing", fenced: false }
    }
    const reaper = this.reapers.get(item.kind)
    if (!reaper) {
      // No reaper wired for this kind — terminal fail (config error, not retriable).
      this.store.complete(claim, { kind: "failed_terminal", reason: `no_reaper_for_${item.kind}` }, this.maxAttempts, this.now())
      this.active.delete(claim.itemId)
      return { itemId: claim.itemId, state: "failed_terminal", fenced: false }
    }

    // Fenced heartbeat loop.
    let fenced = false
    let heartbeating = true
    const heartbeatPromise = (async () => {
      while (heartbeating) {
        await this.doSleep(this.heartbeatIntervalMs)
        if (!heartbeating) break
        if (!this.store.heartbeat(claim, this.leaseMs, this.now())) {
          fenced = true
          heartbeating = false
          break
        }
      }
    })()

    let result
    try {
      result = await reaper.process(item, claim)
    } catch (error) {
      result = { kind: "failed_retriable" as const, reason: error instanceof Error ? error.message : "unknown", retryClass: "unknown_uncertain", nextRetryAt: this.now() + 1000 }
    } finally {
      heartbeating = false
      await heartbeatPromise.catch(() => {})
    }

    if (fenced) {
      // Our generation was superseded; do NOT complete (another worker owns it).
      this.active.delete(claim.itemId)
      return { itemId: claim.itemId, state: "fenced", fenced: true }
    }
    this.store.complete(claim, result, this.maxAttempts, this.now())
    this.active.delete(claim.itemId)
    const updated = this.store.getById(claim.itemId)
    return { itemId: claim.itemId, state: updated?.state ?? "unknown", fenced: false }
  }

  /** Poll until idle or stopped. */
  async runLoop(): Promise<void> {
    let empty = 0
    while (!this.stopped) {
      const res = await this.runOnce()
      if (!res) {
        empty++
        if (empty >= this.maxEmptyPolls) return
        await this.doSleep(50)
      } else {
        empty = 0
      }
    }
  }
}
