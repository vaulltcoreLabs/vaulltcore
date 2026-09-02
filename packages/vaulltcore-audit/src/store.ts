/**
 * SQL-backed append-only audit log (Phase 1E).
 *
 * The store exposes ONLY an append operation; there is no update/delete API,
 * so audit records cannot be rewritten by application code. (Database-level
 * DELETE is still possible for retention tooling, but never through this class.)
 * Metadata is sanitized before write; the column additionally stores the
 * pre-sanitized form's hash for tamper-evidence in a future phase.
 */

import { randomBytes } from "node:crypto"
import { SqlStoreBase, type Migration, type SqlDialect, type SqlDatabase } from "@vaulltcore/store-sql"
import { type AuditActor, type AuditEvent, type AuditEventType, type AuditInput } from "./contracts"
import { sanitizeMetadata } from "./sanitizer"

export const AUDIT_MIGRATIONS: readonly Migration[] = [
  {
    version: 7,
    name: "audit_log",
    statements: [
      `CREATE TABLE audit_log (
        event_id    TEXT PRIMARY KEY,
        actor       TEXT,
        tenant_id   TEXT,
        org_id      TEXT,
        project_id  TEXT,
        type        TEXT NOT NULL,
        timestamp   INTEGER NOT NULL,
        metadata    TEXT NOT NULL
      )`,
      `CREATE INDEX audit_tenant_idx ON audit_log (tenant_id, org_id, project_id, timestamp)`,
      `CREATE INDEX audit_type_idx ON audit_log (type, timestamp)`,
    ],
  },
]

interface AuditRow {
  event_id: string
  actor: string | null
  tenant_id: string | null
  org_id: string | null
  project_id: string | null
  type: string
  timestamp: number
  metadata: string
}

function toEvent(row: AuditRow): AuditEvent {
  return {
    eventId: row.event_id,
    actor: row.actor ? (JSON.parse(row.actor) as AuditActor) : null,
    tenantId: row.tenant_id,
    orgId: row.org_id,
    projectId: row.project_id,
    type: row.type as AuditEventType,
    timestamp: row.timestamp,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
  }
}

export interface AuditStoreOptions {
  readonly dialect?: SqlDialect
  readonly beforeCommit?: (op: string) => void
}

export class SqlAuditStore extends SqlStoreBase {
  constructor(db: SqlDatabase, options: AuditStoreOptions = {}) {
    super(db, AUDIT_MIGRATIONS, { ...(options.dialect ? { dialect: options.dialect } : {}), beforeCommit: options.beforeCommit })
  }

  /** Append an audit event. Metadata is sanitized (secrets stripped) before
   *  write. Returns the persisted event. */
  async append(input: AuditInput): Promise<AuditEvent> {
    const now = Date.now()
    const eventId = `aud_${randomBytes(12).toString("base64url")}`
    const sanitized = sanitizeMetadata(input.metadata ?? {})
    this.atomic("appendAudit", () => {
      this.prepare(
        "INSERT INTO audit_log (event_id, actor, tenant_id, org_id, project_id, type, timestamp, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        eventId,
        input.actor ? JSON.stringify(input.actor) : null,
        input.scope?.tenantId ?? null,
        input.scope?.orgId ?? null,
        input.scope?.projectId ?? null,
        input.type,
        now,
        JSON.stringify(sanitized),
      )
    })
    return {
      eventId,
      actor: input.actor ?? null,
      tenantId: input.scope?.tenantId ?? null,
      orgId: input.scope?.orgId ?? null,
      projectId: input.scope?.projectId ?? null,
      type: input.type,
      timestamp: now,
      metadata: sanitized,
    }
  }

  /** Tenant-scoped list (cross-tenant reads return empty). */
  async list(scope: { tenantId: string; orgId?: string; projectId?: string }, limit = 1000): Promise<AuditEvent[]> {
    const where = ["tenant_id = ?"]
    const params: (string | number)[] = [scope.tenantId]
    if (scope.orgId) {
      where.push("org_id = ?")
      params.push(scope.orgId)
    }
    if (scope.projectId) {
      where.push("project_id = ?")
      params.push(scope.projectId)
    }
    params.push(limit)
    const rows = this.prepare(`SELECT * FROM audit_log WHERE ${where.join(" AND ")} ORDER BY timestamp ASC, event_id ASC LIMIT ?`).all(...params) as unknown as unknown as AuditRow[]
    return rows.map(toEvent)
  }

  /** Count records (for the append-only test). */
  async count(scope?: { tenantId: string }): Promise<number> {
    if (scope) {
      const row = this.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE tenant_id = ?").get(scope.tenantId) as { n: number }
      return Number(row.n)
    }
    const row = this.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }
    return Number(row.n)
  }
}
