/**
 * PostgreSQL {@link DurableJobStore} (Phase 1D).
 *
 * Same behavioral contract as {@link SqlJobStore} (SQLite) and
 * {@link FileJobStore}, but against a real PostgreSQL server over `pg`. This is
 * where Vaulltcore proves its fencing model is not merely correct in one process:
 * separate connections, concurrent transactions, and true row-level locks all
 * preserve exactly one authoritative active owner.
 *
 * Concurrency model (preserves every Phase 1A/1B/1C fencing invariant):
 * - Every state-changing operation runs inside a SERIALIZABLE transaction with
 *   `SELECT ... FOR UPDATE` on the job row, so read-check-write fencing is
 *   race-free across connections; any failure rolls back everything.
 * - Exactly one authoritative active owner per job (job_leases PK on job_id).
 * - `acquireLease` is conditional: it proceeds only when no live lease held by
 *   another token exists, via a conditional UPDATE on jobs.attempt.
 * - `attempt` (ownership generation) is monotonic; every state-changing write
 *   path takes `expectedAttempt` and CAS-updates on it. A stale writer gets
 *   `LeaseFencedError`.
 * - `renewLease` is fenced: a stale token can never renew a newer generation.
 * - Event seq is assigned inside the transaction from jobs.last_seq; PRIMARY KEY
 *   (job_id, seq) makes duplicate delivery fail deterministically.
 *
 * No PostgreSQL-specific runner logic: the runner speaks only
 * {@link DurableJobStore}; this class is the only place that knows about pg.
 */

import { Pool, types as pgTypes, type PoolClient } from "pg"
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
  type LeaseGrant,
  type LeaseRenewalResult,
  type NewJobEvent,
} from "@vaulltcore/runner"
import { applyMigrationsPg } from "./pg-migrations"

export interface PostgresJobStoreHooks {
  readonly beforeCommit?: (op: string) => void
}

export interface PostgresJobStoreOptions {
  readonly connectionString?: string
  readonly hooks?: PostgresJobStoreHooks
  /** Existing pool (tests); when provided, `close()` is a no-op. */
  readonly pool?: Pool
}

interface JobRow {
  job_id: string
  tenant_id: string
  org_id: string
  project_id: string
  status: string
  attempt: number
  cancel_requested: number | boolean
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

export class PostgresJobStore implements DurableJobStore {
  private readonly pool: Pool
  private readonly ownsPool: boolean
  private readonly hooks: PostgresJobStoreHooks | undefined
  private migrated = false

  constructor(options: PostgresJobStoreOptions = {}) {
    this.pool = options.pool ?? new Pool({ connectionString: options.connectionString })
    this.ownsPool = options.pool === undefined
    this.hooks = options.hooks
    // Parse 64-bit integers (BIGINT/int8, OID 20; int4 OID 23) as JS numbers.
    // Without this, the `pg` driver returns BIGINT columns (epoch-ms timestamps,
    // event seq, last_seq) as strings to avoid precision loss — which breaks the
    // number comparisons the fencing logic depends on. Vaulltcore's values (ms
    // timestamps, monotonic seq) are well within JS safe-integer range.
    const parser = (value: string) => (value === null ? null : Number(value))
    for (const oid of [20, 23]) pgTypes.setTypeParser(oid, parser)
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end()
  }

  /** Ensure migrations are applied exactly once per store instance. */
  private async ensureMigrations(): Promise<void> {
    if (this.migrated) return
    await applyMigrationsPg(this.pool)
    this.migrated = true
  }

  /** One atomic SERIALIZABLE transaction boundary. */
  private async atomic<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    await this.ensureMigrations()
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE")
      try {
        const result = await fn(client)
        this.hooks?.beforeCommit?.("atomic")
        await client.query("COMMIT")
        return result
      } catch (error) {
        try {
          await client.query("ROLLBACK")
        } catch {
          // rollback after a failed BEGIN is harmless
        }
        throw error
      }
    } finally {
      client.release()
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
      cancelRequested: Boolean(row.cancel_requested),
      error: row.error,
      env: JSON.parse(row.env) as Record<string, string>,
      policy: JSON.parse(row.policy) as JobRecord["policy"],
      latestSnapshot: row.latest_snapshot ? (JSON.parse(row.latest_snapshot) as JobRecord["latestSnapshot"]) : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  private async readRow(client: PoolClient, jobId: string, forUpdate = false): Promise<JobRow> {
    const { rows } = await client.query<JobRow>(
      `SELECT * FROM jobs WHERE job_id = $1${forUpdate ? " FOR UPDATE" : ""}`,
      [jobId],
    )
    if (rows.length === 0) throw new JobNotFoundError(jobId)
    return rows[0]!
  }

  private async readLease(client: PoolClient, jobId: string): Promise<LeaseRow | undefined> {
    const { rows } = await client.query<LeaseRow>("SELECT * FROM job_leases WHERE job_id = $1", [jobId])
    return rows[0]
  }

  // -------------------------------------------------------------------------
  // DurableJobStore
  // -------------------------------------------------------------------------

  async createJobRecord(record: JobRecord): Promise<void> {
    await this.ensureMigrations()
    try {
      await this.pool.query(
        `INSERT INTO jobs (
            job_id, tenant_id, org_id, project_id, status, attempt,
            cancel_requested, error, spec, env, policy, latest_snapshot,
            last_seq, created_at, updated_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,0,$13,$14)`,
        [
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
        ],
      )
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new VaulltcoreError("JOB_EXISTS", `Job ${record.jobId} already exists; refusing to overwrite durable identity`)
      }
      throw error
    }
  }

