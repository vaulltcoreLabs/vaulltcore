/**
 * Versioned schema migrations for the SQL job store.
 *
 * Applied in order inside a single transaction per migration; each applied
 * version is recorded in `schema_migrations`. Statements are written in a
 * portable subset of SQL (FFI-safe for the SQLite reference driver; Postgres
 * needs only type tweaks — TEXT/INTEGER carry over).
 *
 * Invariants enforced by the schema itself:
 * - `job_events` PRIMARY KEY (job_id, seq): duplicate delivery is
 *   deterministically rejected by the database, never silently absorbed.
 * - `job_leases` PRIMARY KEY (job_id): at most one live lease row per job —
 *   exactly one authoritative active owner.
 * - `job_checkpoints` PRIMARY KEY (job_id): exactly one authoritative
 *   checkpoint per job; the watermark inside it defines committed history.
 * - Ownership generation (`jobs.attempt`) is a plain column; the store only
 *   ever increments it inside the lease-acquisition transaction, with the
 *   conditional-UPDATE CAS as a second layer under contention.
 */

import type { SqlDatabase } from "./driver"

export interface Migration {
  readonly version: number
  readonly name: string
  readonly statements: readonly string[]
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "core_job_tables",
    statements: [
      `CREATE TABLE jobs (
        job_id           TEXT PRIMARY KEY,
        tenant_id        TEXT NOT NULL,
        org_id           TEXT NOT NULL,
        project_id       TEXT NOT NULL,
        status           TEXT NOT NULL,
        attempt          INTEGER NOT NULL,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        error            TEXT,
        spec             TEXT NOT NULL,
        env              TEXT NOT NULL,
        policy           TEXT NOT NULL,
        latest_snapshot  TEXT,
        last_seq         BIGINT NOT NULL DEFAULT 0,
        created_at       BIGINT NOT NULL,
        updated_at       BIGINT NOT NULL
      )`,
      `CREATE INDEX jobs_tenant_idx ON jobs (tenant_id, org_id, project_id)`,
      `CREATE TABLE job_leases (
        job_id      TEXT PRIMARY KEY REFERENCES jobs (job_id) ON DELETE CASCADE,
        token       TEXT NOT NULL,
        generation  INTEGER NOT NULL,
        expires_at  BIGINT NOT NULL,
        acquired_at BIGINT NOT NULL
      )`,
      `CREATE TABLE job_events (
        job_id    TEXT NOT NULL REFERENCES jobs (job_id) ON DELETE CASCADE,
        seq       BIGINT NOT NULL,
        timestamp BIGINT NOT NULL,
        type      TEXT NOT NULL,
        data      TEXT NOT NULL,
        PRIMARY KEY (job_id, seq)
      )`,
      `CREATE TABLE job_checkpoints (
        job_id         TEXT PRIMARY KEY REFERENCES jobs (job_id) ON DELETE CASCADE,
        checkpoint     TEXT NOT NULL,
        last_event_seq BIGINT NOT NULL,
        attempt        INTEGER NOT NULL,
        updated_at     BIGINT NOT NULL
      )`,
      `CREATE TABLE job_snapshots (
        job_id      TEXT NOT NULL REFERENCES jobs (job_id) ON DELETE CASCADE,
        snapshot_id TEXT NOT NULL,
        snapshot    TEXT NOT NULL,
        created_at  BIGINT NOT NULL,
        PRIMARY KEY (job_id, snapshot_id)
      )`,
    ],
  },
  {
    version: 2,
    name: "distributed_control_plane",
    statements: [
      // Durable idempotency for POST /jobs. UNIQUE(tenant_id, idempotency_key)
      // is the linearization point: concurrent create attempts serialize here.
      // Different tenants may use identical keys without collision.
      `CREATE TABLE idempotency_records (
        tenant_id       TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash    TEXT NOT NULL,
        job_id          TEXT,
        response_status INTEGER,
        response_body   TEXT,
        created_at      BIGINT NOT NULL,
        expires_at      BIGINT,
        PRIMARY KEY (tenant_id, idempotency_key)
      )`,
      `CREATE INDEX idempotency_job_idx ON idempotency_records (job_id)`,
      // Worker registry + heartbeats (supervisor/reconciler input).
      `CREATE TABLE workers (
        worker_id     TEXT PRIMARY KEY,
        boot_token    TEXT NOT NULL,
        label         TEXT,
        status        TEXT NOT NULL DEFAULT 'active',
        last_seen_at  BIGINT NOT NULL,
        created_at    BIGINT NOT NULL
      )`,
      `CREATE TABLE worker_heartbeats (
        worker_id    TEXT NOT NULL,
        at           BIGINT NOT NULL,
        active_jobs   TEXT NOT NULL,
        PRIMARY KEY (worker_id, at)
      )`,
      // Dispatch claims: at most one outstanding claim per job (PRIMARY KEY on
      // job_id). The claim carries the fenced generation/token the worker must
      // present on every mutation.
      `CREATE TABLE dispatch_claims (
        job_id      TEXT PRIMARY KEY REFERENCES jobs (job_id) ON DELETE CASCADE,
        worker_id   TEXT NOT NULL,
        boot_token  TEXT NOT NULL,
        generation  INTEGER NOT NULL,
        token       TEXT NOT NULL,
        expires_at  BIGINT NOT NULL,
        claimed_at  BIGINT NOT NULL,
        acknowledged INTEGER NOT NULL DEFAULT 0
      )`,
      // Snapshot lifecycle registry. A snapshot is an optimization; the
      // checkpoint + event log stay authoritative. GC never deletes the last
      // valid recovery artifact before its replacement is durably committed.
      `CREATE TABLE snapshot_lifecycle (
        snapshot_id    TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL,
        job_id          TEXT NOT NULL REFERENCES jobs (job_id) ON DELETE CASCADE,
        provider        TEXT NOT NULL,
        size_bytes      BIGINT,
        integrity_hash  TEXT NOT NULL,
        attempt         INTEGER NOT NULL,
        state           TEXT NOT NULL,
        superseded_by   TEXT,
        created_at      BIGINT NOT NULL,
        expires_at      BIGINT,
        updated_at      BIGINT NOT NULL
      )`,
      `CREATE INDEX snapshot_lifecycle_job_idx ON snapshot_lifecycle (job_id, state)`,
    ],
  },
  {
    // Phase 1F: durable distributed admission idempotency. The claim/complete/
    // fail state machine serializes concurrent admissions of the same
    // (tenant, key) across separate control-plane processes. UNIQUE(tenant_id,
    // idempotency_key) is the linearization point; the request fingerprint
    // distinguishes a legitimate replay from a conflicting key reuse. Only the
    // SHA-256 fingerprint is stored — never secret request material.
    version: 8,
    name: "admission_idempotency",
    statements: [
      `CREATE TABLE admission_idempotency (
        tenant_id       TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        fingerprint     TEXT NOT NULL,
        state           TEXT NOT NULL,
        job_id          TEXT,
        reservation_id  TEXT,
        failure_code    TEXT,
        failure_detail  TEXT,
        created_at      BIGINT NOT NULL,
        updated_at      BIGINT NOT NULL,
        expires_at      BIGINT,
        PRIMARY KEY (tenant_id, idempotency_key)
      )`,
      `CREATE INDEX admission_idem_job_idx ON admission_idempotency (tenant_id, job_id)`,
      `CREATE INDEX admission_idem_state_idx ON admission_idempotency (state, updated_at)`,
    ],
  },
  {
    // Phase 1F: durable reconciliation watermark + gap registry. The watermark
    // is the sole durable progress source (no in-memory cursor), so an
    // interrupted reconciliation run resumes from the last committed boundary
    // without re-projecting or dropping records.
    version: 9,
    name: "reconciliation",
    statements: [
      `CREATE TABLE reconciliation_runs (
        run_id      TEXT PRIMARY KEY,
        tenant_id   TEXT NOT NULL,
        scope       TEXT NOT NULL,
        started_at  BIGINT NOT NULL,
        finished_at BIGINT,
        status      TEXT NOT NULL,
        watermark   BIGINT NOT NULL,
        gaps_found  INTEGER NOT NULL DEFAULT 0,
        gaps_repaired INTEGER NOT NULL DEFAULT 0,
        error       TEXT
      )`,
      `CREATE INDEX recon_runs_tenant_idx ON reconciliation_runs (tenant_id, started_at)`,
      `CREATE TABLE reconciliation_gaps (
        gap_id      TEXT PRIMARY KEY,
        tenant_id   TEXT NOT NULL,
        kind        TEXT NOT NULL,
        ref_type    TEXT NOT NULL,
        ref_id      TEXT NOT NULL,
        ref_seq     BIGINT,
        state       TEXT NOT NULL,
        detail      TEXT,
        detected_at BIGINT NOT NULL,
        repaired_at BIGINT,
        run_id      TEXT
      )`,
      `CREATE UNIQUE INDEX recon_gap_identity_idx ON reconciliation_gaps (tenant_id, kind, ref_type, ref_id, COALESCE(ref_seq, -1))`,
    ],
  },
  {
    // Phase 1F: snapshot GC retry ledger. A failed provider deletion stays
    // retryable (state stays 'deleting'); the snapshot is only marked 'deleted'
    // once the provider confirms (or the design's idempotent-delete contract
    // allows it). GC never deletes a snapshot required by an active recovery.
    version: 10,
    name: "snapshot_gc",
    statements: [
      `CREATE TABLE snapshot_gc_attempts (
        snapshot_id   TEXT PRIMARY KEY REFERENCES snapshot_lifecycle (snapshot_id) ON DELETE CASCADE,
        tenant_id     TEXT NOT NULL,
        state         TEXT NOT NULL,
        attempts      INTEGER NOT NULL DEFAULT 0,
        last_error    TEXT,
        last_attempt_at BIGINT,
        eligible_at   BIGINT NOT NULL,
        deleted_at    BIGINT
      )`,
      `CREATE INDEX snapshot_gc_state_idx ON snapshot_gc_attempts (state, eligible_at)`,
    ],
  },
]

