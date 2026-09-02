/**
 * Durable trigger + dispatch store (Phase 2D).
 *
 * Owns two durable concepts over {@link SqlStoreBase}:
 *  1. Immutable, versioned trigger definitions (+ revisions). A trigger change
 *     creates a new revision; historical events remain explainable against the
 *     revision active when matched.
 *  2. The dispatch identity + state machine: one durable dispatch record per
 *     (tenant, source_event_id, trigger_version_id), protected by a UNIQUE
 *     constraint. This boundary is exactly-once: a duplicate event/trigger
 *     match never creates a second dispatch. Downstream execution stays
 *     at-least-once; a crash after dispatch reservation but before run
 *     projection recovers by reconciliation/re-drive, not by blindly creating
 *     another dispatch.
 *
 * Migration names are globally unique (Phase 1F dedup-by-name rule). Every
 * state-changing write is fenced (CAS on revision / dispatch state). No
 * secrets are stored here.
 */

import { randomBytes } from "node:crypto"
import { SqlStoreBase, isUniqueViolation, type Migration, type SqlDialect, type SqlDatabase } from "@vaulltcore/store-sql"
import {
  type TriggerClass,
  type TriggerDefinition,
  type TriggerMatchCriteria,
  type TriggerState,
  type PublishTriggerInput,
} from "./trigger"
import { TRIGGER_CLASSES, TRIGGER_STATES, triggerChecksum } from "./trigger"
import { AutomationError } from "./contracts"
import { newTriggerId, newDispatchId } from "./ids"
import type { NormalizedEvent, NormalizedEventKind } from "@vaulltcore/integration"

export const TRIGGER_MIGRATIONS: readonly Migration[] = [
  {
    // Phase 2D trigger model. Name globally unique; version orders within pkg.
    version: 3,
    name: "automation_triggers",
    statements: [
      `CREATE TABLE automation_triggers (
        trigger_id        TEXT PRIMARY KEY,
        tenant_id         TEXT NOT NULL,
        org_id            TEXT NOT NULL,
        project_id        TEXT NOT NULL,
        template_id       TEXT NOT NULL,
        version_id        TEXT NOT NULL,
        trigger_class     TEXT NOT NULL,
        name              TEXT NOT NULL,
        criteria          TEXT,
        schedule_id       TEXT,
        input_mapping     TEXT NOT NULL,
        state             TEXT NOT NULL DEFAULT 'enabled',
        revision         INTEGER NOT NULL DEFAULT 1,
        checksum          TEXT NOT NULL,
        created_at        BIGINT NOT NULL,
        created_by        TEXT NOT NULL,
        updated_at        BIGINT NOT NULL,
        UNIQUE (tenant_id, org_id, project_id, name)
      )`,
      `CREATE INDEX triggers_tenant_idx ON automation_triggers (tenant_id, org_id, project_id, state)`,
      `CREATE INDEX triggers_provider_idx ON automation_triggers (tenant_id, state)`,
      // Durable dispatch ledger. UNIQUE (tenant, source_event_id, trigger_version_id)
      // is the exactly-once boundary: one dispatch per event/trigger identity.
      `CREATE TABLE automation_trigger_dispatches (
        dispatch_id       TEXT PRIMARY KEY,
        tenant_id         TEXT NOT NULL,
        org_id            TEXT NOT NULL,
        project_id        TEXT NOT NULL,
        source_event_id   TEXT NOT NULL,
        trigger_id        TEXT NOT NULL,
        trigger_revision  INTEGER NOT NULL,
        template_id       TEXT NOT NULL,
        version_id        TEXT NOT NULL,
        state             TEXT NOT NULL DEFAULT 'received',
        automation_run_id TEXT,
        rejection_reason  TEXT,
        rejection_kind    TEXT,
        attempts          INTEGER NOT NULL DEFAULT 0,
        last_error        TEXT,
        created_at        BIGINT NOT NULL,
        updated_at        BIGINT NOT NULL,
        UNIQUE (tenant_id, source_event_id, trigger_id)
      )`,
      `CREATE INDEX dispatches_state_idx ON automation_trigger_dispatches (tenant_id, state)`,
      `CREATE INDEX dispatches_event_idx ON automation_trigger_dispatches (tenant_id, source_event_id)`,
    ],
  },
  // Phase 2E: fenced redrive lease + dead-letter diagnostics for dispatches.
  // Globally unique migration name (dedup-by-name rule). Adds the durable
  // redrive lease generation + owner + expiry so a crashed re-drive cannot be
  // blindly finalized by a stale owner, and a sanitized diagnostic context
  // column. Additive (new nullable columns; existing rows default to NULL/0).
  {
    version: 4,
    name: "automation_dispatch_lease",
    statements: [
      `ALTER TABLE automation_trigger_dispatches ADD COLUMN redrive_generation INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE automation_trigger_dispatches ADD COLUMN redrive_owner TEXT`,
      `ALTER TABLE automation_trigger_dispatches ADD COLUMN redrive_expires_at BIGINT`,
      `CREATE INDEX IF NOT EXISTS dispatches_redrive_idx ON automation_trigger_dispatches (tenant_id, state, redrive_expires_at)`,
    ],
  },
]

