/**
 * Durable event subscriptions + fan-out (Phase 2C).
 *
 * A subscription is a tenant/org/project-scoped rule that matches normalized
 * provider events and triggers an automation run. Matching is deterministic
 * (provider + event kind + resource pattern); a matched event produces exactly
 * one trigger per subscription, idempotent on (subscriptionId + eventId) — a
 * duplicate webhook never creates duplicate automation work.
 *
 * This is NOT a general workflow engine. A subscription maps one normalized
 * event to one automation-template run creation; the automation layer (Phase
 * 2A) owns the run lifecycle. Recovery re-drives stuck triggers idempotently
 * from the durable event log; it never invokes agent execution to repair
 * projections.
 *
 * Tenant isolation: every read is tenant-scoped; cross-tenant returns null/404.
 */

import { randomBytes } from "node:crypto"
import { SqlStoreBase, isUniqueViolation, type Migration, type SqlDialect, type SqlDatabase } from "@vaulltcore/store-sql"
import { type NormalizedEvent, type NormalizedEventKind, IntegrationError } from "./contracts"

export const SUBSCRIPTION_MIGRATIONS: readonly Migration[] = [
  {
    version: 2,
    name: "integration_subscriptions",
    statements: [
      `CREATE TABLE integration_subscriptions (
        subscription_id   TEXT PRIMARY KEY,
        tenant_id         TEXT NOT NULL,
        org_id            TEXT NOT NULL,
        project_id        TEXT NOT NULL,
        name              TEXT NOT NULL,
        provider          TEXT NOT NULL,
        event_kinds       TEXT NOT NULL,
        resource_pattern  TEXT NOT NULL,
        connection_id     TEXT,
        automation_template_id TEXT NOT NULL,
        input_mapping     TEXT NOT NULL,
        state             TEXT NOT NULL DEFAULT 'active',
        version           INTEGER NOT NULL DEFAULT 1,
        created_at        BIGINT NOT NULL,
        updated_at        BIGINT NOT NULL
      )`,
      `CREATE INDEX subscriptions_tenant_idx ON integration_subscriptions (tenant_id, org_id, project_id, state)`,
      `CREATE INDEX subscriptions_provider_idx ON integration_subscriptions (tenant_id, provider, state)`,
      // Durable normalized event log: the SOLE input to fan-out. UNIQUE event_id
      // rejects duplicate delivery; an orphan duplicate never creates work.
      `CREATE TABLE integration_events (
        event_id          TEXT PRIMARY KEY,
        tenant_id         TEXT NOT NULL,
        org_id            TEXT NOT NULL,
        project_id        TEXT NOT NULL,
        provider          TEXT NOT NULL,
        provider_event_id TEXT NOT NULL,
        kind              TEXT NOT NULL,
        resource          TEXT NOT NULL,
        action            TEXT,
        actor             TEXT,
        payload           TEXT NOT NULL,
        provider_timestamp BIGINT,
        received_at       BIGINT NOT NULL,
        processed         INTEGER NOT NULL DEFAULT 0,
        UNIQUE (tenant_id, provider, provider_event_id)
      )`,
      `CREATE INDEX events_unprocessed_idx ON integration_events (tenant_id, received_at) WHERE processed = 0`,
      // Durable trigger ledger: idempotent on (subscription_id, event_id). A
      // duplicate match never creates a second automation run.
      `CREATE TABLE integration_triggers (
        trigger_id        TEXT PRIMARY KEY,
        tenant_id         TEXT NOT NULL,
        subscription_id   TEXT NOT NULL,
        event_id          TEXT NOT NULL,
        automation_template_id TEXT NOT NULL,
        automation_run_id TEXT,
        state             TEXT NOT NULL DEFAULT 'pending',
        attempts          INTEGER NOT NULL DEFAULT 0,
        last_error        TEXT,
        created_at        BIGINT NOT NULL,
        updated_at        BIGINT NOT NULL,
        UNIQUE (subscription_id, event_id)
      )`,
      `CREATE INDEX triggers_pending_idx ON integration_triggers (tenant_id, state) WHERE state = 'pending'`,
      `CREATE INDEX triggers_event_idx ON integration_triggers (event_id)`,
    ],
  },
]

export const SUBSCRIPTION_STATES = ["active", "paused", "deleted"] as const
export type SubscriptionState = (typeof SUBSCRIPTION_STATES)[number]

