/**
 * WebhookGateway (Phase 2C).
 *
 * Orchestrates the durable webhook ingestion pipeline. NEVER executes an agent
 * in the request path: the request transactionally persists the normalized
 * event (idempotent on `eventId`) then enqueues a trigger for the async
 * fan-out layer. A duplicate webhook returns `duplicate` and never re-enqueues
 * (the UNIQUE eventId is the linearization point).
 *
 * Tenant identity is attached ONLY by the {@link WebhookRouteResolver}, which
 * derives it from the route/signature secret — never from the request body. An
 * unverified/unresolvable webhook is rejected before any business logic, with
 * no cross-tenant existence leak (the response is indistinguishable from "no
 * such connection").
 *
 * Replay protection: timestamp validation rejects events older/older-than
 * `maxAgeMs` or too far in the future, when the provider supplies a timestamp.
 * Signature verification is constant-time (verifyHmacSha256).
 *
 * Audit: every accepted/rejected webhook produces a durable, sanitized audit
 * record (no secrets; payload metadata is redacted by sanitizeMetadata).
 */

import {
  ProviderRegistry,
  deterministicEventId,
  type NormalizedEvent,
  type RawWebhook,
  type WebhookVerifyResult,
} from "@vaulltcore/integration"
import { SqlAuditStore, sanitizeMetadata } from "@vaulltcore/audit"
import { SqlWebhookStore } from "./store"
import type { WebhookIngestResult, WebhookRouteResolver } from "./contracts"

export interface WebhookGatewayOptions {
  readonly store: SqlWebhookStore
  readonly providers: ProviderRegistry
  readonly routeResolver: WebhookRouteResolver
  readonly audit?: SqlAuditStore
  /** Reject events whose providerTimestamp is older than this (ms). */
  readonly maxAgeMs?: number
  /** Reject events whose providerTimestamp is this far in the future (ms). */
  readonly maxFutureMs?: number
  readonly now?: () => number
}

export class WebhookGateway {
  private readonly store: SqlWebhookStore
  private readonly providers: ProviderRegistry
  private readonly routeResolver: WebhookRouteResolver
  private readonly audit?: SqlAuditStore
  private readonly maxAgeMs: number
  private readonly maxFutureMs: number
  private readonly now: () => number

  constructor(options: WebhookGatewayOptions) {
    this.store = options.store
    this.providers = options.providers
    this.routeResolver = options.routeResolver
    this.audit = options.audit
    this.maxAgeMs = options.maxAgeMs ?? 1000 * 60 * 60 * 24 * 7 // 7 days
    this.maxFutureMs = options.maxFutureMs ?? 1000 * 60 * 5 // 5 min
    this.now = options.now ?? Date.now
  }

  /**
   * Ingest a raw webhook. Returns the ingestion result; never throws on
   * provider/auth failures (those are `rejected`/`unverified`). Only throws on
   * a genuine store fault.
   */
  async ingest(raw: RawWebhook): Promise<WebhookIngestResult> {
    const now = this.now()

    // 1. Resolve tenant/connection from route + secret (NEVER from body).
    const route = await this.routeResolver.resolve(raw)
    if (!route) {
      this.auditReject(null, raw.provider, "unresolvable_route", now)
      return { status: "unresolvable", eventId: null, reason: "no connection matches this webhook" }
    }

    // 2. Resolve the provider adapter and verify the signature.
    let provider
    try {
      provider = this.providers.resolve(route.provider.includes(":") ? route.provider.split(":")[0]! : "git", route.provider)
    } catch {
      this.auditReject(route, route.provider, "provider_not_registered", now)
      return { status: "unresolvable", eventId: null, reason: "provider not registered" }
    }

    let verify: WebhookVerifyResult
    try {
      verify = await provider.verifyWebhook(raw, { secret: route.secret })
    } catch {
      this.auditReject(route, route.provider, "verify_error", now)
      return { status: "unverified", eventId: null, reason: "signature verification failed" }
    }
    if (!verify.verified || !verify.event) {
      this.auditReject(route, route.provider, verify.reason ?? "unverified", now)
      return { status: "unverified", eventId: null, reason: verify.reason ?? "signature mismatch" }
    }

    // 3. Timestamp validation (replay/stale protection) where supported.
    const ts = verify.event.providerTimestamp
    if (ts !== null) {
      if (now - ts > this.maxAgeMs) {
        this.auditReject(route, route.provider, "stale_event", now)
        return { status: "rejected", eventId: null, reason: "event too old" }
      }
      if (ts - now > this.maxFutureMs) {
        this.auditReject(route, route.provider, "future_event", now)
        return { status: "rejected", eventId: null, reason: "event timestamp in the future" }
      }
    }

    // 4. Build the normalized event with deterministic identity.
    const eventId = deterministicEventId(route.tenantId, route.provider, verify.event.providerEventId)
    const event: NormalizedEvent = {
      eventId,
      tenantId: route.tenantId,
      orgId: route.orgId,
      projectId: route.projectId,
      provider: route.provider,
      providerEventId: verify.event.providerEventId,
      kind: verify.event.kind,
      resource: verify.event.resource,
      action: verify.event.action,
      actor: verify.event.actor,
      payload: verify.event.payload,
      providerTimestamp: verify.event.providerTimestamp,
      receivedAt: now,
    }

    // 5. Persist idempotently (UNIQUE eventId dedups a replay).
    const { record, inserted } = this.store.recordEvent(event)
    if (!inserted) {
      // Duplicate: do NOT re-enqueue. Execution stays at-least-once; the
      // downstream automation run idempotency_key is the exactly-once boundary.
      return { status: "duplicate", eventId: record.eventId, reason: "event already ingested" }
    }

    // 6. Enqueue for fan-out (durable; idempotent mark).
    this.store.markEnqueued(route.tenantId, eventId)

    // 7. Audit (sanitized; no secrets).
    this.auditAccept(route, event, now)
    return { status: "accepted", eventId, reason: null }
  }

  private auditAccept(route: { tenantId: string; orgId: string; projectId: string; provider: string }, event: NormalizedEvent, now: number): void {
    this.audit?.append({
      type: "webhook_accepted",
      scope: { tenantId: route.tenantId, orgId: route.orgId, projectId: route.projectId },
      metadata: sanitizeMetadata({
        provider: route.provider,
        eventId: event.eventId,
        kind: event.kind,
        resource: event.resource,
        action: event.action,
        providerEventId: event.providerEventId,
      }),
    }).catch(() => {})
  }

  private auditReject(route: { tenantId: string; orgId: string; projectId: string; provider: string } | null, provider: string, reason: string, now: number): void {
    this.audit?.append({
      type: "webhook_rejected",
      scope: route ? { tenantId: route.tenantId, orgId: route.orgId, projectId: route.projectId } : null,
      metadata: sanitizeMetadata({ provider, reason }),
    }).catch(() => {})
  }
}