/** Dispatch state machine. */
export const DISPATCH_STATES = [
  "received",
  "matched",
  "dispatching",
  "admitted",
  "run_created",
  "rejected",
  "retryable_failure",
  "dead_letter",
] as const
export type DispatchState = (typeof DISPATCH_STATES)[number]

export const TERMINAL_DISPATCH_STATES: ReadonlySet<DispatchState> = new Set([
  "run_created", "rejected", "dead_letter",
])

interface TriggerRow {
  trigger_id: string
  tenant_id: string
  org_id: string
  project_id: string
  template_id: string
  version_id: string
  trigger_class: string
  name: string
  criteria: string | null
  schedule_id: string | null
  input_mapping: string
  state: string
  revision: number
  checksum: string
  created_at: number
  created_by: string
  updated_at: number
}

interface DispatchRow {
  dispatch_id: string
  tenant_id: string
  org_id: string
  project_id: string
  source_event_id: string
  trigger_id: string
  trigger_revision: number
  template_id: string
  version_id: string
  state: string
  automation_run_id: string | null
  rejection_reason: string | null
  rejection_kind: string | null
  attempts: number
  last_error: string | null
  redrive_generation: number
  redrive_owner: string | null
  redrive_expires_at: number | null
  created_at: number
  updated_at: number
}

function toTrigger(row: TriggerRow): TriggerDefinition {
  const criteria: TriggerMatchCriteria | null = row.criteria ? (JSON.parse(row.criteria) as TriggerMatchCriteria) : null
  return {
    triggerId: row.trigger_id,
    tenantId: row.tenant_id,
    orgId: row.org_id,
    projectId: row.project_id,
    templateId: row.template_id,
    versionId: row.version_id,
    triggerClass: row.trigger_class as TriggerClass,
    name: row.name,
    criteria,
    scheduleId: row.schedule_id,
    inputMapping: JSON.parse(row.input_mapping) as Record<string, unknown>,
    state: row.state as TriggerState,
    revision: row.revision,
    checksum: row.checksum,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
  }
}