const LEDGER = `CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  applied_at BIGINT NOT NULL
)`

/** Apply pending migrations in version order. Returns applied versions.
 *
 * The migration ledger (`schema_migrations`) is shared across all stores that
 * wrap the same {@link SqlDatabase}. Migrations are deduplicated by **name**
 * (globally unique across all packages), NOT by version number: different
 * packages intentionally use overlapping version numbers (e.g. identity v2
 * "identity_core" and store-sql v2 "distributed_control_plane"), so version
 * alone is not a stable identity. A business-layer store may pass its own
 * migration list (Phase 1E) and already-applied migrations (by name) are
 * skipped. This lets durable business state share the execution store's
 * database without duplicating the migration machinery. */
export function applyMigrations(db: SqlDatabase, migrations: readonly Migration[] = MIGRATIONS, dialect?: import("./driver").SqlDialect): number[] {
  const param = (sql: string): string => (dialect ? dialect.parameterize(sql) : sql)
  db.exec(LEDGER)
  const appliedRows = db.prepare(param("SELECT name FROM schema_migrations")).all()
  const applied = new Set(appliedRows.map((row) => String(row.name)))
  const newlyApplied: number[] = []
  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    if (applied.has(migration.name)) continue
    db.exec(dialect ? dialect.beginImmediateStatement() : "BEGIN")
    try {
      for (const statement of migration.statements) db.exec(statement)
      db.prepare(param("INSERT INTO schema_migrations (name, version, applied_at) VALUES (?, ?, ?)")).run(
        migration.name,
        migration.version,
        Date.now(),
      )
      db.exec("COMMIT")
      newlyApplied.push(migration.version)
    } catch (error) {
      try {
        db.exec("ROLLBACK")
      } catch {
        // already rolled back
      }
      throw error
    }
  }
  return newlyApplied
}
