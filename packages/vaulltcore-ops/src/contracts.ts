/**
 * Durable operational worker contracts (Phase 2B).
 *
 * A generic, fenced work-item queue for operational background work: approval
 * expiry, delivery retry, abandoned runs, expired reservations, stale
 * idempotency records, and artifact lifecycle cleanup. Every work item is
 * durable (survives process restart), has an explicit idempotency identity,
 * retry classification, and a recovery path.
 *
 * Fencing model (reuses the Phase 1D invariant): a worker claims a work item
 * by atomically writing its identity + a fenced generation + an expiry into
 * `ops_work_items`. Heartbeat renews the expiry under the same generation. A
 * stale worker whose process died cannot reclaim — its generation is superseded
 * by a new claim (generation N-1 can never write once generation N committed).
 * Reaping expired/abandoned items is itself idempotent + fenced.
 *
 * This is NOT a general workflow engine. Work items are short, idempotent
 * operational tasks derived from durable authoritative state, never agent
 * execution. Reconciliation reads authoritative state; the ops worker only
 * resumes eligible operational cleanup.
 */

/** Kinds of operational work. Each maps to an idempotent reaper. */
export const OPS_WORK_KINDS = [
  "approval_expiry",
  "delivery_retry",
  "abandoned_run",
  "expired_reservation",
  "stale_idempotency",
  "artifact_lifecycle",
] as const
export type OpsWorkKind = (typeof OPS_WORK_KINDS)[number]

export const OPS_WORK_STATES = ["pending", "claimed", "in_progress", "succeeded", "failed_terminal", "failed_retriable", "dead_letter"] as const
export type OpsWorkState = (typeof OPS_WORK_STATES)[number]

/** Terminal states (no further transition; a late worker cannot resurrect). */
export const TERMINAL_OPS_STATES: ReadonlySet<OpsWorkState> = new Set(["succeeded", "failed_terminal", "dead_letter"])

