/**
 * Durable webhook gateway contracts (Phase 2C).
 *
 * The gateway turns a raw inbound provider webhook into durable, deduplicated,
 * tenant-scoped work WITHOUT ever executing an agent in the request path. The
 * request transactionally persists the normalized event (idempotent on
 * `eventId` = sha256(tenant|provider|providerEventId)) then enqueues a trigger
 * for the automation fan-out layer to process asynchronously.
 *
 * Pipeline (all synchronous-within-a-transaction except the provider verify):
 *
 *   HTTP webhook
 *     → verify signature (provider adapter; constant-time HMAC)
 *     → resolve integration → tenant + connectionId (NEVER from body)
 *     → tenant authorization (principal may receive this provider's events?)
 *     → deduplicate provider event (UNIQUE eventId; replay = no-op)
 *     → timestamp validation where supported (reject stale/future)
 *     → persist normalized event (durable)
 *     → enqueue trigger (durable; at-least-once downstream)
 *     → audit (accepted/rejected; no secrets)
 *
 * A duplicate webhook NEVER creates duplicate automation work: the UNIQUE
 * eventId is the linearization point; a replay returns the existing event id
 * without re-enqueuing. Execution stays at-least-once; the trigger settlement
 * is exactly-once at the durable identity boundary (Phase 2A automation run
 * idempotency_key).
 */

import type { NormalizedEvent, RawWebhook } from "@vaulltcore/integration"

/** Lifecycle of an ingested webhook event. */
export type WebhookEventState = "accepted" | "rejected" | "dead_lettered" | "processed"

/** A durable, deduplicated webhook event record. */
export interface WebhookEventRecord {
  readonly eventId: string
  readonly tenantId: string
  readonly orgId: string
  readonly projectId: string
  readonly provider: string
  readonly providerEventId: string
  readonly kind: string
  readonly resource: string
  readonly action: string | null
  readonly actor: string | null
  readonly payload: Readonly<Record<string, unknown>>
  readonly providerTimestamp: number | null
  readonly receivedAt: number
  readonly state: WebhookEventState
  readonly rejectReason: string | null
  /** Set when the event has been enqueued for fan-out (idempotent). */
  readonly enqueuedAt: number | null
}

/** Result of ingesting a raw webhook. */
export interface WebhookIngestResult {
  readonly status: "accepted" | "duplicate" | "rejected" | "unverified" | "unresolvable"
  readonly eventId: string | null
  readonly reason: string | null
}

/**
 * Resolves a raw webhook's provider + path to a tenant/connectionId. The
 * resolver is the ONLY place tenant identity is attached — it derives tenant
 * from the route/signature secret, NEVER from the request body. A webhook
 * whose signature cannot be matched to a tenant connection is rejected before
 * any business logic (no existence leak).
 */
export interface WebhookRouteResolver {
  /**
   * @returns the connectionId + tenant scope the webhook belongs to, or null
   *          if no connection matches (unverified → reject, no leak).
   */
  resolve(raw: RawWebhook): Promise<{ readonly tenantId: string; readonly orgId: string; readonly projectId: string; readonly connectionId: string; readonly provider: string; readonly secret: string } | null>
}

/** Quarantine bucket for raw events that failed normalization (forensics). */
export interface QuarantinedRawEvent {
  readonly id: string
  readonly tenantId: string | null
  readonly provider: string | null
  readonly rawBody: string
  readonly headers: Readonly<Record<string, string>>
  readonly reason: string
  readonly receivedAt: number
}
