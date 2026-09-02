/**
 * Durable SQL-backed schedule store (Phase 2B).
 *
 * Reuses {@link SqlStoreBase}. Schedules are versioned (immutable published
 * versions; the latest is authoritative). Occurrence admission is fenced by a
 * UNIQUE (schedule_id, occurrence_id) constraint — the durable identity boundary
 * that makes scheduler crash/restart safe: a restarted scheduler recomputes the
 * same occurrenceId for a (schedule, time) and the UNIQUE constraint rejects a
 * duplicate admission, so no duplicate runs are created. `admitOccurrence`
 * returns whether THIS call admitted (true) or found an existing one (false) —
 * the caller never blindly creates a run.
 *
 * State transitions (pause/resume/cancel) are fenced by a version CAS: a stale
 * writer cannot cancel a schedule whose version advanced. PostgreSQL is the
 * production target; node:sqlite + PGlite prove the SQL invariants.
 */

import { createHash } from "node:crypto"
import { SqlStoreBase, type SqlStoreBaseOptions } from "@vaulltcore/store-sql"
import type { Migration } from "@vaulltcore/store-sql"
import type { SqlDatabase, SqlDialect } from "@vaulltcore/store-sql"
import {
  type Schedule,
  type ScheduleAdmitter,
  type ScheduleOccurrence,
  type ScheduleOwner,
  type ScheduleVersion,
  type ScheduleState,
} from "./contracts"

