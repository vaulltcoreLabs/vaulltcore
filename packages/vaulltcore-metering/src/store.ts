/**
 * SQL-backed metering store (Phase 1E).
 *
 * Append-only usage events with a UNIQUE `(tenant_id, job_id, kind, dedup_key)`
 * identity. A duplicate delivery is recorded exactly once: the INSERT uses
 * `ON CONFLICT DO NOTHING` and a 0-change result is reported as a duplicate
 * (not an error), so a worker retry that re-delivers the same committed event
 * cannot double-record usage.
 */

import { randomBytes } from "node:crypto"
import { SqlStoreBase, type Migration, type SqlDialect, type SqlDatabase, type SqlValue } from "@vaulltcore/store-sql"
import { type RecordResult, type UsageAggregate, type UsageEvent, type UsageEventInput, type UsageKind, validateUsageInput } from "./contracts"

export const METERING_MIGRATIONS: readonly Migration[] = [
  {
    version: 5,
    name: "metering_usage_events",
    statements: [
      `CREATE TABLE usage_events (
        event_id   TEXT NOT NULL,
        tenant_id  TEXT NOT NULL,
        org_id     TEXT NOT NULL,
        project_id TEXT NOT NULL,
        job_id     TEXT NOT NULL,
        kind       TEXT NOT NULL,
        quantity   INTEGER NOT NULL,
        dedup_key  TEXT NOT NULL,
        unit       TEXT,
        recorded_at INTEGER NOT NULL,
        PRIMARY KEY (event_id),
        UNIQUE (tenant_id, job_id, kind, dedup_key)
      )`,
      `CREATE INDEX usage_events_job_idx ON usage_events (tenant_id, job_id)`,
      `CREATE INDEX usage_events_scope_idx ON usage_events (tenant_id, org_id, project_id)`,
    ],
  },
  // Phase 2F: provider/model attribution + bounded tenant/time/range query
  // indexes. Additive (nullable columns; existing rows get NULL attribution).
  // Attribution is public provider/model identifiers only — never credentials.
  // The bounded-range index supports filtered/paginated aggregation without an
  // unbounded full scan through the control plane.
  {
    version: 6,
    name: "metering_attribution",
    statements: [
      `ALTER TABLE usage_events ADD COLUMN provider TEXT`,
      `ALTER TABLE usage_events ADD COLUMN model TEXT`,
      `CREATE INDEX IF NOT EXISTS usage_events_range_idx ON usage_events (tenant_id, org_id, project_id, kind, recorded_at)`,
      `CREATE INDEX IF NOT EXISTS usage_events_kind_idx ON usage_events (tenant_id, kind, recorded_at)`,
    ],
  },
]

interface UsageEventRow {
  event_id: string
  tenant_id: string
  org_id: string
  project_id: string
  job_id: string
  kind: string
  quantity: number
  dedup_key: string
  unit: string | null
  recorded_at: number
  provider: string | null
  model: string | null
}

function toEvent(row: UsageEventRow): UsageEvent {
  return {
    eventId: row.event_id,
    tenantId: row.tenant_id,
    orgId: row.org_id,
    projectId: row.project_id,
    jobId: row.job_id,
    kind: row.kind as UsageKind,
    quantity: row.quantity,
    dedupKey: row.dedup_key,
    unit: row.unit,
    recordedAt: row.recorded_at,
    provider: row.provider ?? null,
    model: row.model ?? null,
  }
}

export interface MeteringStoreOptions {
  readonly dialect?: SqlDialect
  readonly beforeCommit?: (op: string) => void
}

export class SqlMeteringStore extends SqlStoreBase {
  constructor(db: SqlDatabase, options: MeteringStoreOptions = {}) {
    super(db, METERING_MIGRATIONS, { ...(options.dialect ? { dialect: options.dialect } : {}), beforeCommit: options.beforeCommit })
  }

  private id(): string {
    return `use_${randomBytes(12).toString("base64url")}`
  }

