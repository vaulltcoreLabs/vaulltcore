/**
 * Transactional SQL {@link DurableJobStore} (Phase 1C).
 *
 * Persistence and concurrency infrastructure only — no lifecycle logic is
 * duplicated from DurableAgentRunner. The runner stays database-agnostic;
 * this class sits behind the existing store contract.
 *
 * Concurrency model (preserves every Phase 1A/1B fencing invariant):
 * - Every state-changing operation runs inside BEGIN IMMEDIATE … COMMIT, so
 *   read-check-write fencing is race-free; any failure rolls back everything
 *   (a continuation boundary can never expose partial authoritative
 *   progress).
 * - Exactly one authoritative active owner: one row per job in job_leases.
 * - Lease acquisition is conditional: it only proceeds when no live lease
 *   held by another token exists, via a conditional UPDATE on jobs.attempt.
 * - Ownership generation (jobs.attempt) is monotonic: incremented only by
 *   acquireLease, never decremented, never reused.
 * - Fencing on every write: CAS on `attempt` in the WHERE clause, plus an
 *   in-transaction equality check, so a stale worker gets LeaseFencedError
 *   from event appends, checkpoint commits, status changes, snapshot
 *   attachment and lease release alike.
 * - Event seq is assigned inside the transaction from jobs.last_seq, so seq
 *   is strictly monotonic; PRIMARY KEY (job_id, seq) makes duplicate
 *   delivery fail deterministically rather than be silently deduplicated.
 * - The checkpoint row is authoritative. Events physically present beyond
 *   the checkpoint watermark are orphaned in-flight remnants; this store
 *   stores them faithfully (never deletes, never guesses) and replay
 *   filtering happens only at recovery time against the watermark.
 */

import {
  JobNotFoundError,
  LeaseFencedError,
  VaulltcoreError,
  assertImmutableJobUpdate,
  type DurableJobStore,
  type JobCheckpoint,
  type JobEvent,
  type JobEventType,
  type JobRecord,
  type JobStatus,
  type LeaseGrant,
  type NewJobEvent,
} from "@vaulltcore/runner"
import type { LeaseRenewalResult } from "@vaulltcore/runner"
import { applyMigrations, MIGRATIONS } from "./migrations"
import { sqliteDialect, type SqlDatabase, type SqlDialect, type SqlStatement } from "./driver"

export interface SqlJobStoreHooks {
  /** Fault-injection hook invoked inside the transaction immediately before
   * COMMIT; throwing forces a full rollback (tests prove no partial writes
   * escape a failed continuation boundary). */
  readonly beforeCommit?: (op: string) => void
}

export interface SqlJobStoreOptions {
  readonly hooks?: SqlJobStoreHooks
  /** Defaults to SQLite; a PostgreSQL dialect descriptor is provided for the
   * future driver (`$n` placeholder rewriting). */
  readonly dialect?: SqlDialect
}

interface JobRow {
  job_id: string
  tenant_id: string
  org_id: string
  project_id: string
  status: string
  attempt: number
  cancel_requested: number
  error: string | null
  spec: string
  env: string
  policy: string
  latest_snapshot: string | null
  last_seq: number
  created_at: number
  updated_at: number
}

interface LeaseRow {
  job_id: string
  token: string
  generation: number
  expires_at: number
  acquired_at: number
}

export class SqlJobStore implements DurableJobStore {
  readonly dialectName: string
  private readonly dialect: SqlDialect

  constructor(
    private readonly db: SqlDatabase,
    private readonly options: SqlJobStoreOptions = {},
  ) {
    this.dialect = options.dialect ?? sqliteDialect
    this.dialectName = this.dialect.name
    applyMigrations(this.db, MIGRATIONS, this.dialect)
  }

  /** Escape hatch for infrastructure concerns (tests, ops tooling). The
   * runner never touches this. */
  database(): SqlDatabase {
    return this.db
  }

  close(): void {
    this.db.close()
  }

  // -------------------------------------------------------------------------
  // Transaction boundary
  // -------------------------------------------------------------------------

  /** Statements are written with `?` placeholders and rewritten according to
   * the dialect (identity on SQLite, `$n` on PostgreSQL). */
  private prepare(sql: string): SqlStatement {
    return this.db.prepare(this.dialect.parameterize(sql))
  }

