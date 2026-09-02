/**
 * Durable retry policy + backoff (Phase 2B).
 *
 * Bounded exponential backoff with full jitter and a hard maximum number of
 * attempts. Retry classification determines whether an attempt is retriable;
 * the policy computes the next retry time. A non-retriable class (auth/config,
 * permanent validation, provider rejection) terminates immediately — no DoS via
 * retries against a bad credential or a malformed request.
 *
 * The policy is pure (a function of (attempt, class, now)), so it is
 * deterministic under reconciliation and testable without timers.
 */

import { type DeliveryResponse, type RetryClass, isRetriable } from "./contracts"

export interface RetryPolicyOptions {
  /** Maximum delivery attempts (including the first). Default 5. */
  readonly maxAttempts?: number
  /** Base backoff in ms. Default 1000. */
  readonly baseMs?: number
  /** Maximum backoff cap in ms. Default 5 * 60 * 1000 (5 min). */
  readonly maxMs?: number
  /** Multiplier per attempt. Default 2. */
  readonly multiplier?: number
  /** Jitter source (tests). Default Math.random. */
  readonly jitter?: () => number
}

export interface RetryDecision {
  readonly retriable: boolean
  readonly nextRetryAt: number | null
  /** Terminal reason when not retriable. */
  readonly terminalFailureReason: string | null
}

export class RetryPolicy {
  private readonly maxAttempts: number
  private readonly baseMs: number
  private readonly maxMs: number
  private readonly multiplier: number
  private readonly jitter: () => number

  constructor(options: RetryPolicyOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? 5
    this.baseMs = options.baseMs ?? 1000
    this.maxMs = options.maxMs ?? 5 * 60 * 1000
    this.multiplier = options.multiplier ?? 2
    this.jitter = options.jitter ?? Math.random
    if (this.maxAttempts < 1) throw new Error("maxAttempts must be >= 1")
  }

  /** Decide whether to retry after `attempt` (1-based) failed with `cls`. */
  decide(attempt: number, cls: RetryClass, now = Date.now()): RetryDecision {
    if (!isRetriable(cls)) {
      return { retriable: false, nextRetryAt: null, terminalFailureReason: terminalReason(cls) }
    }
    if (attempt >= this.maxAttempts) {
      return { retriable: false, nextRetryAt: null, terminalFailureReason: `max_attempts_exceeded (${this.maxAttempts})` }
    }
    const exp = this.baseMs * Math.pow(this.multiplier, attempt - 1)
    const capped = Math.min(exp, this.maxMs)
    const jittered = Math.floor(capped * this.jitter())
    return { retriable: true, nextRetryAt: now + jittered, terminalFailureReason: null }
  }

  /** Compute the next backoff for an attempt without a decision (for tests). */
  backoffMs(attempt: number): number {
    const exp = this.baseMs * Math.pow(this.multiplier, attempt - 1)
    return Math.min(exp, this.maxMs)
  }

  get attemptCap(): number {
    return this.maxAttempts
  }
}

function terminalReason(cls: RetryClass): string {
  switch (cls) {
    case "auth_config":
      return "auth_config_error"
    case "permanent_validation":
      return "permanent_validation_error"
    case "provider_rejection":
      return "provider_rejection"
    default:
      return "terminal"
  }
}

/** A default heuristic classifier mapping common HTTP/error signals to a class.
 *  Providers may override with a richer classifier. Accepts the full response
 *  type or any structural subset with `status` (tests). */
export function defaultClassifier(error: unknown, response: DeliveryResponse | Pick<DeliveryResponse, "status"> | null | undefined): RetryClass {
  if (response) {
    const s = response.status
    if (s === 429) return "rate_limited"
    if (s >= 400 && s < 500 && s !== 408 && s !== 429) {
      if (s === 401 || s === 403) return "auth_config"
      return "permanent_validation"
    }
    if (s >= 500) return "transient"
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase()
    if (/timeout|etimedout|econnreset|econnrefused|enotfound|eai_again|socket hang up|fetch failed|aborted|connection reset/.test(msg)) return "transient"
    if (/rate limit|429|too many requests/.test(msg)) return "rate_limited"
    if (/unauthorized|forbidden|invalid.*key|credential/.test(msg)) return "auth_config"
  }
  return "unknown_uncertain"
}