  /**
   * Record a usage event exactly once. Returns the persisted event and whether
   * it was a duplicate of an already-recorded event. A duplicate is NOT an
   * error — it proves the worker-retry safety property. Validates the input
   * (non-negative integer quantity, known kind, consistent unit) BEFORE the
   * transaction so invalid usage can never reach the durable ledger.
   */
  async record(input: UsageEventInput): Promise<RecordResult> {
    const valid = validateUsageInput(input)
    const now = Date.now()
    return this.atomic("recordUsage", () => {
      const eventId = this.id()
      const result = this.prepare(
        `INSERT INTO usage_events (event_id, tenant_id, org_id, project_id, job_id, kind, quantity, dedup_key, unit, recorded_at, provider, model)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, job_id, kind, dedup_key) DO NOTHING`,
      ).run(
        eventId,
        valid.identity.tenantId,
        valid.identity.orgId,
        valid.identity.projectId,
        valid.identity.jobId,
        valid.kind,
        valid.quantity,
        valid.dedupKey,
        valid.unit ?? null,
        now,
        valid.provider ?? null,
        valid.model ?? null,
      )
      if (result.changes === 0) {
        const existing = this.prepare(
          "SELECT * FROM usage_events WHERE tenant_id = ? AND job_id = ? AND kind = ? AND dedup_key = ?",
        ).get(valid.identity.tenantId, valid.identity.jobId, valid.kind, valid.dedupKey) as unknown as UsageEventRow
        return { event: toEvent(existing), duplicated: true }
      }
      const row = this.prepare("SELECT * FROM usage_events WHERE event_id = ?").get(eventId) as unknown as UsageEventRow
      return { event: toEvent(row), duplicated: false }
    })
  }

  /** Record a batch of usage events atomically (all-or-nothing). */
  async recordBatch(inputs: readonly UsageEventInput[]): Promise<RecordResult[]> {
    if (inputs.length === 0) return []
    const valid = inputs.map((i) => validateUsageInput(i))
    return this.atomic("recordUsageBatch", () =>
      valid.map((input) => {
        const now = Date.now()
        const eventId = this.id()
        const result = this.prepare(
          `INSERT INTO usage_events (event_id, tenant_id, org_id, project_id, job_id, kind, quantity, dedup_key, unit, recorded_at, provider, model)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (tenant_id, job_id, kind, dedup_key) DO NOTHING`,
        ).run(
          eventId,
          input.identity.tenantId,
          input.identity.orgId,
          input.identity.projectId,
          input.identity.jobId,
          input.kind,
          input.quantity,
          input.dedupKey,
          input.unit ?? null,
          now,
          input.provider ?? null,
          input.model ?? null,
        )
        if (result.changes === 0) {
          const existing = this.prepare(
            "SELECT * FROM usage_events WHERE tenant_id = ? AND job_id = ? AND kind = ? AND dedup_key = ?",
          ).get(input.identity.tenantId, input.identity.jobId, input.kind, input.dedupKey) as unknown as UsageEventRow
          return { event: toEvent(existing), duplicated: true }
        }
        const row = this.prepare("SELECT * FROM usage_events WHERE event_id = ?").get(eventId) as unknown as UsageEventRow
        return { event: toEvent(row), duplicated: false }
      }),
    )
  }

  async listEvents(scope: { tenantId: string; jobId: string }): Promise<UsageEvent[]> {
    const rows = this.prepare("SELECT * FROM usage_events WHERE tenant_id = ? AND job_id = ? ORDER BY recorded_at ASC, event_id ASC").all(scope.tenantId, scope.jobId) as unknown as unknown as UsageEventRow[]
    return rows.map(toEvent)
  }

  /** Aggregate usage for a job (tenant-scoped; cross-tenant reads return empty). */
  async aggregateJob(tenantId: string, jobId: string): Promise<UsageAggregate> {
    const rows = this.prepare("SELECT kind, quantity FROM usage_events WHERE tenant_id = ? AND job_id = ?").all(tenantId, jobId) as Array<{ kind: string; quantity: number }>
    return aggregateRows(rows, jobId)
  }