/** A durable operational work item. */
export interface OpsWorkItem {
  readonly id: string
  readonly tenantId: string
  readonly orgId: string
  readonly projectId: string
  readonly kind: OpsWorkKind
  /** The durable target identity this item acts on (e.g. runId, approvalId). */
  readonly targetRef: string
  /** Stable idempotency identity for the operation (kind + targetRef). */
  readonly idempotencyKey: string
  readonly state: OpsWorkState
  /** Fenced generation; superseding claim increments. */
  readonly generation: number
  readonly claimant: string | null
  readonly claimExpiresAt: number | null
  readonly attempts: number
  readonly nextRetryAt: number | null
  readonly lastError: string | null
  readonly retryClass: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

/** A claimed work item bound to a worker generation. */
export interface OpsClaim {
  readonly itemId: string
  readonly generation: number
  readonly claimant: string
  readonly expiresAt: number
}

/** Result of attempting an operational work item. */
export type OpsWorkResult =
  | { readonly kind: "succeeded" }
  | { readonly kind: "failed_terminal"; readonly reason: string }
  | { readonly kind: "failed_retriable"; readonly reason: string; readonly retryClass: string; readonly nextRetryAt: number }

/** A reaper: idempotently processes one work item. Must be safe to call >1x. */
export interface OpsReaper {
  readonly kind: OpsWorkKind
  process(item: OpsWorkItem, claim: OpsClaim): Promise<OpsWorkResult>
}

/** Fenced lease options for the operational worker. */
export interface OpsWorkerOptions {
  readonly workerId: string
  readonly leaseMs: number
  readonly heartbeatIntervalMs?: number
  /** Max consecutive empty polls before idling. Default Infinity. */
  readonly maxEmptyPolls?: number
  /** Now clock (tests). */
  readonly now?: () => number
  /** Sleep function (tests use fake timers). */
  readonly sleep?: (ms: number) => Promise<void>
}

// ---------------------------------------------------------------------------
// Phase 2E: shared failure classification for durable infrastructure work.
// ---------------------------------------------------------------------------

/**
 * A shared, durable failure-classification model (Phase 2E).
 *
 * A superset of the delivery retry classes (Phase 2B). The additions make the
 * operational distinction the reliability layer needs: policy/quota/auth
 * rejections are NOT retried as infrastructure failures; `cancelled` and
 * `timeout` are explicit terminal classes; `unknown_terminal` is a safe
 * fall-through that never retries. Classification is persisted into the work
 * item's `retryClass`, so recovery after restart derives the pending retry
 * schedule from durable state alone (no in-memory timers as source of truth).
 */
export const FAILURE_CLASSES = [
  "transient",
  "rate_limited",
  "provider_temporary",
  "permanent_validation",
  "auth_config",
  "policy_rejection",
  "quota_rejection",
  "cancelled",
  "timeout",
  "unknown_terminal",
  "unknown_uncertain",
] as const
export type FailureClass = (typeof FAILURE_CLASSES)[number]

/** Whether a failure class is retriable as durable infrastructure work.
 *  Policy/quota/auth/validation/cancelled/timeout/unknown_terminal are NOT
 *  retried — they are honest terminal rejections, never a DoS via retries. */
export function isRetriableFailure(c: FailureClass): boolean {
  return c === "transient" || c === "rate_limited" || c === "provider_temporary" || c === "unknown_uncertain"
}

/** A terminal reason for a non-retriable class (sanitized; no secrets). */
export function terminalFailureReason(c: FailureClass): string {
  switch (c) {
    case "auth_config":
      return "auth_config_error"
    case "permanent_validation":
      return "permanent_validation_error"
    case "policy_rejection":
      return "policy_rejection"
    case "quota_rejection":
      return "quota_rejection"
    case "cancelled":
      return "cancelled"
    case "timeout":
      return "timeout"
    case "unknown_terminal":
      return "unknown_terminal"
    default:
      return "terminal"
  }
}

/** Bounded retry policy options (pure; deterministic under reconciliation). */
export interface FailureRetryPolicyOptions {
  readonly maxAttempts?: number
  readonly baseMs?: number
  readonly maxMs?: number
  readonly multiplier?: number
  readonly jitter?: () => number
}

export interface FailureRetryDecision {
  readonly retriable: boolean
  readonly nextRetryAt: number | null
  readonly terminalFailureReason: string | null
}

/** A pure, bounded retry policy over {@link FailureClass}. Exponential backoff
 *  with full jitter, capped by maxMs + maxAttempts. Non-retriable classes
 *  terminate immediately. The policy is a pure function of (attempt, class,
 *  now), so it is deterministic under reconciliation and testable without
 *  timers — recovery re-derives pending retries from durable state. */
export class FailureRetryPolicy {
  private readonly maxAttempts: number
  private readonly baseMs: number
  private readonly maxMs: number
  private readonly multiplier: number
  private readonly jitter: () => number

  constructor(options: FailureRetryPolicyOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? 5
    this.baseMs = options.baseMs ?? 1000
    this.maxMs = options.maxMs ?? 5 * 60 * 1000
    this.multiplier = options.multiplier ?? 2
    this.jitter = options.jitter ?? Math.random
    if (this.maxAttempts < 1) throw new Error("maxAttempts must be >= 1")
  }

  decide(attempt: number, cls: FailureClass, now: number = Date.now()): FailureRetryDecision {
    if (!isRetriableFailure(cls)) {
      return { retriable: false, nextRetryAt: null, terminalFailureReason: terminalFailureReason(cls) }
    }
    if (attempt >= this.maxAttempts) {
      return { retriable: false, nextRetryAt: null, terminalFailureReason: `max_attempts_exceeded (${this.maxAttempts})` }
    }
    const exp = this.baseMs * Math.pow(this.multiplier, attempt - 1)
    const capped = Math.min(exp, this.maxMs)
    const jittered = Math.floor(capped * this.jitter())
    return { retriable: true, nextRetryAt: now + jittered, terminalFailureReason: null }
  }

  get attemptCap(): number {
    return this.maxAttempts
  }
}

/** A retry-after hint (e.g. from a 429 Retry-After header), clamped to a sane
 *  bound so a hostile provider cannot stall work indefinitely. */
export function clampRetryAfter(retryAfterMs: number | null, maxMs: number = 60 * 60 * 1000): number | null {
  if (retryAfterMs === null || !Number.isFinite(retryAfterMs) || retryAfterMs < 0) return null
  return Math.min(Math.floor(retryAfterMs), maxMs)
}
