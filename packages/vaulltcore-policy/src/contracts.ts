/**
 * Versioned B2B admission policy (Phase 1E).
 *
 * A policy is evaluated BEFORE job admission and produces an immutable
 * {@link AdmissionDecision} whose enforceable subset is projected into the
 * runner's {@link ExecutionPolicy} (pinned into the immutable JobRecord by the
 * runner — see IMMUTABLE_JOB_FIELDS). Existing jobs never silently inherit
 * later policy changes because:
 *   1. the runner freezes `policy` in the JobRecord at creation;
 *   2. the checkpoint pins `policyVersion` and rejects resume on mismatch.
 *
 * The richer commercial fields (maxConcurrentJobs, egressAllowlist,
 * allowSnapshots, maxTokens) are recorded durably as the job's admission
 * reference and consulted by the quota/metering layers; they are deliberately
 * NOT folded into the execution policy, keeping the runner neutral.
 */

import type { ExecutionPolicy, JobIdentity } from "@vaulltcore/runner"

/** Minimum policy fields evaluated before job admission. */
export interface AdmissionPolicy {
  readonly policyId: string
  /** Bumped whenever resume/enforcement-relevant semantics change. */
  readonly policyVersion: string
  readonly maxSteps: number
  readonly maxTokens: number
  readonly maxDurationMs: number
  readonly maxConcurrentJobs: number
  readonly jobsPerPeriod: number
  readonly periodMs: number
  readonly allowedTools: readonly string[]
  readonly egressAllowlist: readonly string[]
  readonly allowSnapshots: boolean
  readonly createdAt: number
}

/** Deterministic outcome of evaluating a policy for a candidate admission. */
export interface AdmissionDecision {
  readonly allowed: boolean
  readonly reasonCode: string
  readonly policyId: string
  readonly policyVersion: string
  readonly maxSteps: number
  readonly maxTokens: number
  readonly maxDurationMs: number
  readonly maxConcurrentJobs: number
  readonly allowedTools: readonly string[]
  readonly egressAllowlist: readonly string[]
  readonly allowSnapshots: boolean
}

/** Candidate admission context presented to the evaluator. */
export interface AdmissionRequest extends JobIdentity {
  /** Tools the caller asked to enable for the job. */
  readonly requestedTools: readonly string[]
  /** Caller-requested step ceiling (advisory; policy maxSteps is the hard cap). */
  readonly requestedMaxSteps?: number
  /** Caller-requested snapshot permission. */
  readonly requestedAllowSnapshots?: boolean
}

export class PolicyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = "PolicyError"
  }
}

/** Sensible default policy for tests/local; production supplies its own. */
export const DEFAULT_ADMISSION_POLICY: AdmissionPolicy = {
  policyId: "default",
  policyVersion: "1",
  maxSteps: 25,
  maxTokens: 250_000,
  maxDurationMs: 3_600_000,
  maxConcurrentJobs: 5,
  jobsPerPeriod: 100,
  periodMs: 3_600_000,
  allowedTools: [],
  egressAllowlist: [],
  allowSnapshots: true,
  createdAt: 0,
}

/**
 * Project the enforceable subset of a policy decision into the runner's
 * immutable {@link ExecutionPolicy}. The runner freezes this into the JobRecord;
 * the checkpoint later pins `policyVersion` and refuses resume on mismatch, so a
 * job can never silently run under a newer policy.
 */
export function projectExecutionPolicy(decision: AdmissionDecision, leaseMs: number): ExecutionPolicy {
  return {
    version: decision.policyVersion,
    maxSteps: decision.maxSteps,
    onUncertainToolCall: "mark_uncertain",
    allowedTools: [...decision.allowedTools],
    idempotentTools: [],
    leaseMs,
  }
}
