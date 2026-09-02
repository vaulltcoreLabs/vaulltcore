/**
 * Metering adapter: project durable runner events into idempotent usage events.
 *
 * The runner's {@link JobMetrics} and `usage`/`tool_response`/`message`
 * {@link JobEvent}s feed the metering layer through this explicit seam, so the
 * runner stays replaceable and neutral. Dedup keys are derived from the
 * durable event seq (monotonic and unique per job), so a worker crash/retry
 * that re-runs this adapter over the same committed events produces the SAME
 * dedup keys and the metering store records each fact exactly once.
 *
 * Preserves the at-least-once-execution / exactly-once-metering guarantee: the
 * runner may replay events, but the (jobId, kind, dedupKey) UNIQUE constraint
 * collapses duplicates at the durable identity boundary.
 */

import type { JobEvent, JobIdentity, JobMetrics } from "@vaulltcore/runner"
import type { UsageEventInput } from "./contracts"
import { AccountingIdentity } from "./contracts"

/** Identity augmented with the job id (the runner's JobIdentity has no jobId). */
export interface MeteringIdentity extends JobIdentity {
  readonly jobId: string
}

/**
 * Provider/model attribution context (Phase 2F). Public identifiers only —
 * resolved from the job spec (engine/model), NEVER from credentials. When
 * `null`, usage is recorded WITHOUT attribution (represented honestly as
 * unavailable, never guessed/fabricated). A non-null value attaches the
 * provider/model to every produced usage event so the ledger can answer which
 * configured model produced consumption without storing secrets.
 */
export interface UsageAttribution {
  readonly provider: string
  readonly model: string
}

/**
 * Convert a batch of durable runner events into usage events. Only committed
 * events up to the checkpoint watermark should be passed (the runner exposes
 * `listEvents`; the control plane filters by watermark when needed). Each
 * produced {@link UsageEventInput} carries a seq-derived dedup key.
 */
export function eventsToUsage(identity: MeteringIdentity, events: readonly JobEvent[]): UsageEventInput[] {
  const out: UsageEventInput[] = []
  for (const event of events) {
    switch (event.type) {
      case "usage": {
        const data = event.data as {
          stepIndex?: number
          inputTokens?: number
          outputTokens?: number
          reasoningTokens?: number
        }
        if (typeof data.inputTokens === "number" && data.inputTokens > 0) {
          out.push(tokenEvent(identity, event.seq, "input", data.inputTokens))
        }
        if (typeof data.outputTokens === "number" && data.outputTokens > 0) {
          out.push(tokenEvent(identity, event.seq, "output", data.outputTokens))
        }
        if (typeof data.reasoningTokens === "number" && data.reasoningTokens > 0) {
          out.push(tokenEvent(identity, event.seq, "reasoning", data.reasoningTokens))
        }
        // One model request per usage event = one step.
        out.push({
          identity,
          kind: "model_request",
          quantity: 1,
          dedupKey: AccountingIdentity.modelStep(identity.jobId, event.seq),
          unit: "request",
        })
        break
      }
      case "tool_response": {
        out.push({
          identity,
          kind: "tool_call",
          quantity: 1,
          dedupKey: AccountingIdentity.tool(identity.jobId, event.seq),
          unit: "call",
        })
        break
      }
      default:
        break
    }
  }
  return out
}

/**
 * Phase 2F: like {@link eventsToUsage} but attaches provider/model attribution
 * to every produced usage event. The dedup keys are IDENTICAL to
 * {@link eventsToUsage} (same identity boundary), so a job metered by either
 * adapter collapses to the same single durable charge — no double-accounting
 * when attribution is added later or when a legacy reconciliation pass runs.
 * Attribution is public identifiers only (from the job spec), never secrets.
 */
export function eventsToUsageAttributed(
  identity: MeteringIdentity,
  events: readonly JobEvent[],
  attribution: UsageAttribution | null,
): UsageEventInput[] {
  const base = eventsToUsage(identity, events)
  if (!attribution) return base
  return base.map((e) => ({ ...e, provider: attribution.provider, model: attribution.model }))
}

function tokenEvent(identity: MeteringIdentity, seq: number, bucket: string, quantity: number): UsageEventInput {
  return {
    identity,
    kind: "model_tokens",
    quantity,
    dedupKey: AccountingIdentity.tokens(identity.jobId, seq, bucket),
    unit: "tokens",
  }
}

/**
 * Emit a single execution-duration usage event for a job. Callers derive the
 * duration from the job's start/completion timestamps; the dedup key is the
 * job id so re-deriving duration on recovery records it exactly once.
 */
export function durationUsage(identity: MeteringIdentity, durationMs: number): UsageEventInput {
  return {
    identity,
    kind: "execution_duration",
    quantity: durationMs,
    dedupKey: AccountingIdentity.duration(identity.jobId),
    unit: "ms",
  }
}

/** Snapshot/storage usage (idempotent per snapshot id). */
export function snapshotUsage(identity: MeteringIdentity, snapshotId: string, bytes: number): UsageEventInput {
  return {
    identity,
    kind: "snapshot_storage",
    quantity: bytes,
    dedupKey: AccountingIdentity.snapshot(identity.jobId, snapshotId),
    unit: "bytes",
  }
}

/** Convert the runner's JobMetrics into a one-shot usage batch (idempotent by
 *  job id; useful when only the final metrics are available). */
export function metricsToUsage(identity: MeteringIdentity, metrics: JobMetrics): UsageEventInput[] {
  return [
    { identity, kind: "model_tokens", quantity: metrics.inputTokens, dedupKey: "metrics:input", unit: "tokens" },
    { identity, kind: "model_tokens", quantity: metrics.outputTokens, dedupKey: "metrics:output", unit: "tokens" },
    { identity, kind: "model_tokens", quantity: metrics.reasoningTokens, dedupKey: "metrics:reasoning", unit: "tokens" },
    { identity, kind: "model_request", quantity: metrics.steps, dedupKey: "metrics:steps", unit: "request" },
    { identity, kind: "tool_call", quantity: metrics.toolCalls, dedupKey: "metrics:toolCalls", unit: "call" },
  ]
}
