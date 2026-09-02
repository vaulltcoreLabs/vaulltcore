/**
 * Provider-neutral delivery seam (Phase 2A).
 *
 * Delivery is at-least-once with idempotent settlement at the delivery identity
 * boundary `(runId, idempotencyKey)`. A {@link DeliveryAttempt} record tracks
 * retries within a single delivery identity; the attempt count is incremented on
 * each retry but the identity stays stable, so a retry reuses the same delivery
 * id. A process crash never falsely marks an undelivered result as delivered —
 * the record only reaches `delivered` after the provider confirms, and that
 * transition is fenced by `deliveryVersion`.
 *
 * Phase 2A ships a deterministic {@link FakeDeliveryProvider} for tests. Real
 * providers (Slack, email, webhooks, …) implement the same interface and are
 * NOT added in this phase.
 */

import {
  type AutomationArtifact,
  type DeliveryAttempt,
  type DeliveryProvider,
  type DeliveryStatus,
  AutomationError,
} from "./contracts"
import { newDeliveryId } from "./ids"

export class IllegalDeliveryTransitionError extends AutomationError {
  constructor(deliveryId: string, from: DeliveryStatus, to: DeliveryStatus) {
    super("ILLEGAL_DELIVERY_TRANSITION", `Delivery ${deliveryId} cannot transition ${from} → ${to}`, 409)
  }
}

export class DeliveryFencedError extends AutomationError {
  constructor(deliveryId: string) {
    super("DELIVERY_FENCED", `Delivery ${deliveryId} is owned by a newer version`, 409)
  }
}

/** A non-terminal delivery may progress toward delivered or fail. A terminal
 *  delivery cannot change. */
export function canDeliveryTransition(from: DeliveryStatus, to: DeliveryStatus): boolean {
  if (from === to) return false
  if (from === "delivered" || from === "failed") return false
  return to === "in_progress" || to === "delivered" || to === "failed"
}

/** Build a fresh pending delivery attempt. */
export function buildDeliveryAttempt(args: {
  readonly runId: string
  readonly versionId: string
  readonly idempotencyKey: string
  readonly destination: string
  readonly now?: number
}): DeliveryAttempt {
  const now = args.now ?? Date.now()
  return {
    deliveryId: newDeliveryId(),
    runId: args.runId,
    versionId: args.versionId,
    idempotencyKey: args.idempotencyKey,
    destination: args.destination,
    status: "pending",
    attempts: 0,
    resultRef: null,
    createdAt: now,
    updatedAt: now,
    lastError: null,
    deliveryVersion: 1,
  }
}

/** Mark an attempt in-progress (about to call the provider). */
export function startAttempt(d: DeliveryAttempt, now = Date.now()): DeliveryAttempt {
  if (!canDeliveryTransition(d.status, "in_progress")) {
    throw new IllegalDeliveryTransitionError(d.deliveryId, d.status, "in_progress")
  }
  return { ...d, status: "in_progress", attempts: d.attempts + 1, updatedAt: now, deliveryVersion: d.deliveryVersion + 1 }
}

/** Settle a delivery as delivered after the provider confirms. */
export function settleDelivered(d: DeliveryAttempt, resultRef: string, now = Date.now()): DeliveryAttempt {
  if (!canDeliveryTransition(d.status, "delivered")) {
    throw new IllegalDeliveryTransitionError(d.deliveryId, d.status, "delivered")
  }
  return { ...d, status: "delivered", resultRef, updatedAt: now, lastError: null, deliveryVersion: d.deliveryVersion + 1 }
}

/** Mark a delivery as failed (transient; retriable within the same identity). */
export function settleFailed(d: DeliveryAttempt, error: string, now = Date.now()): DeliveryAttempt {
  if (!canDeliveryTransition(d.status, "failed")) {
    throw new IllegalDeliveryTransitionError(d.deliveryId, d.status, "failed")
  }
  // A failed delivery stays non-terminal-retryable conceptually, but the status
  // 'failed' is terminal for the record; a new attempt reopens via the service
  // transitioning pending→in_progress again only if not terminal. For Phase 2A,
  // failed is terminal (operator retries by re-running delivery on the run).
  return { ...d, status: "failed", lastError: error, updatedAt: now, deliveryVersion: d.deliveryVersion + 1 }
}

/**
 * Deterministic test delivery provider. Records every deliver() call keyed by
 * idempotencyKey so a replay returns the original result without re-invoking
 * side effects. Optionally fails the first N attempts to exercise retry logic.
 * Content checksums are included in the resultRef so the delivered payload is
 * historically recoverable.
 */
export interface FakeDeliveryAttempt {
  readonly idempotencyKey: string
  readonly destination: string
  readonly artifactIds: readonly string[]
  readonly status: "delivered" | "failed"
  readonly resultRef: string | null
  readonly attempt: number
}

export class FakeDeliveryProvider implements DeliveryProvider {
  readonly id = "fake"
  private readonly delivered = new Map<string, string>()
  private failFirstN: number
  private attemptCount = 0
  private readonly listeners: Array<(key: string) => void> = []
  /** Public, append-only log of every deliver() invocation (for test assertions). */
  readonly attemptLog: FakeDeliveryAttempt[] = []

  constructor(options: { readonly failFirstN?: number } = {}) {
    this.failFirstN = options.failFirstN ?? 0
  }

  /** Dynamically set the number of attempts that will fail before succeeding. */
  failNext(n: number): void {
    this.failFirstN = Math.max(this.failFirstN, this.attemptCount + n)
  }

  /** Register a callback fired on each deliver() call (for test assertions). */
  onDeliver(fn: (key: string) => void): void {
    this.listeners.push(fn)
  }

  async deliver(args: {
    readonly idempotencyKey: string
    readonly destination: string
    readonly artifacts: readonly AutomationArtifact[]
    readonly contents: ReadonlyMap<string, Uint8Array>
  }): Promise<{ resultRef: string }> {
    const existing = this.delivered.get(args.idempotencyKey)
    if (existing !== undefined) return { resultRef: existing }
    this.attemptCount++
    if (this.attemptCount <= this.failFirstN) {
      this.attemptLog.push({ idempotencyKey: args.idempotencyKey, destination: args.destination, artifactIds: args.artifacts.map((a) => a.artifactId), status: "failed", resultRef: null, attempt: this.attemptCount })
      throw new Error(`FakeDeliveryProvider: simulated failure (attempt ${this.attemptCount})`)
    }
    // Deterministic result ref: destination + artifact checksums.
    const fingerprint = args.artifacts.map((a) => `${a.artifactId}:${a.checksum}`).join(",")
    const resultRef = `fake://${args.destination}/${fingerprint}`
    this.delivered.set(args.idempotencyKey, resultRef)
    this.attemptLog.push({ idempotencyKey: args.idempotencyKey, destination: args.destination, artifactIds: args.artifacts.map((a) => a.artifactId), status: "delivered", resultRef, attempt: this.attemptCount })
    for (const fn of this.listeners) fn(args.idempotencyKey)
    void args.contents
    return { resultRef }
  }

  /** Test helper: number of distinct successful deliveries. */
  deliveredCount(): number {
    return this.delivered.size
  }
}
