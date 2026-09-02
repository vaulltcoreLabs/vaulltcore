/**
 * Durable webhook event store (Phase 2C).
 *
 * Backed by {@link SqlStoreBase} over the same SqlDatabase/SqlDialect seam, so
 * it runs on node:sqlite (tests) and PGlite/Postgres identically. The
 * `(tenant_id, event_id)` UNIQUE is the dedup linearization point: a replay
 * returns the existing record without re-enqueuing. Tenant isolation is
 * enforced on every read (no cross-tenant existence leak — a miss returns
 * null, indistinguishable from absence). Raw events that fail normalization
 * are quarantined (forensics only; never reprocessed as instructions).
 */

import { type Migration, type SqlDatabase, type SqlDialect, type SqlRow, sqliteDialect, SqlStoreBase, isUniqueViolation } from "@vaulltcore/store-sql"
import type { NormalizedEvent } from "@vaulltcore/integration"
import type { QuarantinedRawEvent, WebhookEventRecord, WebhookEventState } from "./contracts"

const MIGRATIONS: readonly Migration[] = [
  {
    name: "webhook_core",
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS webhook_events (
        event_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        org_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_event_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        resource TEXT NOT NULL,
        action TEXT,
        actor TEXT,
        payload TEXT NOT NULL,
        provider_timestamp INTEGER,
        received_at INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'accepted',
        reject_reason TEXT,
        enqueued_at INTEGER,
        PRIMARY KEY (tenant_id, event_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_webhook_events_tenant_received ON webhook_events (tenant_id, received_at)`,
      `CREATE INDEX IF NOT EXISTS idx_webhook_events_state ON webhook_events (state, enqueued_at)`,
      `CREATE TABLE IF NOT EXISTS webhook_quarantine (
        id TEXT PRIMARY KEY,
        tenant_id TEXT,
        provider TEXT,
        raw_body TEXT NOT NULL,
        headers TEXT NOT NULL,
        reason TEXT NOT NULL,
        received_at INTEGER NOT NULL
      )`,
    ],
  },
]

function rowToRecord(row: SqlRow): WebhookEventRecord {
  return {
    eventId: String(row.event_id),
    tenantId: String(row.tenant_id),
    orgId: String(row.org_id),
    projectId: String(row.project_id),
    provider: String(row.provider),
    providerEventId: String(row.provider_event_id),
    kind: String(row.kind),
    resource: String(row.resource),
    action: row.action == null ? null : String(row.action),
    actor: row.actor == null ? null : String(row.actor),
    payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
    providerTimestamp: row.provider_timestamp == null ? null : Number(row.provider_timestamp),
    receivedAt: Number(row.received_at),
    state: String(row.state) as WebhookEventState,
    rejectReason: row.reject_reason == null ? null : String(row.reject_reason),
    enqueuedAt: row.enqueued_at == null ? null : Number(row.enqueued_at),
  }
}

export interface SqlWebhookStoreOptions {
  readonly dialect?: SqlDialect
  readonly beforeCommit?: (op: string) => void
}

export class SqlWebhookStore extends SqlStoreBase {
  constructor(db: SqlDatabase, options: SqlWebhookStoreOptions = {}) {
    super(db, MIGRATIONS, { dialect: options.dialect ?? sqliteDialect, beforeCommit: options.beforeCommit })
  }

  /**
   * Persist a normalized event idempotently. Returns the record + whether this
   * insert was new. A duplicate (UNIQUE violation) returns the existing record
   * with `inserted=false` — the caller treats it as a replay (no re-enqueue).
   */
  recordEvent(event: NormalizedEvent): { record: WebhookEventRecord; inserted: boolean } {
    const payload = JSON.stringify(event.payload)
    try {
      this.atomic("recordEvent", () => {
        this.prepare(
          `INSERT INTO webhook_events
            (event_id, tenant_id, org_id, project_id, provider, provider_event_id, kind, resource, action, actor, payload, provider_timestamp, received_at, state, reject_reason, enqueued_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', NULL, NULL)`,
        ).run(
          event.eventId, event.tenantId, event.orgId, event.projectId, event.provider,
          event.providerEventId, event.kind, event.resource, event.action, event.actor == null ? null : `${event.actor.externalId}|${event.actor.displayName ?? ""}`,
          payload, event.providerTimestamp, event.receivedAt,
        )
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        const existing = this.get(event.tenantId, event.eventId)
        if (existing) return { record: existing, inserted: false }
      }
      throw error
    }
    const rec = this.get(event.tenantId, event.eventId)
    return { record: rec!, inserted: true }
  }

  /** Mark an event enqueued (idempotent; a replay leaves enqueuedAt set). */
  markEnqueued(tenantId: string, eventId: string): void {
    this.atomic("markEnqueued", () => {
      this.prepare(`UPDATE webhook_events SET enqueued_at = ? WHERE tenant_id = ? AND event_id = ? AND enqueued_at IS NULL`)
        .run(Date.now(), tenantId, eventId)
    })
  }

  /** List enqueued events not yet processed (Phase 2D dispatch input).
   *  Ordered by enqueue time so a worker drains in arrival order. */
  listEnqueued(tenantId: string, limit = 100): WebhookEventRecord[] {
    const rows = this.prepare(`SELECT * FROM webhook_events WHERE tenant_id = ? AND state = 'accepted' AND enqueued_at IS NOT NULL ORDER BY enqueued_at ASC LIMIT ?`)
      .all(tenantId, limit).map(rowToRecord)
    return rows
  }

  /** Mark an enqueued event processed (dispatch attempted). */
  markProcessed(tenantId: string, eventId: string): void {
    this.atomic("markProcessed", () => {
      this.prepare(`UPDATE webhook_events SET state = 'processed' WHERE tenant_id = ? AND event_id = ? AND state = 'accepted'`)
        .run(tenantId, eventId)
    })
  }

  /** Transition state (fenced: only accepted→dead_lettered/processed). */
  transition(tenantId: string, eventId: string, to: WebhookEventState, reason: string | null = null): void {
    this.atomic("transition", () => {
      this.prepare(`UPDATE webhook_events SET state = ?, reject_reason = ? WHERE tenant_id = ? AND event_id = ? AND state = 'accepted'`)
        .run(to, reason, tenantId, eventId)
    })
  }

  /** Tenant-scoped get. Returns null on miss (no existence leak across tenants). */
  get(tenantId: string, eventId: string): WebhookEventRecord | null {
    const row = this.prepare(`SELECT * FROM webhook_events WHERE tenant_id = ? AND event_id = ?`).get(tenantId, eventId)
    return row ? rowToRecord(row) : null
  }

  /** List accepted-but-unenqueued events for the fan-out poller (tenant-scoped). */
  listPending(tenantId: string, limit = 100): readonly WebhookEventRecord[] {
    return this.prepare(`SELECT * FROM webhook_events WHERE tenant_id = ? AND state = 'accepted' AND enqueued_at IS NULL ORDER BY received_at LIMIT ?`)
      .all(tenantId, limit).map(rowToRecord)
  }

  /** Quarantine a raw event that failed normalization (forensics).
   *  Authorization/signature/cookie headers are redacted so a credential
   *  or signing secret can never leak into the quarantine bucket. */
  quarantine(raw: QuarantinedRawEvent): void {
    this.atomic("quarantine", () => {
      this.prepare(`INSERT INTO webhook_quarantine (id, tenant_id, provider, raw_body, headers, reason, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(raw.id, raw.tenantId, raw.provider, raw.rawBody, JSON.stringify(redactHeaders(raw.headers)), raw.reason, raw.receivedAt)
    })
  }
}

/** Redact credential/signature-bearing headers before raw payload storage so
 *  no secret crosses into the quarantine/forensics bucket. Signature headers
 *  are redacted too (conservative — they are HMAC outputs, not secrets). */
const REDACT_HEADER_KEYS = /^(authorization|x-hub-signature(-256)?|x-slack-signature|x-github-token|x-api-key|cookie|set-cookie)$/i
export function redactHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    out[key] = REDACT_HEADER_KEYS.test(key) ? "[redacted]" : value
  }
  return out
}
