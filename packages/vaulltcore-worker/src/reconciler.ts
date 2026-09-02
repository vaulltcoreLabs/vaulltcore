/**
 * JobReconciler / supervisor (Phase 1D).
 *
 * Identifies jobs whose worker has disappeared (non-terminal status with an
 * expired lease) and transitions them to recovery eligibility by suspending
 * them with reason `worker_loss`. It preserves every Phase 1A/1B rule: an
 * uncertain non-idempotent tool call remains uncertain; recovery never blindly
 * reruns committed work.
 *
 * The reconciler is intentionally decoupled from the recovery executor: it only
 * flips jobs to `suspended(worker_loss)` (a non-terminal, resumable state). A
 * fresh worker later acquires a new fenced generation and the runner's recovery
 * algorithm (validate → fence → checkpoint → events → workspace → snapshot →
 * native restore | logical resume) takes over.
 *
 * Transient worker loss is never silently mapped to `failed`.
 */

import type { AgentRunner, JobState, RecoveryCandidate } from "@vaulltcore/runner"

export interface ReconcilerCandidateSource {
  /** List jobs needing recovery (non-terminal + expired lease). */
  findRecoveryCandidates(now?: number): RecoveryCandidate[] | Promise<RecoveryCandidate[]>
}

export interface ReconcilerOptions {
  readonly source: ReconcilerCandidateSource
  readonly runner: AgentRunner
  /** Max candidates per reconcile pass. Default unlimited. */
  readonly maxPerPass?: number
  /** Hook invoked per suspended job (observability/tests). */
  readonly onSuspended?: (candidate: RecoveryCandidate, state: JobState) => void
}

export interface ReconcilerResult {
  readonly examined: number
  readonly suspended: Array<{ jobId: string; reason: string; state: JobState }>
  readonly skipped: Array<{ jobId: string; reason: string }>
}

export class JobReconciler {
  private readonly source: ReconcilerCandidateSource
  private readonly runner: AgentRunner
  private readonly maxPerPass: number
  private readonly onSuspended?: (candidate: RecoveryCandidate, state: JobState) => void

  constructor(options: ReconcilerOptions) {
    this.source = options.source
    this.runner = options.runner
    this.maxPerPass = options.maxPerPass ?? Number.POSITIVE_INFINITY
    this.onSuspended = options.onSuspended
  }

  /**
   * Run one reconciliation pass: find worker-loss candidates and suspend them.
   * Idempotent — a job already suspended is a no-op; a job whose lease was
   * renewed between scan and suspend is left alone.
   */
  async reconcile(now: number = Date.now()): Promise<ReconcilerResult> {
    const candidates = await this.source.findRecoveryCandidates(now)
    const suspended: Array<{ jobId: string; reason: string; state: JobState }> = []
    const skipped: Array<{ jobId: string; reason: string }> = []
    let processed = 0
    for (const candidate of candidates) {
      if (processed >= this.maxPerPass) break
      processed += 1
      try {
        // Suspend with reason worker_loss: non-terminal, resumable. The runner
        // releases the lease so a fresh worker can acquire a new generation.
        const state = await this.runner.suspendJob(candidate.jobId, "worker_loss")
        if (state.status === "suspended") {
          suspended.push({ jobId: candidate.jobId, reason: candidate.reason, state })
          this.onSuspended?.(candidate, state)
        } else {
          // Job reached a terminal state concurrently (race with the worker);
          // leave it.
          skipped.push({ jobId: candidate.jobId, reason: `concurrent terminal state ${state.status}` })
        }
      } catch (error) {
        // A transient error suspending one job must not abort the pass; record
        // and continue. The next pass will retry.
        skipped.push({ jobId: candidate.jobId, reason: `suspend error: ${(error as Error).message}` })
      }
    }
    return { examined: candidates.length, suspended, skipped }
  }
}