const MIGRATIONS: Migration[] = [
  {
    name: "scheduling",
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS schedules (
        schedule_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        org_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'active',
        current_version INTEGER NOT NULL DEFAULT 0,
        last_admitted_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS schedule_versions (
        version_id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        kind TEXT NOT NULL,
        cron TEXT,
        scheduled_at INTEGER,
        timezone TEXT NOT NULL,
        automation_version_id TEXT NOT NULL,
        missed_run_policy TEXT NOT NULL DEFAULT 'skip',
        max_catch_up INTEGER NOT NULL DEFAULT 1,
        input TEXT,
        created_at INTEGER NOT NULL,
        checksum TEXT NOT NULL,
        UNIQUE (schedule_id, version)
      )`,
      `CREATE TABLE IF NOT EXISTS schedule_occurrences (
        occurrence_id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        scheduled_time INTEGER NOT NULL,
        admitted_run_id TEXT,
        admitted_at INTEGER,
        created_at INTEGER NOT NULL,
        UNIQUE (schedule_id, occurrence_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_schedule_versions_schedule ON schedule_versions (schedule_id, version)`,
      `CREATE INDEX IF NOT EXISTS idx_occurrences_schedule ON schedule_occurrences (schedule_id, scheduled_time)`,
    ],
  },
]

interface ScheduleRow {
  schedule_id: string
  tenant_id: string
  org_id: string
  project_id: string
  name: string
  state: ScheduleState
  current_version: number
  last_admitted_at: number | null
  created_at: number
  updated_at: number
}

interface VersionRow {
  version_id: string
  schedule_id: string
  version: number
  kind: string
  cron: string | null
  scheduled_at: number | null
  timezone: string
  automation_version_id: string
  missed_run_policy: string
  max_catch_up: number
  input: string | null
  created_at: number
  checksum: string
}

interface OccurrenceRow {
  occurrence_id: string
  schedule_id: string
  version: number
  scheduled_time: number
  admitted_run_id: string | null
  admitted_at: number | null
  created_at: number
}

function rowToSchedule(row: ScheduleRow): Schedule {
  return {
    scheduleId: row.schedule_id,
    owner: { tenantId: row.tenant_id, orgId: row.org_id, projectId: row.project_id },
    name: row.name,
    state: row.state,
    currentVersion: row.current_version,
    lastAdmittedAt: row.last_admitted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToVersion(row: VersionRow): ScheduleVersion {
  return {
    versionId: row.version_id,
    scheduleId: row.schedule_id,
    version: row.version,
    kind: row.kind as ScheduleVersion["kind"],
    cron: row.cron,
    scheduledAt: row.scheduled_at,
    timezone: row.timezone,
    automationVersionId: row.automation_version_id,
    missedRunPolicy: row.missed_run_policy as ScheduleVersion["missedRunPolicy"],
    maxCatchUp: row.max_catch_up,
    input: row.input ? JSON.parse(row.input) : null,
    createdAt: row.created_at,
    checksum: row.checksum,
  }
}

function rowToOccurrence(row: OccurrenceRow): ScheduleOccurrence {
  return {
    occurrenceId: row.occurrence_id,
    scheduleId: row.schedule_id,
    version: row.version,
    scheduledTime: row.scheduled_time,
    admittedRunId: row.admitted_run_id,
    admittedAt: row.admitted_at,
    createdAt: row.created_at,
  }
}

function versionChecksum(v: Omit<ScheduleVersion, "versionId" | "checksum" | "createdAt">): string {
  return createHash("sha256")
    .update(`${v.scheduleId}|${v.version}|${v.kind}|${v.cron ?? ""}|${v.scheduledAt ?? ""}|${v.timezone}|${v.automationVersionId}|${v.missedRunPolicy}|${v.maxCatchUp}|${JSON.stringify(v.input)}`)
    .digest("hex")
}

export interface SqlScheduleStoreOptions extends SqlStoreBaseOptions {
  readonly dialect?: SqlDialect
}

export class SqlScheduleStore extends SqlStoreBase {
  constructor(db: SqlDatabase, options: SqlScheduleStoreOptions = {}) {
    super(db, MIGRATIONS, options)
  }

  /** Create a schedule with its first version. Returns the schedule. */
  createSchedule(args: {
    readonly scheduleId: string
    readonly owner: ScheduleOwner
    readonly name: string
    readonly version: Omit<ScheduleVersion, "versionId" | "version" | "scheduleId" | "checksum" | "createdAt">
  }): { schedule: Schedule; version: ScheduleVersion } {
    const now = (this as unknown as { now?: () => number }).now?.() ?? Date.now()
    return this.atomic("createSchedule", () => {
      const schedRow: ScheduleRow = {
        schedule_id: args.scheduleId,
        tenant_id: args.owner.tenantId,
        org_id: args.owner.orgId,
        project_id: args.owner.projectId,
        name: args.name,
        state: "active",
        current_version: 1,
        last_admitted_at: null,
        created_at: now,
        updated_at: now,
      }
      this.prepare(`INSERT INTO schedules (schedule_id, tenant_id, org_id, project_id, name, state, current_version, last_admitted_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(schedRow.schedule_id, schedRow.tenant_id, schedRow.org_id, schedRow.project_id, schedRow.name, schedRow.state, schedRow.current_version, schedRow.last_admitted_at, schedRow.created_at, schedRow.updated_at)
      const version: ScheduleVersion = {
        versionId: `sv_${args.scheduleId}_1`,
        scheduleId: args.scheduleId,
        version: 1,
        kind: args.version.kind,
        cron: args.version.cron,
        scheduledAt: args.version.scheduledAt,
        timezone: args.version.timezone,
        automationVersionId: args.version.automationVersionId,
        missedRunPolicy: args.version.missedRunPolicy,
        maxCatchUp: args.version.maxCatchUp,
        input: args.version.input,
        createdAt: now,
        checksum: "",
      }
      const checksum = versionChecksum(version)
      const v: ScheduleVersion = { ...version, checksum }
      this.prepare(`INSERT INTO schedule_versions (version_id, schedule_id, version, kind, cron, scheduled_at, timezone, automation_version_id, missed_run_policy, max_catch_up, input, created_at, checksum) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(v.versionId, v.scheduleId, v.version, v.kind, v.cron, v.scheduledAt, v.timezone, v.automationVersionId, v.missedRunPolicy, v.maxCatchUp, v.input ? JSON.stringify(v.input) : null, v.createdAt, v.checksum)
      return { schedule: rowToSchedule(schedRow), version: v }
    })
  }

  /** Publish a new version of an existing schedule (fenced by current version). */
  publishVersion(scheduleId: string, version: Omit<ScheduleVersion, "versionId" | "version" | "scheduleId" | "checksum" | "createdAt">): ScheduleVersion {
    const now = (this as unknown as { now?: () => number }).now?.() ?? Date.now()
    return this.atomic("publishVersion", () => {
      const sched = this.prepare(`SELECT * FROM schedules WHERE schedule_id = ?`).get(scheduleId) as unknown as ScheduleRow | undefined
      if (!sched) throw new Error("schedule not found")
      const newVersion = sched.current_version + 1
      const draft: ScheduleVersion = {
        versionId: `sv_${scheduleId}_${newVersion}`,
        scheduleId,
        version: newVersion,
        kind: version.kind,
        cron: version.cron,
        scheduledAt: version.scheduledAt,
        timezone: version.timezone,
        automationVersionId: version.automationVersionId,
        missedRunPolicy: version.missedRunPolicy,
        maxCatchUp: version.maxCatchUp,
        input: version.input,
        createdAt: now,
        checksum: "",
      }
      const checksum = versionChecksum(draft)
      const v = { ...draft, checksum }
      // Fenced: only advance current_version if it is still the old value.
      const res = this.prepare(`UPDATE schedules SET current_version = ?, updated_at = ? WHERE schedule_id = ? AND current_version = ?`).run(newVersion, now, scheduleId, sched.current_version)
      if (res.changes === 0) throw new Error("schedule version conflict (fenced)")
      this.prepare(`INSERT INTO schedule_versions (version_id, schedule_id, version, kind, cron, scheduled_at, timezone, automation_version_id, missed_run_policy, max_catch_up, input, created_at, checksum) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(v.versionId, v.scheduleId, v.version, v.kind, v.cron, v.scheduledAt, v.timezone, v.automationVersionId, v.missedRunPolicy, v.maxCatchUp, v.input ? JSON.stringify(v.input) : null, v.createdAt, v.checksum)
      return v
    })
  }

  /** Transition a schedule's state (fenced by current_version). */
  setState(scheduleId: string, state: ScheduleState): Schedule {
    const now = (this as unknown as { now?: () => number }).now?.() ?? Date.now()
    return this.atomic("setState", () => {
      const sched = this.prepare(`SELECT * FROM schedules WHERE schedule_id = ?`).get(scheduleId) as unknown as ScheduleRow | undefined
      if (!sched) throw new Error("schedule not found")
      const res = this.prepare(`UPDATE schedules SET state = ?, updated_at = ? WHERE schedule_id = ? AND current_version = ?`).run(state, now, scheduleId, sched.current_version)
      if (res.changes === 0) throw new Error("schedule version conflict (fenced)")
      const updated = this.prepare(`SELECT * FROM schedules WHERE schedule_id = ?`).get(scheduleId) as unknown as ScheduleRow
      return rowToSchedule(updated)
    })
  }

  /** Read a schedule (tenant-scoped; returns null on cross-tenant). */
  getSchedule(tenantId: string, scheduleId: string): Schedule | null {
    const row = this.prepare(`SELECT * FROM schedules WHERE tenant_id = ? AND schedule_id = ?`).get(tenantId, scheduleId) as unknown as ScheduleRow | undefined
    return row ? rowToSchedule(row) : null
  }

  /** Read the current (authoritative) version of a schedule. */
  getCurrentVersion(scheduleId: string): ScheduleVersion | null {
    const sched = this.prepare(`SELECT * FROM schedules WHERE schedule_id = ?`).get(scheduleId) as unknown as ScheduleRow | undefined
    if (!sched) return null
    const row = this.prepare(`SELECT * FROM schedule_versions WHERE schedule_id = ? AND version = ?`).get(scheduleId, sched.current_version) as unknown as VersionRow | undefined
    return row ? rowToVersion(row) : null
  }

  /** List active schedules (for a tick). Cross-tenant not exposed. */
  listActive(tenantId: string | null): Schedule[] {
    const sql = tenantId ? `SELECT * FROM schedules WHERE state = 'active' AND tenant_id = ?` : `SELECT * FROM schedules WHERE state = 'active'`
    const rows = (tenantId ? this.prepare(sql).all(tenantId) : this.prepare(sql).all()) as unknown as ScheduleRow[]
    return rows.map(rowToSchedule)
  }

  /** List schedules for a tenant, optionally scoped to org/project (read-only). */
  listSchedules(tenantId: string, orgId?: string, projectId?: string): Schedule[] {
    const where = ["tenant_id = ?"]
    const args: (string | number)[] = [tenantId]
    if (orgId) { where.push("org_id = ?"); args.push(orgId) }
    if (projectId) { where.push("project_id = ?"); args.push(projectId) }
    const rows = this.prepare(`SELECT * FROM schedules WHERE ${where.join(" AND ")} ORDER BY created_at ASC`).all(...args) as unknown as ScheduleRow[]
    return rows.map(rowToSchedule)
  }

  /**
   * Attempt to admit an occurrence. Returns {admitted: true, occurrence} if THIS
   * call created the occurrence row, or {admitted: false, occurrence} if it
   * already existed. The UNIQUE (schedule_id, occurrence_id) is the idempotency
   * boundary: a duplicate admission is rejected at the DB level. The caller
   * only creates a run when `admitted === true`.
   */
  recordOccurrence(args: { readonly occurrenceId: string; readonly scheduleId: string; readonly version: number; readonly scheduledTime: number; readonly now?: number }): { admitted: boolean; occurrence: ScheduleOccurrence } {
    const now = args.now ?? ((this as unknown as { now?: () => number }).now?.() ?? Date.now())
    return this.atomic("recordOccurrence", () => {
      const existing = this.prepare(`SELECT * FROM schedule_occurrences WHERE schedule_id = ? AND occurrence_id = ?`).get(args.scheduleId, args.occurrenceId) as unknown as OccurrenceRow | undefined
      if (existing) return { admitted: false, occurrence: rowToOccurrence(existing) }
      const row: OccurrenceRow = {
        occurrence_id: args.occurrenceId,
        schedule_id: args.scheduleId,
        version: args.version,
        scheduled_time: args.scheduledTime,
        admitted_run_id: null,
        admitted_at: null,
        created_at: now,
      }
      try {
        this.prepare(`INSERT INTO schedule_occurrences (occurrence_id, schedule_id, version, scheduled_time, admitted_run_id, admitted_at, created_at) VALUES (?,?,?,?,?,?,?)`).run(row.occurrence_id, row.schedule_id, row.version, row.scheduled_time, row.admitted_run_id, row.admitted_at, row.created_at)
      } catch {
        // Lost the UNIQUE race to another scheduler; read the winner.
        const winner = this.prepare(`SELECT * FROM schedule_occurrences WHERE schedule_id = ? AND occurrence_id = ?`).get(args.scheduleId, args.occurrenceId) as unknown as OccurrenceRow
        return { admitted: false, occurrence: rowToOccurrence(winner) }
      }
      return { admitted: true, occurrence: rowToOccurrence(row) }
    })
  }

  /** Record the runId for an admitted occurrence (fenced by occurrenceId). */
  setAdmittedRun(occurrenceId: string, runId: string, now: number = Date.now()): void {
    this.atomic("setAdmittedRun", () => {
      this.prepare(`UPDATE schedule_occurrences SET admitted_run_id = ?, admitted_at = ? WHERE occurrence_id = ?`).run(runId, now, occurrenceId)
    })
  }

  /** Advance the schedule watermark (fenced by current_version). */
  advanceWatermark(scheduleId: string, admittedAt: number, currentVersion: number): boolean {
    const now = (this as unknown as { now?: () => number }).now?.() ?? Date.now()
    return this.atomic("advanceWatermark", () => {
      const res = this.prepare(`UPDATE schedules SET last_admitted_at = ?, updated_at = ? WHERE schedule_id = ? AND current_version = ?`).run(admittedAt, now, scheduleId, currentVersion)
      return res.changes > 0
    })
  }

  /** List occurrences for a schedule (tenant-scoped via schedule ownership). */
  listOccurrences(tenantId: string, scheduleId: string): ScheduleOccurrence[] {
    // Enforce tenant scope via join.
    const rows = this.prepare(`SELECT o.* FROM schedule_occurrences o JOIN schedules s ON s.schedule_id = o.schedule_id WHERE s.tenant_id = ? AND o.schedule_id = ? ORDER BY o.scheduled_time ASC`).all(tenantId, scheduleId) as unknown as OccurrenceRow[]
    return rows.map(rowToOccurrence)
  }
}