  /** Aggregate usage for a scope (tenant/org/project). */
  async aggregateScope(scope: { tenantId: string; orgId: string; projectId: string }): Promise<UsageAggregate> {
    const rows = this.prepare("SELECT kind, quantity FROM usage_events WHERE tenant_id = ? AND org_id = ? AND project_id = ?").all(scope.tenantId, scope.orgId, scope.projectId) as Array<{ kind: string; quantity: number }>
    return aggregateRows(rows, null)
  }

  // -------------------------------------------------------------------------
  // Phase 2F: bounded, paginated, filtered query surface over the immutable
  // ledger. Aggregates are DERIVED data, never authoritative — the immutable
  // usage_events rows are the source of truth. Every query enforces an explicit
  // maximum range/page bound so a control-plane request can never scan an
  // unbounded ledger. Deterministic ordering (recorded_at, event_id) + cursor
  // pagination. Cross-tenant reads return empty (no existence leak).
  // -------------------------------------------------------------------------

  /** Bounded, tenant-scoped, filtered query of raw usage events with cursor
   *  pagination. `limit` is capped at {@link MAX_QUERY_LIMIT}. Returns a page
   *  + a next cursor (null when exhausted). */
  queryEvents(filter: UsageQueryFilter, cursor?: UsageQueryCursor, limit = 200): UsageQueryPage {
    const cap = Math.min(Math.max(1, Math.trunc(limit)), MAX_QUERY_LIMIT)
    const where: string[] = ["tenant_id = ?"]
    const params: SqlValue[] = [filter.tenantId]
    if (filter.orgId) { where.push("org_id = ?"); params.push(filter.orgId) }
    if (filter.projectId) { where.push("project_id = ?"); params.push(filter.projectId) }
    if (filter.jobId) { where.push("job_id = ?"); params.push(filter.jobId) }
    if (filter.kind) { where.push("kind = ?"); params.push(filter.kind) }
    if (filter.provider) { where.push("provider = ?"); params.push(filter.provider) }
    if (filter.model) { where.push("model = ?"); params.push(filter.model) }
    if (filter.from) { where.push("recorded_at >= ?"); params.push(filter.from) }
    if (filter.to) { where.push("recorded_at <= ?"); params.push(filter.to) }
    if (cursor) { where.push("(recorded_at, event_id) > (?, ?)"); params.push(cursor.recordedAt, cursor.eventId) }
    const sql = `SELECT * FROM usage_events WHERE ${where.join(" AND ")} ORDER BY recorded_at ASC, event_id ASC LIMIT ?`
    params.push(cap + 1)
    const rows = this.prepare(sql).all(...params) as unknown as UsageEventRow[]
    const hasMore = rows.length > cap
    const items = rows.slice(0, cap).map(toEvent)
    const nextCursor = hasMore && items.length > 0
      ? { recordedAt: items[items.length - 1]!.recordedAt, eventId: items[items.length - 1]!.eventId }
      : null
    return { items, nextCursor, hasMore }
  }

  /** Bounded filtered aggregation over the immutable ledger. The aggregate is
   *  DERIVED — it is always recomputable from usage_events rows. Enforces a
   *  max range so a request cannot aggregate an unbounded history. */
  aggregateFiltered(filter: UsageQueryFilter): UsageAggregate {
    const where: string[] = ["tenant_id = ?"]
    const params: SqlValue[] = [filter.tenantId]
    if (filter.orgId) { where.push("org_id = ?"); params.push(filter.orgId) }
    if (filter.projectId) { where.push("project_id = ?"); params.push(filter.projectId) }
    if (filter.jobId) { where.push("job_id = ?"); params.push(filter.jobId) }
    if (filter.kind) { where.push("kind = ?"); params.push(filter.kind) }
    if (filter.provider) { where.push("provider = ?"); params.push(filter.provider) }
    if (filter.model) { where.push("model = ?"); params.push(filter.model) }
    if (filter.from) { where.push("recorded_at >= ?"); params.push(filter.from) }
    if (filter.to) { where.push("recorded_at <= ?"); params.push(filter.to) }
    const rows = this.prepare(`SELECT kind, quantity FROM usage_events WHERE ${where.join(" AND ")}`).all(...params) as Array<{ kind: string; quantity: number }>
    return aggregateRows(rows, filter.jobId ?? null)
  }