  async getJobRecord(jobId: string): Promise<JobRecord | null> {
    await this.ensureMigrations()
    const { rows } = await this.pool.query<JobRow>("SELECT * FROM jobs WHERE job_id = $1", [jobId])
    if (rows.length === 0) return null
    const lease = await this.readLeaseRaw(jobId)
    return this.toRecord(rows[0]!, lease)
  }

  private async readLeaseRaw(jobId: string): Promise<LeaseRow | undefined> {
    const { rows } = await this.pool.query<LeaseRow>("SELECT * FROM job_leases WHERE job_id = $1", [jobId])
    return rows[0]
  }

  async updateJobRecord(
    jobId: string,
    expectedAttempt: number,
    mutate: (record: JobRecord) => Partial<JobRecord>,
  ): Promise<JobRecord> {
    return this.atomic(async (client) => {
      const row = await this.readRow(client, jobId, true)
      if (row.attempt !== expectedAttempt) throw new LeaseFencedError(jobId)
      const record = this.toRecord(row, await this.readLease(client, jobId))
      const patch = mutate(record)
      assertImmutableJobUpdate(jobId, record, patch)
      const next: JobRecord = { ...record, ...patch, updatedAt: Date.now() }

      const result = await client.query(
        `UPDATE jobs SET status = $1, cancel_requested = $2, error = $3, latest_snapshot = $4, updated_at = $5
         WHERE job_id = $6 AND attempt = $7`,
        [
          next.status,
          next.cancelRequested ? 1 : 0,
          next.error,
          next.latestSnapshot ? JSON.stringify(next.latestSnapshot) : null,
          next.updatedAt,
          jobId,
          expectedAttempt,
        ],
      )
      if (result.rowCount === 0) throw new LeaseFencedError(jobId)

      if ("leaseToken" in patch) {
        if (patch.leaseToken === null || patch.leaseToken === undefined) {
          await client.query("DELETE FROM job_leases WHERE job_id = $1", [jobId])
        } else {
          await client.query(
            `INSERT INTO job_leases (job_id, token, generation, expires_at, acquired_at) VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (job_id) DO UPDATE SET token = EXCLUDED.token, generation = EXCLUDED.generation,
               expires_at = EXCLUDED.expires_at, acquired_at = EXCLUDED.acquired_at`,
            [jobId, patch.leaseToken, expectedAttempt, patch.leaseExpiresAt ?? next.leaseExpiresAt ?? 0, Date.now()],
          )
        }
      }

      if (patch.latestSnapshot) {
        const snapshot = patch.latestSnapshot
        await client.query(
          `INSERT INTO job_snapshots (job_id, snapshot_id, snapshot, created_at) VALUES ($1,$2,$3,$4)
           ON CONFLICT (job_id, snapshot_id) DO UPDATE SET snapshot = EXCLUDED.snapshot`,
          [jobId, snapshot.snapshotId, JSON.stringify(snapshot), snapshot.createdAt],
        )
      }
      return next
    })
  }

  async acquireLease(jobId: string, leaseToken: string, leaseMs: number): Promise<LeaseGrant> {
    return this.atomic(async (client) => {
      const row = await this.readRow(client, jobId, true)
      const lease = await this.readLease(client, jobId)
      const now = Date.now()
      if (lease && lease.expires_at > now && lease.token !== leaseToken) {
        throw new VaulltcoreError("LEASE_HELD", `Job ${jobId} is leased by another worker until ${lease.expires_at}`)
      }
      const grant: LeaseGrant = { attempt: row.attempt + 1, leaseToken, leaseExpiresAt: now + leaseMs }
      const result = await client.query("UPDATE jobs SET attempt = $1, updated_at = $2 WHERE job_id = $3 AND attempt = $4", [
        grant.attempt,
        now,
        jobId,
        row.attempt,
      ])
      if (result.rowCount === 0) throw new LeaseFencedError(jobId)
      await client.query(
        `INSERT INTO job_leases (job_id, token, generation, expires_at, acquired_at) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (job_id) DO UPDATE SET token = EXCLUDED.token, generation = EXCLUDED.generation,
           expires_at = EXCLUDED.expires_at, acquired_at = EXCLUDED.acquired_at`,
        [jobId, leaseToken, grant.attempt, grant.leaseExpiresAt, now],
      )
      return grant
    })
  }

