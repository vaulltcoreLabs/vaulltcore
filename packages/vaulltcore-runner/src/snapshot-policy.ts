/**
 * Cost-aware snapshot policy (Phase 1C).
 *
 * Phase 1B made compute snapshots possible; this contract decides when
 * capturing one is economically justified. The policy is advisory only: it can
 * never block, delay, or replace checkpoint durability. Commit boundaries and
 * checkpoint persistence follow the durable execution rules regardless of any
 * decision returned here — a snapshot is strictly an optimization for faster
 * compute resume.
 *
 * Reasons carried by decisions are sanitized operational strings: no prompts,
 * no env values, no secrets.
 */

import type { ExecutionCapabilities } from "./contracts"

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export type SnapshotDecisionKind =
  /** Capture a compute snapshot at this boundary. */
  | "snapshot_now"
  /** A usable snapshot already exists (or not enough new work accrued): keep
   * it and re-evaluate at the next boundary. */
  | "defer"
  /** Snapshotting is not justified for this boundary; resume logically. */
  | "skip"
  /** Snapshotting is impossible (capability missing) or pointless (job too
   * cheap to ever justify compute capture): the durable checkpoint is the
   * only continuation source. */
  | "logical_checkpoint_only"

/** Rough dollar estimate behind a decision; all fields non-negative USD. */
export interface SnapshotCostEstimate {
  /** Value protected by a snapshot: sunk model spend the checkpoint already
   * guarantees, plus the compute-restart cost a snapshot avoids. */
  readonly resumeValueUsd: number
  /** Estimated cost of capturing + storing one snapshot. */
  readonly snapshotCostUsd: number
  /** resumeValueUsd × suspension-risk weight − snapshotCostUsd. */
  readonly expectedNetUsd: number
}

export interface SnapshotDecision {
  readonly decision: SnapshotDecisionKind
  /** Sanitized, human-readable justification. Never contains prompts,
   * environment values, or secrets. */
  readonly reason: string
  readonly estimate: SnapshotCostEstimate | null
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

export type SuspensionRisk = "none" | "low" | "high"

/** Everything a policy may consider. All facts are derivable from durable
 * state or provider capability reports — never from ambient process state. */
export interface SnapshotFacts {
  /** Wall-clock time since job creation, ms. */
  readonly elapsedMs: number
  /** Committed steps since the latest attached snapshot (0 when a fresh
   * snapshot is already attached and no new steps committed). */
  readonly stepsSinceLastSnapshot: number
  /** Cumulative committed tokens (checkpoint usage). */
  readonly cumulativeTokens: number
  /** Precomputed model spend estimate, USD. When omitted, the policy derives
   * it from {@link SnapshotFacts.cumulativeTokens} and its own price table. */
  readonly estimatedModelCostUsd?: number
  /** Workspace size in bytes, when the provider reports it. */
  readonly workspaceBytes: number | null
  /** Cost/duration of the previous capture, when known. */
  readonly lastSnapshot: { readonly durationMs: number; readonly costUsd: number } | null
  /** Native provider capabilities (missing snapshot/restore ⇒ logical only). */
  readonly capabilities: ExecutionCapabilities
  /** Suspension risk: eviction signal raises urgency of capturing state. */
  readonly suspensionRisk: SuspensionRisk
}

export interface SnapshotPolicy {
  readonly id: string
  decide(facts: SnapshotFacts): SnapshotDecision
}

// ---------------------------------------------------------------------------
// Default deterministic threshold policy
// ---------------------------------------------------------------------------

export interface ThresholdSnapshotConfig {
  /** Below this resume value the job is too cheap to ever justify a compute
   * snapshot: logical checkpoint only. */
  readonly cheapJobFloorUsd: number
  /** Resume value at or above which capturing a snapshot pays for itself. */
  readonly snapshotThresholdUsd: number
  /** Threshold multiplier under a high (eviction) suspension risk. */
  readonly evictionRiskDiscount: number
  /** Minimum committed steps between two snapshot captures. */
  readonly minStepsBetweenSnapshots: number
  /** Nominal USD per token when the caller does not precompute model cost. */
  readonly pricePerTokenUsd: number
  /** Flat estimated USD cost of one capture + storage. */
  readonly snapshotCostUsd: number
}

export const DEFAULT_SNAPSHOT_THRESHOLDS: ThresholdSnapshotConfig = {
  cheapJobFloorUsd: 0.05,
  snapshotThresholdUsd: 1.0,
  evictionRiskDiscount: 0.25,
  minStepsBetweenSnapshots: 10,
  pricePerTokenUsd: 0.000002,
  snapshotCostUsd: 0.01,
}

/**
 * Deterministic default policy. Rule order (first match wins):
 *   1. missing native snapshot/restore capability → logical_checkpoint_only
 *   2. fresh snapshot attached and too few new steps → defer
 *   3. resume value below the cheap-job floor → logical_checkpoint_only
 *   4. resume value at/above the (risk-adjusted) threshold → snapshot_now
 *   5. otherwise → skip
 */
export class ThresholdSnapshotPolicy implements SnapshotPolicy {
  readonly id = "threshold/1"
  private readonly config: ThresholdSnapshotConfig