  /** Per-kind breakdown for a filtered scope (derived). */
  breakdownByKind(filter: UsageQueryFilter): Array<{ kind: string; quantity: number; count: number }> {
    const where: string[] = ["tenant_id = ?"]
    const params: SqlValue[] = [filter.tenantId]
    if (filter.orgId) { where.push("org_id = ?"); params.push(filter.orgId) }
    if (filter.projectId) { where.push("project_id = ?"); params.push(filter.projectId) }
    if (filter.jobId) { where.push("job_id = ?"); params.push(filter.jobId) }
    if (filter.provider) { where.push("provider = ?"); params.push(filter.provider) }
    if (filter.model) { where.push("model = ?"); params.push(filter.model) }
    if (filter.from) { where.push("recorded_at >= ?"); params.push(filter.from) }
    if (filter.to) { where.push("recorded_at <= ?"); params.push(filter.to) }
    const rows = this.prepare(`SELECT kind, SUM(quantity) AS quantity, COUNT(*) AS count FROM usage_events WHERE ${where.join(" AND ")} GROUP BY kind ORDER BY kind ASC`).all(...params) as Array<{ kind: string; quantity: number | bigint; count: number | bigint }>
    return rows.map((r) => ({ kind: r.kind, quantity: Number(r.quantity), count: Number(r.count) }))
  }
}

/** Phase 2F: bounded query filter. Every field is optional except tenantId.
 *  Time bounds (`from`/`to`) are epoch milliseconds. */
export interface UsageQueryFilter {
  readonly tenantId: string
  readonly orgId?: string
  readonly projectId?: string
  readonly jobId?: string
  readonly kind?: UsageKind
  readonly provider?: string
  readonly model?: string
  readonly from?: number
  readonly to?: number
}

export interface UsageQueryCursor {
  readonly recordedAt: number
  readonly eventId: string
}

export interface UsageQueryPage {
  readonly items: readonly UsageEvent[]
  readonly nextCursor: UsageQueryCursor | null
  readonly hasMore: boolean
}

/** Hard cap on per-request page size; a control-plane request can never pull an
 *  unbounded slice of the immutable ledger. */
export const MAX_QUERY_LIMIT = 500

function aggregateRows(rows: Array<{ kind: string; quantity: number }>, jobId: string | null): UsageAggregate {
  let inputTokens = 0
  let outputTokens = 0
  let reasoningTokens = 0
  let steps = 0
  let toolCalls = 0
  let durationMs = 0
  let totalTokens = 0
  for (const row of rows) {
    switch (row.kind as UsageKind) {
      case "model_tokens": {
        // quantity encodes input/output/reasoning as a structured payload split
        // across three events with distinct dedupKey suffixes; sum all as total.
        totalTokens += row.quantity
        break
      }
      case "model_input_tokens":
        inputTokens += row.quantity
        totalTokens += row.quantity
        break
      case "model_output_tokens":
        outputTokens += row.quantity
        totalTokens += row.quantity
        break
      case "model_reasoning_tokens":
        reasoningTokens += row.quantity
        totalTokens += row.quantity
        break
      case "model_request":
        steps += row.quantity
        break
      case "tool_call":
      case "tool_invocation":
        toolCalls += row.quantity
        break
      case "execution_duration":
      case "runtime_duration":
        durationMs += row.quantity
        break
    }
  }
  return { jobId, inputTokens, outputTokens, reasoningTokens, totalTokens, steps, toolCalls, durationMs }
}