export interface Subscription {
  readonly subscriptionId: string
  readonly tenantId: string
  readonly orgId: string
  readonly projectId: string
  readonly name: string
  readonly provider: string
  readonly eventKinds: readonly NormalizedEventKind[]
  readonly resourcePattern: string
  readonly connectionId: string | null
  readonly automationTemplateId: string
  readonly inputMapping: Readonly<Record<string, unknown>>
  readonly state: SubscriptionState
  readonly version: number
  readonly createdAt: number
  readonly updatedAt: number
}

export interface CreateSubscriptionInput {
  readonly tenantId: string
  readonly orgId: string
  readonly projectId: string
  readonly name: string
  readonly provider: string
  readonly eventKinds: readonly NormalizedEventKind[]
  /** Glob pattern matched against event.resource (e.g. "github:owner/repo" or "github:owner/*"). "*" matches all. */
  readonly resourcePattern: string
  readonly connectionId?: string | null
  readonly automationTemplateId: string
  readonly inputMapping?: Readonly<Record<string, unknown>>
}

interface SubscriptionRow {
  subscription_id: string
  tenant_id: string
  org_id: string
  project_id: string
  name: string
  provider: string
  event_kinds: string
  resource_pattern: string
  connection_id: string | null
  automation_template_id: string
  input_mapping: string
  state: string
  version: number
  created_at: number
  updated_at: number
}

interface EventRow {
  event_id: string
  tenant_id: string
  org_id: string
  project_id: string
  provider: string
  provider_event_id: string
  kind: string
  resource: string
  action: string | null
  actor: string | null
  payload: string
  provider_timestamp: number | null
  received_at: number
  processed: number
}

interface TriggerRow {
  trigger_id: string
  tenant_id: string
  subscription_id: string
  event_id: string
  automation_template_id: string
  automation_run_id: string | null
  state: string
  attempts: number
  last_error: string | null
  created_at: number
  updated_at: number
}