  constructor(config: Partial<ThresholdSnapshotConfig> = {}) {
    this.config = { ...DEFAULT_SNAPSHOT_THRESHOLDS, ...config }
  }

  decide(facts: SnapshotFacts): SnapshotDecision {
    const cfg = this.config
    const caps = facts.capabilities
    const estimate = this.estimate(facts)

    if (!caps.nativeSnapshot || !caps.nativeRestore) {
      return {
        decision: "logical_checkpoint_only",
        reason: `provider lacks native ${!caps.nativeSnapshot ? "snapshot" : "restore"} capability; durable checkpoint is the continuation source`,
        estimate,
      }
    }
    if (facts.lastSnapshot !== null && facts.stepsSinceLastSnapshot < cfg.minStepsBetweenSnapshots) {
      return {
        decision: "defer",
        reason: `only ${facts.stepsSinceLastSnapshot} committed step(s) since the latest snapshot (< ${cfg.minStepsBetweenSnapshots}); existing snapshot stays attached`,
        estimate,
      }
    }
    if (estimate.resumeValueUsd < cfg.cheapJobFloorUsd) {
      return {
        decision: "logical_checkpoint_only",
        reason: `resume value $${estimate.resumeValueUsd.toFixed(4)} below cheap-job floor $${cfg.cheapJobFloorUsd}; capture never pays for itself`,
        estimate,
      }
    }
    const threshold = facts.suspensionRisk === "high" ? cfg.snapshotThresholdUsd * cfg.evictionRiskDiscount : cfg.snapshotThresholdUsd
    if (estimate.resumeValueUsd >= threshold) {
      return {
        decision: "snapshot_now",
        reason: `resume value $${estimate.resumeValueUsd.toFixed(4)} meets threshold $${threshold.toFixed(4)}${facts.suspensionRisk === "high" ? " (eviction risk discount applied)" : ""}`,
        estimate,
      }
    }
    return {
      decision: "skip",
      reason: `resume value $${estimate.resumeValueUsd.toFixed(4)} below threshold $${threshold.toFixed(4)}; capture deferred indefinitely, logical resume suffices`,
      estimate,
    }
  }

  private estimate(facts: SnapshotFacts): SnapshotCostEstimate {
    const modelCostUsd = facts.estimatedModelCostUsd ?? facts.cumulativeTokens * this.config.pricePerTokenUsd
    const resumeValueUsd = modelCostUsd
    const riskWeight = facts.suspensionRisk === "high" ? 1 : facts.suspensionRisk === "low" ? 0.5 : 0.25
    return {
      resumeValueUsd,
      snapshotCostUsd: this.config.snapshotCostUsd,
      expectedNetUsd: resumeValueUsd * riskWeight - this.config.snapshotCostUsd,
    }
  }
}