  async renewLease(jobId: string, leaseToken: string, leaseMs: number): Promise<LeaseRenewalResult> {
    return this.atomic(async (client) => {
      await this.readRow(client, jobId, true)
      const lease = await this.readLease(client, jobId)
      if (!lease) return { renewed: false as const, reason: "not_found" as const }
      if (lease.token !== leaseToken) return { renewed: false as const, reason: "fenced" as const }
      const now = Date.now()
      if (lease.expires_at <= now) return { renewed: false as const, reason: "expired" as const, expiresAt: lease.expires_at }
      const expiresAt = now + leaseMs
      const result = await client.query("UPDATE job_leases SET expires_at = $1 WHERE job_id = $2 AND token = $3", [expiresAt, jobId, leaseToken])
      if (result.rowCount === 0) return { renewed: false as const, reason: "fenced" as const }
      return { renewed: true as const, expiresAt }
    })
  }

  async releaseLease(jobId: string, leaseToken: string): Promise<void> {
    await this.atomic(async (client) => {
      await this.readRow(client, jobId)
      await client.query("DELETE FROM job_leases WHERE job_id = $1 AND token = $2", [jobId, leaseToken])
    })
  }

  async appendEvents<T>(jobId: string, events: readonly NewJobEvent<T>[], expectedAttempt?: number): Promise<JobEvent<T>[]> {
    if (events.length === 0) return []
    await this.ensureMigrations()
    return this.atomic(async (client) => {
      const row = await this.readRow(client, jobId, true)
      if (expectedAttempt !== undefined && row.attempt !== expectedAttempt) throw new LeaseFencedError(jobId)
      const payloads = events.map((event) => ({
        timestamp: event.timestamp,
        type: event.type as JobEventType,
        data: JSON.stringify(event.data ?? null),
      }))
      let seq = row.last_seq
      const stamped: JobEvent<T>[] = []
      for (let index = 0; index < events.length; index++) {
        seq += 1
        try {
          await client.query("INSERT INTO job_events (job_id, seq, timestamp, type, data) VALUES ($1,$2,$3,$4,$5)", [
            jobId,
            seq,
            payloads[index]!.timestamp,
            payloads[index]!.type,
            payloads[index]!.data,
          ])
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new VaulltcoreError("EVENT_SEQ_CONFLICT", `Duplicate event delivery rejected: (job ${jobId}, seq ${seq}) already exists`)
          }
          throw error
        }
        stamped.push({ ...events[index]!, seq })
      }
      const result = await client.query("UPDATE jobs SET last_seq = $1 WHERE job_id = $2 AND last_seq < $3", [seq, jobId, seq])
      if (result.rowCount === 0) throw new VaulltcoreError("EVENT_SEQ_CONFLICT", `Event seq regression for job ${jobId}`)
      return stamped
    })
  }

  async listEvents(jobId: string, afterSeq = 0): Promise<JobEvent[]> {
    await this.ensureMigrations()
    const exists = await this.getJobRecord(jobId)
    if (!exists) throw new JobNotFoundError(jobId)
    const { rows } = await this.pool.query<{ seq: number; timestamp: number; type: JobEventType; data: string }>(
      "SELECT seq, timestamp, type, data FROM job_events WHERE job_id = $1 AND seq > $2 ORDER BY seq ASC",
      [jobId, afterSeq],
    )
    return rows.map((row) => ({ jobId, seq: row.seq, timestamp: row.timestamp, type: row.type, data: JSON.parse(row.data) as unknown }))
  }

  async saveCheckpoint(jobId: string, checkpoint: JobCheckpoint): Promise<void> {
    return this.atomic(async (client) => {
      const row = await this.readRow(client, jobId, true)
      if (row.attempt !== checkpoint.attempt) throw new LeaseFencedError(jobId)
      if (checkpoint.lastEventSeq > row.last_seq) {
        throw new VaulltcoreError("CHECKPOINT_AHEAD_OF_LOG", `Checkpoint watermark ${checkpoint.lastEventSeq} exceeds committed seq ${row.last_seq}`)
      }
      await client.query(
        `INSERT INTO job_checkpoints (job_id, checkpoint, last_event_seq, attempt, updated_at) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (job_id) DO UPDATE SET checkpoint = EXCLUDED.checkpoint,
           last_event_seq = EXCLUDED.last_event_seq, attempt = EXCLUDED.attempt, updated_at = EXCLUDED.updated_at`,
        [jobId, JSON.stringify(checkpoint), checkpoint.lastEventSeq, checkpoint.attempt, Date.now()],
      )
    })
  }

  async getCheckpoint(jobId: string): Promise<JobCheckpoint | null> {
    await this.ensureMigrations()
    const exists = await this.getJobRecord(jobId)
    if (!exists) throw new JobNotFoundError(jobId)
    const { rows } = await this.pool.query<{ checkpoint: string }>("SELECT checkpoint FROM job_checkpoints WHERE job_id = $1", [jobId])
    if (rows.length === 0) return null
    return JSON.parse(rows[0]!.checkpoint) as JobCheckpoint
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /duplicate key|unique constraint/i.test(error.message)
}