function toSubscription(row: SubscriptionRow): Subscription {
  return {
    subscriptionId: row.subscription_id,
    tenantId: row.tenant_id,
    orgId: row.org_id,
    projectId: row.project_id,
    name: row.name,
    provider: row.provider,
    eventKinds: JSON.parse(row.event_kinds) as NormalizedEventKind[],
    resourcePattern: row.resource_pattern,
    connectionId: row.connection_id,
    automationTemplateId: row.automation_template_id,
    inputMapping: JSON.parse(row.input_mapping) as Record<string, unknown>,
    state: row.state as SubscriptionState,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export interface SubscriptionStoreOptions {
  readonly dialect?: SqlDialect
  readonly beforeCommit?: (op: string) => void
}

export class SqlSubscriptionStore extends SqlStoreBase {
  constructor(db: SqlDatabase, options: SubscriptionStoreOptions = {}) {
    super(db, SUBSCRIPTION_MIGRATIONS, { ...(options.dialect ? { dialect: options.dialect } : {}), beforeCommit: options.beforeCommit })
  }

  async createSubscription(input: CreateSubscriptionInput): Promise<Subscription> {
    const subscriptionId = `sub_${randomBytes(12).toString("base64url")}`
    const now = Date.now()
    const row = {
      subscriptionId, tenantId: input.tenantId, orgId: input.orgId, projectId: input.projectId,
      name: input.name, provider: input.provider, eventKinds: JSON.stringify(input.eventKinds),
      resourcePattern: input.resourcePattern, connectionId: input.connectionId ?? null,
      automationTemplateId: input.automationTemplateId, inputMapping: JSON.stringify(input.inputMapping ?? {}),
      state: "active" as SubscriptionState, version: 1, createdAt: now, updatedAt: now,
    }
    this.atomic("createSubscription", () => {
      this.prepare(
        `INSERT INTO integration_subscriptions (
          subscription_id, tenant_id, org_id, project_id, name, provider, event_kinds,
          resource_pattern, connection_id, automation_template_id, input_mapping, state, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.subscriptionId, row.tenantId, row.orgId, row.projectId, row.name, row.provider, row.eventKinds,
        row.resourcePattern, row.connectionId, row.automationTemplateId, row.inputMapping, row.state, row.version, row.createdAt, row.updatedAt,
      )
    })
    const inserted = this.prepare("SELECT * FROM integration_subscriptions WHERE subscription_id = ?").get(subscriptionId) as unknown as SubscriptionRow
    return toSubscription(inserted)
  }

  async getSubscription(tenantId: string, subscriptionId: string): Promise<Subscription | null> {
    const row = this.prepare("SELECT * FROM integration_subscriptions WHERE subscription_id = ? AND tenant_id = ?").get(subscriptionId, tenantId) as unknown as SubscriptionRow | undefined
    return row ? toSubscription(row) : null
  }

  async listSubscriptions(scope: { tenantId: string; orgId?: string; projectId?: string }): Promise<Subscription[]> {
    const where = ["tenant_id = ?"]
    const params: (string | number)[] = [scope.tenantId]
    if (scope.orgId) { where.push("org_id = ?"); params.push(scope.orgId) }
    if (scope.projectId) { where.push("project_id = ?"); params.push(scope.projectId) }
    const rows = this.prepare(`SELECT * FROM integration_subscriptions WHERE ${where.join(" AND ")} AND state != 'deleted' ORDER BY created_at ASC`).all(...params) as unknown as SubscriptionRow[]
    return rows.map(toSubscription)
  }

  async setSubscriptionState(tenantId: string, subscriptionId: string, expectedVersion: number, state: SubscriptionState): Promise<Subscription> {
    let updated: Subscription | null = null
    this.atomic("setSubscriptionState", () => {
      const row = this.prepare("SELECT * FROM integration_subscriptions WHERE subscription_id = ? AND tenant_id = ?").get(subscriptionId, tenantId) as unknown as SubscriptionRow | undefined
      if (!row) throw new IntegrationError("SUBSCRIPTION_NOT_FOUND", "subscription not found", "permanent_validation", 404)
      if (row.version !== expectedVersion) throw new IntegrationError("VERSION_CONFLICT", "subscription was concurrently modified", "permanent_validation", 409)
      const result = this.prepare("UPDATE integration_subscriptions SET state = ?, version = ?, updated_at = ? WHERE subscription_id = ? AND tenant_id = ? AND version = ?").run(state, row.version + 1, Date.now(), subscriptionId, tenantId, row.version)
      if (result.changes === 0) throw new IntegrationError("VERSION_CONFLICT", "subscription was concurrently modified", "permanent_validation", 409)
      updated = toSubscription(this.prepare("SELECT * FROM integration_subscriptions WHERE subscription_id = ?").get(subscriptionId) as unknown as SubscriptionRow)
    })
    return updated!
  }

  /**
   * Persist a normalized event. Idempotent on (tenant, provider,
   * providerEventId) via UNIQUE — a duplicate webhook returns the existing
   * event id without creating a new one. Returns the event id and whether it
   * was newly created (so fan-out only triggers on first delivery).
   */
  async persistEvent(event: NormalizedEvent): Promise<{ eventId: string; created: boolean }> {
    try {
      this.atomic("persistEvent", () => {
        this.prepare(
          `INSERT INTO integration_events (
            event_id, tenant_id, org_id, project_id, provider, provider_event_id,
            kind, resource, action, actor, payload, provider_timestamp, received_at, processed
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        ).run(
          event.eventId, event.tenantId, event.orgId, event.projectId, event.provider, event.providerEventId,
          event.kind, event.resource, event.action, event.actor ? JSON.stringify(event.actor) : null,
          JSON.stringify(event.payload), event.providerTimestamp, event.receivedAt,
        )
      })
      return { eventId: event.eventId, created: true }
    } catch (error) {
      if (isUniqueViolation(error)) {
        const row = this.prepare("SELECT event_id FROM integration_events WHERE tenant_id = ? AND provider = ? AND provider_event_id = ?").get(event.tenantId, event.provider, event.providerEventId) as unknown as { event_id: string } | undefined
        return { eventId: row?.event_id ?? event.eventId, created: false }
      }
      throw error
    }
  }

  /** List subscriptions that match an event (provider + kind + resource glob).
   *  Tenant-scoped. */
  async matchSubscriptions(event: NormalizedEvent): Promise<Subscription[]> {
    const rows = this.prepare(
      "SELECT * FROM integration_subscriptions WHERE tenant_id = ? AND provider = ? AND state = 'active'",
    ).all(event.tenantId, event.provider) as unknown as SubscriptionRow[]
    return rows
      .map(toSubscription)
      .filter((sub) => {
        if (sub.eventKinds.length > 0 && !sub.eventKinds.includes(event.kind)) return false
        return globMatch(sub.resourcePattern, event.resource)
      })
  }

  /**
   * Record a trigger idempotently. UNIQUE (subscription_id, event_id) means a
   * duplicate match returns the existing trigger without creating a new one.
   */
  async recordTrigger(subscription: Subscription, event: NormalizedEvent): Promise<{ triggerId: string; created: boolean; existingRunId: string | null }> {
    const triggerId = `trig_${randomBytes(12).toString("base64url")}`
    const now = Date.now()
    try {
      this.atomic("recordTrigger", () => {
        this.prepare(
          `INSERT INTO integration_triggers (
            trigger_id, tenant_id, subscription_id, event_id, automation_template_id,
            automation_run_id, state, attempts, last_error, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, NULL, 'pending', 0, NULL, ?, ?)`,
        ).run(triggerId, event.tenantId, subscription.subscriptionId, event.eventId, subscription.automationTemplateId, now, now)
      })
      return { triggerId, created: true, existingRunId: null }
    } catch (error) {
      if (isUniqueViolation(error)) {
        const row = this.prepare("SELECT trigger_id, automation_run_id FROM integration_triggers WHERE subscription_id = ? AND event_id = ?").get(subscription.subscriptionId, event.eventId) as unknown as { trigger_id: string; automation_run_id: string | null } | undefined
        return { triggerId: row?.trigger_id ?? triggerId, created: false, existingRunId: row?.automation_run_id ?? null }
      }
      throw error
    }
  }

  /** Mark a trigger completed (run created) — idempotent, fenced. */
  async completeTrigger(tenantId: string, triggerId: string, automationRunId: string): Promise<void> {
    this.atomic("completeTrigger", () => {
      this.prepare("UPDATE integration_triggers SET state = 'completed', automation_run_id = ?, updated_at = ? WHERE trigger_id = ? AND tenant_id = ? AND state = 'pending'").run(automationRunId, Date.now(), triggerId, tenantId)
    })
  }

  /** Mark a trigger failed (retriable). */
  async failTrigger(tenantId: string, triggerId: string, error: string): Promise<void> {
    this.atomic("failTrigger", () => {
      this.prepare("UPDATE integration_triggers SET state = 'failed_retriable', attempts = attempts + 1, last_error = ?, updated_at = ? WHERE trigger_id = ? AND tenant_id = ?").run(error.slice(0, 500), Date.now(), triggerId, tenantId)
    })
  }

  /** List pending triggers for a tenant (recovery / worker input). */
  async listPendingTriggers(tenantId: string, limit = 100): Promise<Array<{ triggerId: string; subscriptionId: string; eventId: string; automationTemplateId: string; attempts: number }>> {
    const rows = this.prepare("SELECT * FROM integration_triggers WHERE tenant_id = ? AND state = 'pending' ORDER BY created_at ASC LIMIT ?").all(tenantId, limit) as unknown as TriggerRow[]
    return rows.map((r) => ({ triggerId: r.trigger_id, subscriptionId: r.subscription_id, eventId: r.event_id, automationTemplateId: r.automation_template_id, attempts: r.attempts }))
  }

  /** Mark an event processed (after fan-out). Idempotent. */
  async markEventProcessed(tenantId: string, eventId: string): Promise<void> {
    this.atomic("markEventProcessed", () => {
      this.prepare("UPDATE integration_events SET processed = 1 WHERE event_id = ? AND tenant_id = ?").run(eventId, tenantId)
    })
  }

  /** Get an event (tenant-scoped). */
  async getEvent(tenantId: string, eventId: string): Promise<NormalizedEvent | null> {
    const row = this.prepare("SELECT * FROM integration_events WHERE event_id = ? AND tenant_id = ?").get(eventId, tenantId) as unknown as EventRow | undefined
    if (!row) return null
    return {
      eventId: row.event_id, tenantId: row.tenant_id, orgId: row.org_id, projectId: row.project_id,
      provider: row.provider, providerEventId: row.provider_event_id, kind: row.kind as NormalizedEventKind,
      resource: row.resource, action: row.action, actor: row.actor ? JSON.parse(row.actor) : null,
      payload: JSON.parse(row.payload), providerTimestamp: row.provider_timestamp, receivedAt: row.received_at,
    }
  }
}

/** Simple glob matcher: "*" matches all; "prefix/*" matches prefix. No regex
 *  injection (literal segments + * wildcard only). */
export function globMatch(pattern: string, value: string): boolean {
  if (pattern === "*") return true
  if (!pattern.includes("*")) return pattern === value
  const parts = pattern.split("*")
  if (parts.length === 2) {
    const [prefix, suffix] = parts
    if (prefix && !value.startsWith(prefix)) return false
    if (suffix && !value.endsWith(suffix)) return false
    return true
  }
  // multi-* : match by sequential segments
  let idx = 0
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    if (part === "") continue
    const found = value.indexOf(part, idx)
    if (found === -1) return false
    idx = found + part.length
  }
  return true
}
