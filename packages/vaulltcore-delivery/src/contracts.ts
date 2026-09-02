/**
 * Production delivery provider contracts (Phase 2B).
 *
 * Expands Phase 2A's minimal {@link DeliveryProvider} with the operational
 * surface a production system needs: a durable attempt record carrying attempt
 * identity, destination identity, request fingerprint, provider response/status,
 * started/completed timestamps, retryability classification, next retry time,
 * and terminal failure reason. Every delivery attempt has an explicit
 * idempotency identity and a recovery path.
 *
 * Retry classification distinguishes:
 *   transient | rate_limited | auth_config | permanent_validation
 *   | provider_rejection | unknown_uncertain
 *
 * Bounded exponential backoff with jitter caps total attempts. No retry may
 * silently duplicate a non-idempotent external action — the delivery identity
 * (runId + idempotencyKey) is the settlement boundary; the provider call is
 * idempotent on that key.
 *
 * Security: providers sit behind the neutral {@link ProductionDeliveryProvider}
 * interface. The SSRF guard blocks private/loopback/link-local/metadata hosts,
 * enforces an allow-list of schemes (https in production; http only for local
 * dev), and follows no untrusted redirects to internal addresses. Credentials
 * are never placed in logs, audit metadata, events, or error messages — the
 * redactor strips them. A destination identity is tenant-scoped: a destination
 * registered by one tenant is never reusable as another tenant's outbound target.
 */

import type { AutomationArtifact, DeliveryProvider } from "@vaulltcore/automation"

// ---------------------------------------------------------------------------
// Retry classification
// ---------------------------------------------------------------------------

export const RETRY_CLASSES = [
  "transient",
  "rate_limited",
  "auth_config",
  "permanent_validation",
  "provider_rejection",
  "unknown_uncertain",
] as const
export type RetryClass = (typeof RETRY_CLASSES)[number]

/** Whether a retry class is retriable (transient/rate-limited/unknown-uncertain). */
export function isRetriable(c: RetryClass): boolean {
  return c === "transient" || c === "rate_limited" || c === "unknown_uncertain"
}

/**
 * A classifier maps a thrown delivery outcome to a {@link RetryClass}. The
 * concrete provider supplies this; a default heuristic classifier is provided.
 * An `unknown_uncertain` result is retriable (we cannot prove the call failed
 * before side effects), matching the "never falsely settle" guarantee.
 */
export type DeliveryOutcomeClassifier = (error: unknown, response?: DeliveryResponse | null) => RetryClass

// ---------------------------------------------------------------------------
// Provider response / attempt record
// ---------------------------------------------------------------------------

/** The raw provider response captured for a delivery attempt. */
export interface DeliveryResponse {
  readonly status: number
  readonly statusText: string | null
  /** Sanitized headers (credentials stripped). */
  readonly headers: Readonly<Record<string, string>>
  /** Truncated body (sanitized) for diagnostics. */
  readonly body: string | null
}

/** A durable delivery attempt record with full operational provenance. */
export interface DeliveryAttemptRecord {
  readonly attemptId: string
  /** Stable delivery identity (runId + idempotencyKey). */
  readonly deliveryId: string
  readonly runId: string
  readonly idempotencyKey: string
  /** The attempt number within this delivery identity (1-based). */
  readonly attempt: number
  /** Tenant-scoped destination identity. */
  readonly destination: string
  readonly destinationIdentity: string
  /** SHA-256 over the canonical request (method+url+body+fingerprint of artifacts). */
  readonly requestFingerprint: string
  readonly startedAt: number
  readonly completedAt: number | null
  readonly response: DeliveryResponse | null
  readonly retryClass: RetryClass | null
  readonly retriable: boolean
  readonly nextRetryAt: number | null
  readonly terminalFailureReason: string | null
  readonly status: DeliveryAttemptRecordStatus
}

export const DELIVERY_ATTEMPT_STATUSES = ["pending", "in_progress", "delivered", "failed_terminal", "failed_retriable"] as const
export type DeliveryAttemptRecordStatus = (typeof DELIVERY_ATTEMPT_STATUSES)[number]

// ---------------------------------------------------------------------------
// Provider seam
// ---------------------------------------------------------------------------

/** Arguments to a production delivery provider's `deliver`. */
export interface ProductionDeliverArgs {
  readonly idempotencyKey: string
  readonly runId: string
  readonly destination: string
  readonly artifacts: readonly AutomationArtifact[]
  readonly contents: ReadonlyMap<string, Uint8Array>
  /** The owning tenant scope (for SSRF/destination isolation). */
  readonly owner: { readonly tenantId: string; readonly orgId: string; readonly projectId: string }
  /** Sanitized headers to send (provider may add its own auth). */
  readonly headers?: Readonly<Record<string, string>>
}

/** Outcome of a single delivery attempt. */
export interface ProductionDeliverResult {
  readonly delivered: boolean
  readonly resultRef: string
  readonly response: DeliveryResponse
  readonly retryClass: RetryClass
}

/**
 * Production delivery provider seam. Idempotent on `idempotencyKey`: a replay
 * returns the original result without side effects. Throws on failure with a
 * classifiable error; the caller records the attempt + retry decision.
 */
export interface ProductionDeliveryProvider extends DeliveryProvider {
  readonly id: string
  deliver(args: ProductionDeliverArgs): Promise<ProductionDeliverResult>
}

/** Base error for delivery providers. */
export class DeliveryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryClass: RetryClass,
    readonly status = 502,
  ) {
    super(message)
    this.name = "DeliveryError"
  }
}

/** SSRF rejection — a destination resolves to a forbidden address. */
export class SsrfBlockedError extends DeliveryError {
  constructor(destination: string, reason: string) {
    super("SSRF_BLOCKED", `Destination blocked by SSRF guard: ${reason} (${redactUrl(destination)})`, "permanent_validation", 422)
  }
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/** Redact credentials embedded in a URL for safe logging/audit. Brackets in the
 *  userinfo would be percent-encoded by URL.toString(), so we rebuild the URL
 *  without userinfo and append a marker only when credentials were present. */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw)
    const hadCreds = Boolean(u.username || u.password)
    u.username = ""
    u.password = ""
    const safe = u.toString()
    if (!hadCreds) return safe
    // Insert a marker after the scheme without percent-encoding artifacts.
    const schemeEnd = safe.indexOf("://") + 3
    return `${safe.slice(0, schemeEnd)}[redacted]@${safe.slice(schemeEnd)}`
  } catch {
    return "[invalid-url]"
  }
}

/** Sanitize response headers: drop auth-like keys + opaque secret values. */
export function sanitizeResponseHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase()
    if (/authorization|cookie|set-cookie|x-api-key|token|secret/i.test(lk)) {
      out[k] = "[redacted]"
    } else {
      out[k] = v
    }
  }
  return out
}