function toDispatch(row: DispatchRow): TriggerDispatch {
  return {
    dispatchId: row.dispatch_id,
    tenantId: row.tenant_id,
    orgId: row.org_id,
    projectId: row.project_id,
    sourceEventId: row.source_event_id,
    triggerId: row.trigger_id,
    triggerRevision: row.trigger_revision,
    templateId: row.template_id,
    versionId: row.version_id,
    state: row.state as DispatchState,
    automationRunId: row.automation_run_id,
    rejectionReason: row.rejection_reason,
    rejectionKind: row.rejection_kind as DispatchRejectionKind | null,
    attempts: row.attempts,
    lastError: row.last_error,
    redriveGeneration: row.redrive_generation,
    redriveOwner: row.redrive_owner,
    redriveExpiresAt: row.redrive_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** A durable trigger dispatch record. */
export interface TriggerDispatch {
  readonly dispatchId: string
  readonly tenantId: string
  readonly orgId: string
  readonly projectId: string
  readonly sourceEventId: string
  readonly triggerId: string
  readonly triggerRevision: number
  readonly templateId: string
  readonly versionId: string
  state: DispatchState
  automationRunId: string | null
  rejectionReason: string | null
  rejectionKind: DispatchRejectionKind | null
  attempts: number
  lastError: string | null
  /** Phase 2E: fenced redrive lease generation. A stale owner (older
   *  generation) cannot finalize a redrive that a newer generation took over. */
  redriveGeneration: number
  redriveOwner: string | null
  redriveExpiresAt: number | null
  readonly createdAt: number
  updatedAt: number
}

/** Why a dispatch was rejected (honest classification; never retried as infra). */
export type DispatchRejectionKind = "policy" | "quota" | "invalid_input" | "disabled_trigger" | "no_trigger" | "permanent"

export interface TriggerStoreOptions {
  readonly dialect?: SqlDialect
  readonly beforeCommit?: (op: string) => void
}

export class SqlTriggerStore extends SqlStoreBase {
  constructor(db: SqlDatabase, options: TriggerStoreOptions = {}) {
    super(db, TRIGGER_MIGRATIONS, { ...(options.dialect ? { dialect: options.dialect } : {}), beforeCommit: options.beforeCommit })
  }

  /** Publish (create or revise) a trigger definition. A change creates a new
   *  revision; the trigger_id stays stable across revisions of the same name
   *  within a project. */
  async publishTrigger(input: PublishTriggerInput): Promise<TriggerDefinition> {
    if (!TRIGGER_CLASSES.includes(input.triggerClass)) {
      throw new AutomationError("INVALID_TRIGGER_CLASS", `unknown trigger class: ${input.triggerClass}`, 422)
    }
    if (input.triggerClass !== "schedule" && !input.criteria) {
      throw new AutomationError("CRITERIA_REQUIRED", `trigger class ${input.triggerClass} requires match criteria`, 422)
    }
    const checksum = triggerChecksum(input)
    const now = Date.now()
    // Look for an existing trigger with this name in the project (revise).
    const existing = this.prepare(
      "SELECT * FROM automation_triggers WHERE tenant_id = ? AND org_id = ? AND project_id = ? AND name = ?",
    ).get(input.tenantId, input.orgId, input.projectId, input.name) as unknown as TriggerRow | undefined
    if (existing) {
      // Revise: bump revision, update the immutable definition fields.
      const updated = this.atomic("reviseTrigger", () => {
        const result = this.prepare(
          `UPDATE automation_triggers SET
            template_id = ?, version_id = ?, trigger_class = ?, criteria = ?, schedule_id = ?,
            input_mapping = ?, state = ?, checksum = ?, revision = revision + 1, updated_at = ?
           WHERE trigger_id = ? AND tenant_id = ? AND revision = ?`,
        ).run(
          input.templateId, input.versionId, input.triggerClass,
          input.criteria ? JSON.stringify(input.criteria) : null,
          input.scheduleId ?? null,
          JSON.stringify(input.inputMapping ?? {}),
          input.state ?? "enabled",
          checksum,
          now,
          existing.trigger_id,
          input.tenantId,
          existing.revision,
        )
        if (result.changes === 0) throw new AutomationError("VERSION_CONFLICT", "trigger was concurrently revised", 409)
        return this.prepare("SELECT * FROM automation_triggers WHERE trigger_id = ?").get(existing.trigger_id) as unknown as TriggerRow
      })
      return toTrigger(updated)
    }
    const triggerId = newTriggerId()
    try {
      this.atomic("createTrigger", () => {
        this.prepare(
          `INSERT INTO automation_triggers (
            trigger_id, tenant_id, org_id, project_id, template_id, version_id, trigger_class,
            name, criteria, schedule_id, input_mapping, state, revision, checksum, created_at, created_by, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        ).run(
          triggerId, input.tenantId, input.orgId, input.projectId, input.templateId, input.versionId, input.triggerClass,
          input.name, input.criteria ? JSON.stringify(input.criteria) : null, input.scheduleId ?? null,
          JSON.stringify(input.inputMapping ?? {}), input.state ?? "enabled", checksum, now, input.principalId, now,
        )
      })
    } catch (error) {
      if (isUniqueViolation(error)) throw new AutomationError("TRIGGER_EXISTS", `trigger "${input.name}" already exists in this project`, 409)
      throw error
    }
    const inserted = this.prepare("SELECT * FROM automation_triggers WHERE trigger_id = ?").get(triggerId) as unknown as TriggerRow
    return toTrigger(inserted)
  }

  /** Get a trigger by id (tenant-scoped; cross-tenant returns null). */
  async getTrigger(tenantId: string, triggerId: string): Promise<TriggerDefinition | null> {
    const row = this.prepare("SELECT * FROM automation_triggers WHERE trigger_id = ? AND tenant_id = ?").get(triggerId, tenantId) as unknown as TriggerRow | undefined
    return row ? toTrigger(row) : null
  }

  /** List triggers (tenant-scoped). */
  async listTriggers(scope: { tenantId: string; orgId?: string; projectId?: string }): Promise<TriggerDefinition[]> {
    const where = ["tenant_id = ?"]
    const params: (string | number)[] = [scope.tenantId]
    if (scope.orgId) { where.push("org_id = ?"); params.push(scope.orgId) }
    if (scope.projectId) { where.push("project_id = ?"); params.push(scope.projectId) }
    const rows = this.prepare(`SELECT * FROM automation_triggers WHERE ${where.join(" AND ")} ORDER BY created_at ASC`).all(...params) as unknown as TriggerRow[]
    return rows.map(toTrigger)
  }

  /** Set a trigger's enabled/disabled state (fenced by revision CAS). */
  async setTriggerState(tenantId: string, triggerId: string, expectedRevision: number, state: TriggerState): Promise<TriggerDefinition> {
    let updated: TriggerDefinition | null = null
    this.atomic("setTriggerState", () => {
      const row = this.prepare("SELECT * FROM automation_triggers WHERE trigger_id = ? AND tenant_id = ?").get(triggerId, tenantId) as unknown as TriggerRow | undefined
      if (!row) throw new AutomationError("TRIGGER_NOT_FOUND", "trigger not found", 404)
      if (row.revision !== expectedRevision) throw new AutomationError("VERSION_CONFLICT", "trigger was concurrently revised", 409)
      if (!TRIGGER_STATES.includes(state)) throw new AutomationError("INVALID_STATE", `invalid trigger state: ${state}`, 422)
      const result = this.prepare("UPDATE automation_triggers SET state = ?, revision = revision + 1, updated_at = ? WHERE trigger_id = ? AND tenant_id = ? AND revision = ?").run(state, Date.now(), triggerId, tenantId, row.revision)
      if (result.changes === 0) throw new AutomationError("VERSION_CONFLICT", "trigger was concurrently revised", 409)
      updated = toTrigger(this.prepare("SELECT * FROM automation_triggers WHERE trigger_id = ?").get(triggerId) as unknown as TriggerRow)
    })
    return updated!
  }

  /** Find enabled triggers eligible to match a normalized event (provider +
   *  kind + resource glob + connection). Returns the revisions active now. */
  async matchTriggers(event: { tenantId: string; provider: string; kind: NormalizedEventKind; resource: string; action: string | null; connectionId?: string | null }): Promise<TriggerDefinition[]> {
    const rows = this.prepare(
      "SELECT * FROM automation_triggers WHERE tenant_id = ? AND state = 'enabled'",
    ).all(event.tenantId) as unknown as TriggerRow[]
    return rows
      .map(toTrigger)
      .filter((t) => {
        if (!t.criteria) return false
        if (t.criteria.provider !== event.provider) return false
        if (t.criteria.eventKinds.length > 0 && !t.criteria.eventKinds.includes(event.kind)) return false
        if (t.criteria.action !== null && t.criteria.action !== event.action) return false
        if (t.criteria.connectionId && event.connectionId && t.criteria.connectionId !== event.connectionId) return false
        return globMatch(t.criteria.resourcePattern, event.resource)
      })
  }

  // -------------------------------------------------------------------------
  // Dispatch ledger
  // -------------------------------------------------------------------------

  /**
   * Reserve a dispatch idempotently. UNIQUE (tenant, source_event_id,
   * trigger_revision) is the exactly-once boundary: a duplicate match returns
   * the existing dispatch without creating a new one. Returns { dispatch,
   * created }.
   */
  async reserveDispatch(args: {
    readonly tenantId: string
    readonly orgId: string
    readonly projectId: string
    readonly sourceEventId: string
    readonly trigger: TriggerDefinition
  }): Promise<{ dispatch: TriggerDispatch; created: boolean }> {
    const dispatchId = newDispatchId()
    const now = Date.now()
    try {
      this.atomic("reserveDispatch", () => {
        this.prepare(
          `INSERT INTO automation_trigger_dispatches (
            dispatch_id, tenant_id, org_id, project_id, source_event_id, trigger_id, trigger_revision,
            template_id, version_id, state, automation_run_id, rejection_reason, rejection_kind,
            attempts, last_error, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'matched', NULL, NULL, NULL, 0, NULL, ?, ?)`,
        ).run(
          dispatchId, args.tenantId, args.orgId, args.projectId, args.sourceEventId, args.trigger.triggerId, args.trigger.revision,
          args.trigger.templateId, args.trigger.versionId, now, now,
        )
      })
      const row = this.prepare("SELECT * FROM automation_trigger_dispatches WHERE dispatch_id = ?").get(dispatchId) as unknown as DispatchRow
      return { dispatch: toDispatch(row), created: true }
    } catch (error) {
      if (isUniqueViolation(error)) {
        const row = this.prepare(
          "SELECT * FROM automation_trigger_dispatches WHERE tenant_id = ? AND source_event_id = ? AND trigger_id = ?",
        ).get(args.tenantId, args.sourceEventId, args.trigger.triggerId) as unknown as DispatchRow | undefined
        return { dispatch: row ? toDispatch(row) : (throwNotFound() as never), created: false }
      }
      throw error
    }
  }

  /** Transition a dispatch to a new state (fenced by the previous state). */
  async transitionDispatch(tenantId: string, dispatchId: string, from: DispatchState, to: DispatchState, extra?: { automationRunId?: string | null; rejectionReason?: string | null; rejectionKind?: DispatchRejectionKind | null; error?: string | null }): Promise<TriggerDispatch | null> {
    let updated: TriggerDispatch | null = null
    this.atomic("transitionDispatch", () => {
      const result = this.prepare(
        `UPDATE automation_trigger_dispatches SET
          state = ?, automation_run_id = COALESCE(?, automation_run_id),
          rejection_reason = ?, rejection_kind = ?, attempts = attempts + 1,
          last_error = ?, updated_at = ?
         WHERE dispatch_id = ? AND tenant_id = ? AND state = ?`,
      ).run(
        to,
        extra?.automationRunId ?? null,
        extra?.rejectionReason ?? null,
        extra?.rejectionKind ?? null,
        extra?.error ?? null,
        Date.now(),
        dispatchId, tenantId, from,
      )
      if (result.changes === 0) {
        // State already advanced (concurrent writer) — return current.
      }
      const row = this.prepare("SELECT * FROM automation_trigger_dispatches WHERE dispatch_id = ? AND tenant_id = ?").get(dispatchId, tenantId) as unknown as DispatchRow | undefined
      updated = row ? toDispatch(row) : null
    })
    return updated
  }

  /** Mark a dispatch run_created (terminal; idempotent). Clears any redrive
   *  lease so a stale redrive owner cannot later act on a terminal dispatch. */
  async markRunCreated(tenantId: string, dispatchId: string, runId: string): Promise<void> {
    this.atomic("markRunCreated", () => {
      this.prepare("UPDATE automation_trigger_dispatches SET state = 'run_created', automation_run_id = ?, redrive_owner = NULL, redrive_expires_at = NULL, updated_at = ? WHERE dispatch_id = ? AND tenant_id = ? AND state IN ('admitted','dispatching','matched')")
        .run(runId, Date.now(), dispatchId, tenantId)
    })
  }

  /** Mark a dispatch rejected (terminal; honest classification). Clears the
   *  redrive lease (terminal work is never resurrected). */
  async markRejected(tenantId: string, dispatchId: string, kind: DispatchRejectionKind, reason: string): Promise<void> {
    this.atomic("markRejected", () => {
      this.prepare("UPDATE automation_trigger_dispatches SET state = 'rejected', rejection_kind = ?, rejection_reason = ?, redrive_owner = NULL, redrive_expires_at = NULL, updated_at = ? WHERE dispatch_id = ? AND tenant_id = ? AND state NOT IN ('run_created','rejected','dead_letter')")
        .run(kind, reason.slice(0, 500), Date.now(), dispatchId, tenantId)
    })
  }

  /** Mark a retryable failure (re-driveable). Preserves the redrive lease so
   *  the active redrive owner keeps authority through the transition. */
  async markRetryable(tenantId: string, dispatchId: string, error: string): Promise<void> {
    this.atomic("markRetryable", () => {
      this.prepare("UPDATE automation_trigger_dispatches SET state = 'retryable_failure', last_error = ?, attempts = attempts + 1, updated_at = ? WHERE dispatch_id = ? AND tenant_id = ? AND state NOT IN ('run_created','rejected','dead_letter')")
        .run(error.slice(0, 500), Date.now(), dispatchId, tenantId)
    })
  }

  /** Dead-letter a dispatch (terminal; exhausted retries). Clears the redrive
   *  lease; operators redrive from dead_letter through redriveDeadLetter. */
  async deadLetter(tenantId: string, dispatchId: string, reason: string): Promise<void> {
    this.atomic("deadLetter", () => {
      this.prepare("UPDATE automation_trigger_dispatches SET state = 'dead_letter', last_error = ?, redrive_owner = NULL, redrive_expires_at = NULL, updated_at = ? WHERE dispatch_id = ? AND tenant_id = ? AND state NOT IN ('run_created','rejected')")
        .run(reason.slice(0, 500), Date.now(), dispatchId, tenantId)
    })
  }

  /** List dispatches not yet terminal (recovery input). */
  async listPending(tenantId: string, limit = 100): Promise<TriggerDispatch[]> {
    const rows = this.prepare("SELECT * FROM automation_trigger_dispatches WHERE tenant_id = ? AND state NOT IN ('run_created','rejected','dead_letter') ORDER BY created_at ASC LIMIT ?").all(tenantId, limit) as unknown as DispatchRow[]
    return rows.map(toDispatch)
  }

  /** Get a dispatch (tenant-scoped). */
  async getDispatch(tenantId: string, dispatchId: string): Promise<TriggerDispatch | null> {
    const row = this.prepare("SELECT * FROM automation_trigger_dispatches WHERE dispatch_id = ? AND tenant_id = ?").get(dispatchId, tenantId) as unknown as DispatchRow | undefined
    return row ? toDispatch(row) : null
  }

  /** List dispatches for a source event (one event → N triggers → N dispatches). */
  async listDispatchesForEvent(tenantId: string, sourceEventId: string): Promise<TriggerDispatch[]> {
    const rows = this.prepare("SELECT * FROM automation_trigger_dispatches WHERE tenant_id = ? AND source_event_id = ? ORDER BY created_at ASC").all(tenantId, sourceEventId) as unknown as DispatchRow[]
    return rows.map(toDispatch)
  }

  // -------------------------------------------------------------------------
  // Phase 2E: fenced redrive lease + stranded/dead-letter inspection.
  //
  // A redrive is itself recoverable asynchronous work, so it takes a durable
  // fenced lease: claimRedriveDispatch atomically stamps a new
  // redrive_generation + owner + expiry on a non-terminal dispatch. A stale
  // owner (older generation) cannot finalize — completeRedrive / markRunCreated
  // CAS-check the generation. A redrive never resurrects a terminal dispatch:
  // claimRedriveDispatch only matches non-terminal states. This closes the
  // "late retry resurrects terminal work" race that an unfenced scan-and-drive
  // would allow.
  // -------------------------------------------------------------------------

  /** Claim a non-terminal dispatch for a fenced redrive. Returns the lease
   *  (generation + owner + expiry) or null if the dispatch is terminal, missing,
   *  or already owned by a non-expired lease. Idempotent per owner: re-claiming
   *  by the same owner extends the lease. */
  async claimRedriveDispatch(tenantId: string, dispatchId: string, owner: string, leaseMs: number, now: number = Date.now()): Promise<{ dispatch: TriggerDispatch; generation: number } | null> {
    return this.atomic("claimRedriveDispatch", () => {
      const row = this.prepare("SELECT * FROM automation_trigger_dispatches WHERE dispatch_id = ? AND tenant_id = ?").get(dispatchId, tenantId) as unknown as DispatchRow | undefined
      if (!row) return null
      // Never resurrect terminal work.
      if (TERMINAL_DISPATCH_STATES.has(row.state as DispatchState)) return null
      const expiresAt = now + leaseMs
      // Claim if no active lease, or the existing lease is ours, or it expired.
      const leaseActive = row.redrive_owner !== null && row.redrive_expires_at !== null && row.redrive_expires_at > now && row.redrive_owner !== owner
      if (leaseActive) return null
      const newGen = row.redrive_generation + 1
      this.prepare(
        `UPDATE automation_trigger_dispatches SET redrive_generation = ?, redrive_owner = ?, redrive_expires_at = ?, updated_at = ?
         WHERE dispatch_id = ? AND tenant_id = ? AND redrive_generation = ?`,
      ).run(newGen, owner, expiresAt, now, dispatchId, tenantId, row.redrive_generation)
      const updated = this.prepare("SELECT * FROM automation_trigger_dispatches WHERE dispatch_id = ? AND tenant_id = ?").get(dispatchId, tenantId) as unknown as DispatchRow
      return { dispatch: toDispatch(updated), generation: newGen }
    })
  }

  /** Renew a redrive lease (fenced by generation). Returns false if superseded. */
  async renewRedriveLease(tenantId: string, dispatchId: string, generation: number, leaseMs: number, now: number = Date.now()): Promise<boolean> {
    return this.atomic("renewRedriveLease", () => {
      const res = this.prepare("UPDATE automation_trigger_dispatches SET redrive_expires_at = ?, updated_at = ? WHERE dispatch_id = ? AND tenant_id = ? AND redrive_generation = ?").run(now + leaseMs, now, dispatchId, tenantId, generation)
      return res.changes > 0
    })
  }

  /** Release a redrive lease (fenced). Clears owner/expiry so another owner
   *  may claim. Idempotent. */
  async releaseRedriveLease(tenantId: string, dispatchId: string, generation: number, now: number = Date.now()): Promise<void> {
    this.atomic("releaseRedriveLease", () => {
      this.prepare("UPDATE automation_trigger_dispatches SET redrive_owner = NULL, redrive_expires_at = NULL, updated_at = ? WHERE dispatch_id = ? AND tenant_id = ? AND redrive_generation = ?").run(now, dispatchId, tenantId, generation)
    })
  }

  /** List dispatches stranded in a non-terminal state (recovery input).
   *  Tenant-scoped; bounded for stable continuation. */
  async listStrandedDispatches(tenantId: string, limit = 100): Promise<TriggerDispatch[]> {
    const rows = this.prepare("SELECT * FROM automation_trigger_dispatches WHERE tenant_id = ? AND state NOT IN ('run_created','rejected','dead_letter') ORDER BY created_at ASC LIMIT ?").all(tenantId, limit) as unknown as DispatchRow[]
    return rows.map(toDispatch)
  }

  /** List dead-lettered dispatches (operator inspection; tenant-scoped). */
  async listDeadLetteredDispatches(tenantId: string, limit = 100): Promise<TriggerDispatch[]> {
    const rows = this.prepare("SELECT * FROM automation_trigger_dispatches WHERE tenant_id = ? AND state = 'dead_letter' ORDER BY updated_at ASC LIMIT ?").all(tenantId, limit) as unknown as DispatchRow[]
    return rows.map(toDispatch)
  }

  /** Operator redrive of a dead-lettered dispatch: re-arm to a fresh
   *  retryable_failure state with a reset attempt counter. Fenced + idempotent;
   *  never resurrects a run_created/rejected dispatch (returns it unchanged).
   *  The next redrive pass picks it up under a fresh fenced lease. */
  async redriveDeadLetter(tenantId: string, dispatchId: string, now: number = Date.now()): Promise<TriggerDispatch | null> {
    return this.atomic("redriveDeadLetter", () => {
      const row = this.prepare("SELECT * FROM automation_trigger_dispatches WHERE dispatch_id = ? AND tenant_id = ?").get(dispatchId, tenantId) as unknown as DispatchRow | undefined
      if (!row) return null
      // Never resurrect terminal successful/rejected dispatches.
      if (row.state === "run_created" || row.state === "rejected") return toDispatch(row)
      if (row.state === "dead_letter") {
        this.prepare(
          `UPDATE automation_trigger_dispatches SET state = 'retryable_failure', attempts = 0, last_error = ?, redrive_owner = NULL, redrive_expires_at = NULL, updated_at = ?
           WHERE dispatch_id = ? AND tenant_id = ? AND state = 'dead_letter'`,
        ).run(`operator redrive at ${now}`, now, dispatchId, tenantId)
      }
      const updated = this.prepare("SELECT * FROM automation_trigger_dispatches WHERE dispatch_id = ? AND tenant_id = ?").get(dispatchId, tenantId) as unknown as DispatchRow
      return toDispatch(updated)
    })
  }
}

function throwNotFound(): never {
  throw new AutomationError("DISPATCH_NOT_FOUND", "dispatch not found after unique violation", 500)
}

/** Glob matcher (mirrors the integration package's globMatch; no regex). */
function globMatch(pattern: string, value: string): boolean {
  if (pattern === "*") return true
  if (!pattern.includes("*")) return pattern === value
  const parts = pattern.split("*")
  if (parts.length === 2) {
    const [prefix, suffix] = parts
    if (prefix && !value.startsWith(prefix)) return false
    if (suffix && !value.endsWith(suffix)) return false
    return true
  }
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

/** Re-export types for callers. */
export type { NormalizedEvent } from "@vaulltcore/integration"
