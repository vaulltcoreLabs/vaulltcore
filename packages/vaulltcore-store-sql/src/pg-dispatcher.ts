/**
 * PostgreSQL-backed {@link JobDispatcher} (Phase 1D).
 *
 * Naturally async (unlike {@link SqlDispatcher}, which wraps the sync SQLite
 * {@link DistributedSqlStore}). It shares a `pg` connection pool and uses the
 * same `dispatch_claims` / `job_leases` schema, with row-level locking
 * (`SELECT ... FOR UPDATE`) so separate worker processes competing for the next
 * queued job never both win — the database's SERIALIZABLE transaction is the
 * linearization point for exactly one claimant per job.
 *
 * Fencing preserved:
 * - claim acquires the fenced job lease (attempt + 1) inside the same txn;
 * - heartbeat verifies the claim's token before extending the lease;
 * - release deletes only the row matching the caller's token.
 */

import { Pool, types as pgTypes, type PoolClient } from "pg"
import { VaulltcoreError, newLeaseToken, type DispatchClaim, type JobDispatcher, type LeaseRenewalResult, type WorkerIdentity } from "@vaulltcore/runner"

export interface PostgresDispatcherOptions {
  readonly connectionString?: string
  readonly pool?: Pool
}

export class PostgresDispatcher implements JobDispatcher {
  private readonly pool: Pool
  private readonly ownsPool: boolean

  constructor(options: PostgresDispatcherOptions = {}) {
    this.pool = options.pool ?? new Pool({ connectionString: options.connectionString })
    this.ownsPool = options.pool === undefined
    // Consistent with PostgresJobStore: parse int8/int4 as numbers.
    const parser = (value: string) => (value === null ? null : Number(value))
    for (const oid of [20, 23]) pgTypes.setTypeParser(oid, parser)
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end()
  }

  async enqueue(jobId: string): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE")
      try {
        const { rows } = await client.query("SELECT status FROM jobs WHERE job_id = $1", [jobId])
        if (rows.length === 0) throw new VaulltcoreError("JOB_NOT_FOUND", `Job ${jobId} not found`)
        // status queued is the only enqueueable state; no-op otherwise.
        await client.query("COMMIT")
      } catch (error) {
        try {
          await client.query("ROLLBACK")
        } catch {}
        throw error
      }
    } finally {
      client.release()
    }
  }

  async claim(worker: WorkerIdentity, leaseMs: number): Promise<DispatchClaim | null> {
    const now = Date.now()
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE")
      try {
        const { rows: candidates } = await client.query<{ job_id: string }>(
          "SELECT job_id FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED",
        )
        if (candidates.length === 0) {
          await client.query("COMMIT")
          return null
        }
        const jobId = candidates[0]!.job_id
        const token = newLeaseToken()
        const { rows: jr } = await client.query<{ attempt: number }>("SELECT attempt FROM jobs WHERE job_id = $1 FOR UPDATE", [jobId])
        const generation = jr[0]!.attempt + 1
        const expiresAt = now + leaseMs
        const result = await client.query("UPDATE jobs SET attempt = $1, updated_at = $2 WHERE job_id = $3 AND attempt = $4 AND status = 'queued'", [
          generation,
          now,
          jobId,
          jr[0]!.attempt,
        ])
        if (result.rowCount === 0) {
          await client.query("COMMIT")
          return null // lost the race
        }
        await client.query(
          `INSERT INTO job_leases (job_id, token, generation, expires_at, acquired_at) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (job_id) DO UPDATE SET token = EXCLUDED.token, generation = EXCLUDED.generation, expires_at = EXCLUDED.expires_at, acquired_at = EXCLUDED.acquired_at`,
          [jobId, token, generation, expiresAt, now],
        )
        await client.query(
          `INSERT INTO dispatch_claims (job_id, worker_id, boot_token, generation, token, expires_at, claimed_at, acknowledged)
           VALUES ($1,$2,$3,$4,$5,$6,$7,0)
           ON CONFLICT (job_id) DO UPDATE SET worker_id = EXCLUDED.worker_id, boot_token = EXCLUDED.boot_token, generation = EXCLUDED.generation, token = EXCLUDED.token, expires_at = EXCLUDED.expires_at, claimed_at = EXCLUDED.claimed_at, acknowledged = 0`,
          [jobId, worker.workerId, worker.bootToken, generation, token, expiresAt, now],
        )
        await client.query("COMMIT")
        return { jobId, worker, generation, token, expiresAt }
      } catch (error) {
        try {
          await client.query("ROLLBACK")
        } catch {}
        throw error
      }
    } finally {
      client.release()
    }
  }

  async acknowledge(claim: DispatchClaim): Promise<void> {
    await this.fencedMutate(claim, async (client) => {
      const r = await client.query("UPDATE dispatch_claims SET acknowledged = 1 WHERE job_id = $1 AND token = $2", [claim.jobId, claim.token])
      if (r.rowCount === 0) throw new VaulltcoreError("DISPATCH_FENCED", `acknowledge rejected: stale claim for job ${claim.jobId}`)
    })
  }

  async heartbeat(claim: DispatchClaim, leaseMs: number): Promise<LeaseRenewalResult> {
    const now = Date.now()
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE")
      try {
        const { rows } = await client.query<{ token: string; expires_at: number }>(
          "SELECT token, expires_at FROM dispatch_claims WHERE job_id = $1 FOR UPDATE",
          [claim.jobId],
        )
        if (rows.length === 0) {
          await client.query("COMMIT")
          return { renewed: false as const, reason: "not_found" as const }
        }
        const row = rows[0]!
        if (row.token !== claim.token) {
          await client.query("COMMIT")
          return { renewed: false as const, reason: "fenced" as const }
        }
        if (row.expires_at <= now) {
          await client.query("COMMIT")
          return { renewed: false as const, reason: "expired" as const, expiresAt: row.expires_at }
        }
        const expiresAt = now + leaseMs
        const r1 = await client.query("UPDATE dispatch_claims SET expires_at = $1 WHERE job_id = $2 AND token = $3", [expiresAt, claim.jobId, claim.token])
        const r2 = await client.query("UPDATE job_leases SET expires_at = $1 WHERE job_id = $2 AND token = $3", [expiresAt, claim.jobId, claim.token])
        await client.query("COMMIT")
        if (r1.rowCount === 0 || r2.rowCount === 0) return { renewed: false as const, reason: "fenced" as const }
        return { renewed: true as const, expiresAt }
      } catch (error) {
        try {
          await client.query("ROLLBACK")
        } catch {}
        throw error
      }
    } finally {
      client.release()
    }
  }

  async release(claim: DispatchClaim): Promise<void> {
    await this.fencedMutate(claim, async (client) => {
      await client.query("DELETE FROM dispatch_claims WHERE job_id = $1 AND token = $2", [claim.jobId, claim.token])
      await client.query("DELETE FROM job_leases WHERE job_id = $1 AND token = $2", [claim.jobId, claim.token])
    })
  }

  private async fencedMutate(claim: DispatchClaim, fn: (client: PoolClient) => Promise<void>): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE")
      try {
        await fn(client)
        await client.query("COMMIT")
      } catch (error) {
        try {
          await client.query("ROLLBACK")
        } catch {}
        throw error
      }
    } finally {
      client.release()
    }
  }
}