  /**
   * One atomic commit boundary. All driver statements are synchronous, so the
   * whole critical section executes without an await point: no interleaving
   * is possible between the in-transaction checks and the writes they guard.
   */
  private atomic<T>(op: string, fn: () => T): T {
    this.db.exec(this.dialect.beginImmediateStatement())
    try {
      const result = fn()
      this.options.hooks?.beforeCommit?.(op)
      this.db.exec("COMMIT")
      return result
    } catch (error) {
      try {
        this.db.exec("ROLLBACK")
      } catch {
        // rollback after a failed BEGIN is harmless
      }
      throw error
    }
  }

  // -------------------------------------------------------------------------
  // Row assembly
  // -------------------------------------------------------------------------

  private toRecord(row: JobRow, lease: LeaseRow | undefined): JobRecord {
    return {
      jobId: row.job_id,
      tenantId: row.tenant_id,
      orgId: row.org_id,
      projectId: row.project_id,
      spec: JSON.parse(row.spec) as JobRecord["spec"],
      status: row.status as JobRecord["status"],
      attempt: row.attempt,
      leaseToken: lease?.token ?? null,
      leaseExpiresAt: lease?.expires_at ?? null,
      cancelRequested: row.cancel_requested === 1,
      error: row.error,
      env: JSON.parse(row.env) as Record<string, string>,
      policy: JSON.parse(row.policy) as JobRecord["policy"],
      latestSnapshot: row.latest_snapshot ? (JSON.parse(row.latest_snapshot) as JobRecord["latestSnapshot"]) : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  private readRow(jobId: string): JobRow {
    const row = this.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId) as JobRow | undefined
    if (!row) throw new JobNotFoundError(jobId)
    return row
  }

  private readLease(jobId: string): LeaseRow | undefined {
    return this.prepare("SELECT * FROM job_leases WHERE job_id = ?").get(jobId) as LeaseRow | undefined
  }

  // -------------------------------------------------------------------------
  // DurableJobStore
  // -------------------------------------------------------------------------

  async createJobRecord(record: JobRecord): Promise<void> {
    this.atomic("createJobRecord", () => {
      try {
        this.prepare(
            `INSERT INTO jobs (
              job_id, tenant_id, org_id, project_id, status, attempt,
              cancel_requested, error, spec, env, policy, latest_snapshot,
              last_seq, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
          )
          .run(
            record.jobId,
            record.tenantId,
            record.orgId,
            record.projectId,
            record.status,
            record.attempt,
            record.cancelRequested ? 1 : 0,
            record.error,
            JSON.stringify(record.spec),
            JSON.stringify(record.env),
            JSON.stringify(record.policy),
            record.latestSnapshot ? JSON.stringify(record.latestSnapshot) : null,
            record.createdAt,
            record.updatedAt,
          )
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new VaulltcoreError("JOB_EXISTS", `Job ${record.jobId} already exists; refusing to overwrite durable identity`)
        }
        throw error
      }
    })
  }

  async getJobRecord(jobId: string): Promise<JobRecord | null> {
    const row = this.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId) as JobRow | undefined
    if (!row) return null
    return this.toRecord(row, this.readLease(jobId))
  }

  async updateJobRecord(
    jobId: string,
    expectedAttempt: number,
    mutate: (record: JobRecord) => Partial<JobRecord>,
  ): Promise<JobRecord> {
    return this.atomic("updateJobRecord", () => {
      const row = this.readRow(jobId)
      if (row.attempt !== expectedAttempt) throw new LeaseFencedError(jobId)
      const record = this.toRecord(row, this.readLease(jobId))
      const patch = mutate(record)
      assertImmutableJobUpdate(jobId, record, patch)
      const next: JobRecord = { ...record, ...patch, updatedAt: Date.now() }

      // CAS on attempt: even under cross-connection contention a stale writer
      // loses the race with zero rows changed.
      const result = this.prepare(
          `UPDATE jobs SET status = ?, cancel_requested = ?, error = ?, latest_snapshot = ?, updated_at = ?
           WHERE job_id = ? AND attempt = ?`,
        )
        .run(
          next.status,
          next.cancelRequested ? 1 : 0,
          next.error,
          next.latestSnapshot ? JSON.stringify(next.latestSnapshot) : null,
          next.updatedAt,
          jobId,
          expectedAttempt,
        )
      if (result.changes === 0) throw new LeaseFencedError(jobId)

      // Lease mutation through patches (suspend/release paths clear it).
      if ("leaseToken" in patch) {
        if (patch.leaseToken === null || patch.leaseToken === undefined) {
          this.prepare("DELETE FROM job_leases WHERE job_id = ?").run(jobId)
        } else {
          this
            .prepare(
              `INSERT INTO job_leases (job_id, token, generation, expires_at, acquired_at) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT (job_id) DO UPDATE SET token = excluded.token, generation = excluded.generation,
                 expires_at = excluded.expires_at, acquired_at = excluded.acquired_at`,
            )
            .run(jobId, patch.leaseToken, expectedAttempt, patch.leaseExpiresAt ?? next.leaseExpiresAt ?? 0, Date.now())
        }
      }

      // Snapshot attachment is recorded in its own table in the SAME
      // transaction as the record pointer — no observable half-attached state.
      if (patch.latestSnapshot) {
        const snapshot = patch.latestSnapshot
        this.prepare(
            `INSERT INTO job_snapshots (job_id, snapshot_id, snapshot, created_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (job_id, snapshot_id) DO UPDATE SET snapshot = excluded.snapshot`,
          )
          .run(jobId, snapshot.snapshotId, JSON.stringify(snapshot), snapshot.createdAt)
      }
      return next
    })
  }

  async acquireLease(jobId: string, leaseToken: string, leaseMs: number): Promise<LeaseGrant> {
    return this.atomic("acquireLease", () => {
      const row = this.readRow(jobId)
      const lease = this.readLease(jobId)
      const now = Date.now()
      if (lease && lease.expires_at > now && lease.token !== leaseToken) {
        throw new VaulltcoreError("LEASE_HELD", `Job ${jobId} is leased by another worker until ${lease.expires_at}`)
      }
      const grant: LeaseGrant = { attempt: row.attempt + 1, leaseToken, leaseExpiresAt: now + leaseMs }
      const result = this.prepare("UPDATE jobs SET attempt = ?, updated_at = ? WHERE job_id = ? AND attempt = ?")
        .run(grant.attempt, now, jobId, row.attempt)
      if (result.changes === 0) throw new LeaseFencedError(jobId)
      this.prepare(
          `INSERT INTO job_leases (job_id, token, generation, expires_at, acquired_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (job_id) DO UPDATE SET token = excluded.token, generation = excluded.generation,
             expires_at = excluded.expires_at, acquired_at = excluded.acquired_at`,
        )
        .run(jobId, leaseToken, grant.attempt, grant.leaseExpiresAt, now)
      return grant
    })
  }

  /** Explicit ownership release. Idempotent; a mismatched (stale) token is a
   * no-op and can never clear a newer owner's lease. */
  async releaseLease(jobId: string, leaseToken: string): Promise<void> {
    return this.atomic("releaseLease", () => {
      this.readRow(jobId) // throws JobNotFoundError for unknown jobs
      const lease = this.readLease(jobId)
      if (!lease || lease.token !== leaseToken) return
      // Token in the WHERE clause as defense in depth.
      this.prepare("DELETE FROM job_leases WHERE job_id = ? AND token = ?").run(jobId, leaseToken)
    })
  }

  /** Fenced lease renewal (heartbeat durability path). A stale token can never
   * renew a lease held by a newer generation; this returns a fenced result
   * instead of throwing so the supervisor can classify expiry deterministically. */
  async renewLease(jobId: string, leaseToken: string, leaseMs: number): Promise<LeaseRenewalResult> {
    return this.atomic("renewLease", () => {
      const row = this.readRow(jobId)
      const lease = this.readLease(jobId)
      if (!lease) return { renewed: false as const, reason: "not_found" as const }
      if (lease.token !== leaseToken) return { renewed: false as const, reason: "fenced" as const }
      const now = Date.now()
      if (lease.expires_at <= now) return { renewed: false as const, reason: "expired" as const, expiresAt: lease.expires_at }
      const expiresAt = now + leaseMs
      // CAS on token: defense in depth under cross-connection contention.
      const result = this.prepare("UPDATE job_leases SET expires_at = ? WHERE job_id = ? AND token = ?").run(expiresAt, jobId, leaseToken)
      if (result.changes === 0) return { renewed: false as const, reason: "fenced" as const }
      void row
      return { renewed: true as const, expiresAt }
    })
  }

  async appendEvents<T>(jobId: string, events: readonly NewJobEvent<T>[], expectedAttempt?: number): Promise<JobEvent<T>[]> {
    if (events.length === 0) return []
    return this.atomic("appendEvents", () => {
      const row = this.readRow(jobId)
      if (expectedAttempt !== undefined && row.attempt !== expectedAttempt) throw new LeaseFencedError(jobId)
      // Serialize everything before the first INSERT: a payload that fails
      // to encode leaves zero rows behind even before the rollback fires.
      const payloads = events.map((event) => ({
        timestamp: event.timestamp,
        type: event.type as JobEventType,
        data: JSON.stringify(event.data ?? null),
      }))
      let seq = row.last_seq
      const stamped: JobEvent<T>[] = []
      const insert = this.prepare("INSERT INTO job_events (job_id, seq, timestamp, type, data) VALUES (?, ?, ?, ?, ?)")
      for (let index = 0; index < events.length; index++) {
        seq += 1
        try {
          insert.run(jobId, seq, payloads[index]!.timestamp, payloads[index]!.type, payloads[index]!.data)
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new VaulltcoreError(
              "EVENT_SEQ_CONFLICT",
              `Duplicate event delivery rejected: (job ${jobId}, seq ${seq}) already exists`,
            )
          }
          throw error
        }
        stamped.push({ ...events[index]!, seq })
      }
      const result = this.prepare("UPDATE jobs SET last_seq = ? WHERE job_id = ? AND last_seq < ?").run(seq, jobId, seq)
      if (result.changes === 0) throw new VaulltcoreError("EVENT_SEQ_CONFLICT", `Event seq regression for job ${jobId}`)
      return stamped
    })
  }

  async listEvents(jobId: string, afterSeq = 0): Promise<JobEvent[]> {
    if (!(await this.getJobRecord(jobId))) throw new JobNotFoundError(jobId)
    const rows = this.prepare("SELECT seq, timestamp, type, data FROM job_events WHERE job_id = ? AND seq > ? ORDER BY seq ASC")
      .all(jobId, afterSeq) as Array<{ seq: number; timestamp: number; type: JobEventType; data: string }>
    return rows.map((row) => ({
      jobId,
      seq: row.seq,
      timestamp: row.timestamp,
      type: row.type,
      data: JSON.parse(row.data) as unknown,
    }))
  }

  /**
   * Tenant-scoped job index for reconciliation/ops (Phase 1F). Returns job ids
   * + identity + status + last committed seq for a tenant. Read-only and
   * tenant-scoped: there is no path that returns another tenant's jobs. The
   * reconciler uses this to enumerate authoritative execution state without
   * touching the runner's execution path.
   */
  async listJobsByTenant(tenantId: string): Promise<Array<{ jobId: string; tenantId: string; orgId: string; projectId: string; status: JobStatus; lastSeq: number; createdAt: number; updatedAt: number }>> {
    const rows = this.prepare(
      "SELECT job_id, tenant_id, org_id, project_id, status, last_seq, created_at, updated_at FROM jobs WHERE tenant_id = ? ORDER BY created_at ASC",
    ).all(tenantId) as Array<{ job_id: string; tenant_id: string; org_id: string; project_id: string; status: string; last_seq: number; created_at: number; updated_at: number }>
    return rows.map((row) => ({
      jobId: row.job_id,
      tenantId: row.tenant_id,
      orgId: row.org_id,
      projectId: row.project_id,
      status: row.status as JobStatus,
      lastSeq: row.last_seq,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }

  async saveCheckpoint(jobId: string, checkpoint: JobCheckpoint): Promise<void> {
    return this.atomic("saveCheckpoint", () => {
      const row = this.readRow(jobId)
      if (row.attempt !== checkpoint.attempt) throw new LeaseFencedError(jobId)
      if (checkpoint.lastEventSeq > row.last_seq) {
        throw new VaulltcoreError(
          "CHECKPOINT_AHEAD_OF_LOG",
          `Checkpoint watermark ${checkpoint.lastEventSeq} exceeds committed seq ${row.last_seq}`,
        )
      }
      this.prepare(
          `INSERT INTO job_checkpoints (job_id, checkpoint, last_event_seq, attempt, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (job_id) DO UPDATE SET checkpoint = excluded.checkpoint,
             last_event_seq = excluded.last_event_seq, attempt = excluded.attempt, updated_at = excluded.updated_at`,
        )
        .run(jobId, JSON.stringify(checkpoint), checkpoint.lastEventSeq, checkpoint.attempt, Date.now())
    })
  }

  async getCheckpoint(jobId: string): Promise<JobCheckpoint | null> {
    if (!(await this.getJobRecord(jobId))) throw new JobNotFoundError(jobId)
    const row = this.prepare("SELECT checkpoint FROM job_checkpoints WHERE job_id = ?").get(jobId) as
      | { checkpoint: string }
      | undefined
    if (!row) return null
    return JSON.parse(row.checkpoint) as JobCheckpoint
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /unique constraint failed|duplicate key/i.test(error.message)
}
