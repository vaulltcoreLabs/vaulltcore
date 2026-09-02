/**
 * Metering model (Phase 1E).
 *
 * Raw usage facts are durable, append-only, and idempotent. A mutable
 * `job.cost` field is NOT accounting truth — the metering ledger is. A
 * {@link UsageEvent} has a stable idempotency/deduplication identity
 * (`(job_id, source, dedup_key)`), so a duplicate or worker-retry delivery of
 * the same event is recorded exactly once (UNIQUE constraint + ON CONFLICT DO
 * NOTHING). Execution remains at-least-once; metering is exactly-once at the
 * durable event-identity boundary.
 */

import type { JobIdentity } from "@vaulltcore/runner"

export const USAGE_KINDS = [
  "model_tokens",
  "model_input_tokens",
  "model_output_tokens",
  "model_reasoning_tokens",
  "model_request",
  "provider_api_request",
  "tool_call",
  "tool_invocation",
  "shell_execution",
  "execution_duration",
  "runtime_duration",
  "environment_allocation",
  "snapshot_storage",
] as const
export type UsageKind = (typeof USAGE_KINDS)[number]

/**
 * Canonical unit for each known usage kind. Quantities are ALWAYS non-negative
 * integers; floating-point is never used for authoritative quantities. The unit
 * is a validation hint: a record whose `unit` contradicts the canonical unit
 * for its kind is rejected (prevents a tokens quantity being recorded as ms).
 */
export const UNIT_FOR_KIND: Readonly<Record<UsageKind, string>> = {
  model_tokens: "tokens",
  model_input_tokens: "tokens",
  model_output_tokens: "tokens",
  model_reasoning_tokens: "tokens",
  model_request: "request",
  provider_api_request: "request",
  tool_call: "call",
  tool_invocation: "call",
  shell_execution: "call",
  execution_duration: "ms",
  runtime_duration: "ms",
  environment_allocation: "allocation",
  snapshot_storage: "bytes",
}

/** Test whether a string is a known (typed) usage kind. Unknown kinds are NOT
 *  silently cast — callers must opt into the custom-kind escape hatch. */
export function isKnownUsageKind(kind: string): kind is UsageKind {
  return (USAGE_KINDS as readonly string[]).includes(kind)
}

/** An immutable usage fact. */
export interface UsageEvent {
  readonly eventId: string
  readonly tenantId: string
  readonly orgId: string
  readonly projectId: string
  readonly jobId: string
  /** What was consumed. */
  readonly kind: UsageKind
  /** Quantity (tokens, count, milliseconds, bytes...). */
  readonly quantity: number
  /** Stable deduplication identity within (jobId, kind). */
  readonly dedupKey: string
  /** Optional unit hint (tokens, ms, bytes). */
  readonly unit: string | null
  readonly recordedAt: number
  /**
   * Provider/model attribution (Phase 2F). Explicit enough to answer which
   * configured model produced consumption. NEVER carries credentials — only
   * public provider/model identifiers resolved from job spec, not secrets.
   * Null when attribution is unavailable (represented honestly, never guessed).
   */
  readonly provider: string | null
  readonly model: string | null
}

/** Aggregated usage for a job (or scope). */
export interface UsageAggregate {
  readonly jobId: string | null
  readonly inputTokens: number
  readonly outputTokens: number
  readonly reasoningTokens: number
  readonly totalTokens: number
  readonly steps: number
  readonly toolCalls: number
  readonly durationMs: number
}

export class MeteringError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = "MeteringError"
  }
}

export interface UsageEventInput {
  readonly identity: JobIdentity & { jobId: string }
  readonly kind: UsageKind
  readonly quantity: number
  readonly dedupKey: string
  readonly unit?: string
  /** Provider/model attribution (Phase 2F). Public identifiers only, no secrets. */
  readonly provider?: string | null
  readonly model?: string | null
}

/** Result of recording a usage event (distinguishes first insert vs duplicate). */
export interface RecordResult {
  readonly event: UsageEvent
  readonly duplicated: boolean
}

/**
 * Deterministic accounting identity construction (Phase 2F). The accounting
 * identity is the exactly-once boundary: the database UNIQUE constraint on
 * (tenant_id, job_id, kind, dedup_key) collapses duplicate/concurrent/retried
 * accounting attempts to one durable charge. These builders produce stable,
 * explainable identities derived from committed execution lifecycle semantics
 * (job id + durable event seq + attempt), never instance state — so a fresh
 * instance re-deriving usage over the same committed history produces the SAME
 * identities and the ledger records each fact exactly once.
 */
export const AccountingIdentity = {
  /** Per-turn token bucket (input/output/reasoning) at a committed event seq.
   *  Format matches the legacy {@link eventsToUsage} dedup keys so attribution
   *  is interoperable with the unattributed pipeline (same identity boundary →
   *  no double-accounting when attribution is added). */
  tokens(_jobId: string, seq: number, bucket: string): string {
    return `tokens:${seq}:${bucket}`
  },
  /** One model provider turn (step) at a committed event seq. */
  modelStep(_jobId: string, seq: number): string {
    return `step:${seq}`
  },
  /** One tool invocation at a committed event seq. */
  tool(_jobId: string, seq: number): string {
    return `tool:${seq}`
  },
  /** Whole-job execution duration (idempotent per job). */
  duration(jobId: string): string {
    return `duration:${jobId}`
  },
  /** Snapshot storage (idempotent per snapshot id). */
  snapshot(_jobId: string, snapshotId: string): string {
    return `snapshot:${snapshotId}`
  },
  /** Provider API request at a committed event seq. */
  providerRequest(jobId: string, seq: number): string {
    return `provider_req:${jobId}:${seq}`
  },
} as const

/**
 * Validate a usage event input BEFORE persistence (Phase 2F). Rejects:
 *   - negative or non-integer quantity
 *   - unknown usage kind (unless `allowCustomKind` is set for the escape hatch)
 *   - a `unit` that contradicts the canonical unit for the kind
 * Returns the validated input (with a defaulted unit) or throws MeteringError.
 */
export function validateUsageInput(input: UsageEventInput, options: { allowCustomKind?: boolean } = {}): UsageEventInput {
  if (!input || typeof input.quantity !== "number" || !Number.isInteger(input.quantity) || input.quantity < 0) {
    throw new MeteringError("INVALID_QUANTITY", "quantity must be a non-negative integer")
  }
  if (typeof input.kind !== "string" || input.kind.length === 0) {
    throw new MeteringError("INVALID_USAGE_KIND", "usage kind is required")
  }
  if (!isKnownUsageKind(input.kind)) {
    if (!options.allowCustomKind) {
      throw new MeteringError("UNKNOWN_USAGE_KIND", `unknown usage kind "${input.kind}"`)
    }
    // Custom-kind escape hatch: still validate unit presence (no silent cast).
    if (!input.unit || input.unit.length === 0) {
      throw new MeteringError("INVALID_UNIT", `custom usage kind "${input.kind}" requires an explicit unit`)
    }
  } else {
    const canonical = UNIT_FOR_KIND[input.kind]
    if (input.unit && input.unit !== canonical) {
      throw new MeteringError("INVALID_UNIT", `unit "${input.unit}" does not match canonical unit "${canonical}" for kind "${input.kind}"`)
    }
  }
  return { ...input, unit: input.unit ?? (isKnownUsageKind(input.kind) ? UNIT_FOR_KIND[input.kind] : input.unit) }
}
