/**
 * WorkerHost (Phase 1D) — the worker-owned execution loop.
 *
 * A WorkerHost pulls durable jobs from a {@link JobDispatcher}, acknowledges
 * the claim, runs them via {@link AgentRunner}, and renews its fenced lease on
 * a heartbeat cadence for the entire duration of execution. It does NOT depend
 * on the HTTP control plane staying alive — the dispatcher + store are the only
 * durable dependencies.
 *
 * Fencing rules preserved:
 * - The dispatcher's claim grants a fenced generation/token; every mutation
 *   the runner makes is CAS-checked against that generation.
 * - Lease renewal (heartbeat) is itself fenced: a stale worker waking up after
 *   a partition cannot reclaim authority — its token is rejected and the job
 *     a) is still owned by the recovery worker (renewed => false, reason
 *        "fenced"), or
 *     b) became recovery-eligible and a fresh worker claimed a new generation.
 * - On fenced renewal the WorkerHost stops touching the job immediately. The
 *   supervisor reconciler decides recovery; the worker never blindly reruns.
 */

import type { AgentRunner, JobState } from "@vaulltcore/runner"
import type { JobDispatcher, LeaseRenewalResult, WorkerHeartbeat, WorkerIdentity } from "@vaulltcore/runner"
import type { WorkerHeartbeatSink } from "./heartbeat-sink"

export interface WorkerHostOptions {
  readonly identity: WorkerIdentity
  readonly dispatcher: JobDispatcher
  readonly runner: AgentRunner
  /** Lease duration granted on claim; renewed by the heartbeat loop. */
  readonly leaseMs: number
  /** Heartbeat cadence (must be < leaseMs). Default leaseMs / 3. */
  readonly heartbeatIntervalMs?: number
  /** Optional sink for worker heartbeats (supervisor/registry). */
  readonly heartbeatSink?: WorkerHeartbeatSink
  /** Max consecutive empty-claim polls before idling. Default Infinity. */
  readonly maxEmptyPolls?: number
  /** Hook invoked when a claim's fenced renewal fails (tests/observability). */
  readonly onFenced?: (jobId: string, result: LeaseRenewalResult) => void
}

/** Result of processing a single claimed job. */
export interface WorkerJobResult {
  readonly jobId: string
  readonly state: JobState
  readonly fenced: boolean
}

/**
 * A worker host. `runOnce()` claims and processes the next available job (or
 * returns null when the queue is empty). `runLoop()` polls until idle or
 * stopped. The host is agnostic to the dispatcher/store technology.
 */
export class WorkerHost {
  private readonly identity: WorkerIdentity
  private readonly dispatcher: JobDispatcher
  private readonly runner: AgentRunner
  private readonly leaseMs: number
  private readonly heartbeatIntervalMs: number
  private readonly heartbeatSink?: WorkerHeartbeatSink
  private readonly maxEmptyPolls: number
  private readonly onFenced?: (jobId: string, result: LeaseRenewalResult) => void
  private stopped = false
  private activeJobs = new Set<string>()

  constructor(options: WorkerHostOptions) {
    if (options.leaseMs <= 0) throw new Error("leaseMs must be positive")
    this.identity = options.identity
    this.dispatcher = options.dispatcher
    this.runner = options.runner
    this.leaseMs = options.leaseMs
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? Math.floor(options.leaseMs / 3)
    this.heartbeatSink = options.heartbeatSink
    this.maxEmptyPolls = options.maxEmptyPolls ?? Number.POSITIVE_INFINITY
    this.onFenced = options.onFenced
    if (this.heartbeatIntervalMs >= options.leaseMs) {
      throw new Error("heartbeatIntervalMs must be less than leaseMs")
    }
  }

  /** Stop the run loop after the current job. */
  stop(): void {
    this.stopped = true
  }

  get id(): string {
    return this.identity.workerId
  }

  /**
   * Claim and process the next available job. Returns null when the queue is
   * empty. If the claim's fenced renewal fails mid-execution, the job is
   * abandoned for the supervisor to reconcile (never blindly rerun).
   */
  async runOnce(): Promise<WorkerJobResult | null> {
    const claim = await this.dispatcher.claim(this.identity, this.leaseMs)
    if (!claim) return null
    this.activeJobs.add(claim.jobId)
    await this.dispatcher.acknowledge(claim).catch(() => {
      // acknowledge failure (fenced) means another worker already took over;
      // abandon without running.
      this.activeJobs.delete(claim.jobId)
      return undefined
    })
    // Run with a fenced heartbeat renewal loop. The loop ends when the job
    // reaches a terminal state OR renewal is fenced. The heartbeat renews BOTH
    // the execution lease (runner.renewLease — the authoritative fencing token)
    // and the dispatch claim (advisory assignment). A stale worker whose token
    // was superseded by a newer generation gets renewed:false and stops.
    let fenced = false
    let state: JobState | null = null
    let heartbeating = true
    const heartbeatPromise = (async () => {
      while (heartbeating) {
        await sleep(this.heartbeatIntervalMs)
        if (!heartbeating) break
        // Renew the execution lease first; it is the authority.
        const leaseResult = await this.runner.renewLease(claim.jobId, this.leaseMs)
        if (!leaseResult.renewed) {
          fenced = true
          this.onFenced?.(claim.jobId, leaseResult)
          heartbeating = false
          break
        }
        // Renew the dispatch claim (advisory); a fenced dispatch claim alone
        // does not fence the worker, but keep it in sync.
        await this.dispatcher.heartbeat(claim, this.leaseMs).catch(() => {})
        this.emitHeartbeat()
      }
    })()
    try {
      state = await this.runner.runJob(claim.jobId)
    } finally {
      heartbeating = false
      this.activeJobs.delete(claim.jobId)
      await heartbeatPromise.catch(() => {})
    }
    if (fenced) {
      // Do NOT release the lease: a newer owner has it. Releasing would be a
      // no-op anyway (token mismatch), but we explicitly avoid it to make the
      // "stale worker cannot clear a newer lease" invariant unambiguous.
      return { jobId: claim.jobId, state: state ?? { status: "suspended", attempt: claim.generation }, fenced: true }
    }
    await this.dispatcher.release(claim).catch(() => {})
    return { jobId: claim.jobId, state: state ?? { status: "failed", attempt: claim.generation }, fenced: false }
  }

  /**
   * Poll the dispatcher until idle (maxEmptyPolls reached) or stopped. Returns
   * the number of jobs processed.
   */
  async runLoop(): Promise<number> {
    let processed = 0
    let empty = 0
    while (!this.stopped && empty < this.maxEmptyPolls) {
      const result = await this.runOnce()
      if (!result) {
        empty += 1
        continue
      }
      empty = 0
      processed += 1
    }
    return processed
  }

  private emitHeartbeat(): void {
    if (!this.heartbeatSink) return
    const hb: WorkerHeartbeat = {
      worker: this.identity,
      at: Date.now(),
      activeJobs: Array.from(this.activeJobs),
    }
    this.heartbeatSink.record(hb)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
