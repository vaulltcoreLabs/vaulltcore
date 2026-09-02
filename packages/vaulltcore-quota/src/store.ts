/**
 * SQL-backed quota store with a race-free reservation algorithm (Phase 1E).
 *
 * Reservation algorithm (concurrency-safe across connections):
 *   reserve(scope, requestKey, jobId, limits):
 *     BEGIN IMMEDIATE
 *     1. Look up an existing reservation by (tenant, requestKey) — if present,
 *        return it idempotently (replay does NOT consume capacity twice).
 *     2. Read the in-use counter for the scope.
 *     3. Conditionally increment the counter:
 *          UPDATE quota_counters SET in_use = in_use + 1
 *          WHERE scope = ? AND in_use < max_concurrent
 *        If 0 rows change → capacity is full: insert a 'rejected' reservation
 *        (with its own id) and throw QuotaExceededError. The rejected row is
 *        durable proof of denial (audit) and never counts against capacity.
 *     4. Insert the 'active' reservation (UNIQUE on reservation_id and on
 *        (tenant, requestKey)). On a UNIQUE collision, rollback the counter
 *        increment and return the existing reservation (idempotent).
 *     COMMIT
 *
 * The conditional UPDATE is the race-free primitive: under `BEGIN IMMEDIATE`
 * (SQLite) or `BEGIN` + the unique partial index (Postgres), exactly one of two
 * concurrent reservations can bump `in_use` into the last slot; the other sees
 * `in_use < max_concurrent` as false and gets 0 changed rows. This is NOT a
 * check-then-insert race — the check and the mutation are one statement.
 *
 * Settlement / release decrement `in_use` exactly once (idempotent + fenced by
 * the row's `version`). A stale settlement (version mismatch) is rejected and
 * can never decrement a newer reservation's capacity.
 */

import { SqlStoreBase, isUniqueViolation, type Migration, type SqlDialect, type SqlDatabase } from "@vaulltcore/store-sql"
import {
  type QuotaLimits,
  type QuotaReservation,
  type QuotaScope,
  QuotaError,
  type ReservationState,
} from "./contracts"
import { randomBytes } from "node:crypto"

export const QUOTA_MIGRATIONS: readonly Migration[] = [
  {
    version: 4,
    name: "quota_reservation",
    statements: [
      `CREATE TABLE quota_limits (
        tenant_id            TEXT NOT NULL,
        org_id               TEXT NOT NULL,
        project_id           TEXT NOT NULL,
        max_concurrent_jobs  INTEGER NOT NULL,
        jobs_per_period      INTEGER NOT NULL,
        period_ms            INTEGER NOT NULL,
        max_tokens           INTEGER NOT NULL,
        max_duration_ms      INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, org_id, project_id)
      )`,
      `CREATE TABLE quota_counters (
        tenant_id  TEXT NOT NULL,
        org_id     TEXT NOT NULL,
        project_id TEXT NOT NULL,
        in_use     INTEGER NOT NULL DEFAULT 0,
        period_started_at INTEGER NOT NULL DEFAULT 0,
        period_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (tenant_id, org_id, project_id)
      )`,
      `CREATE TABLE quota_reservations (
        reservation_id   TEXT PRIMARY KEY,
        tenant_id         TEXT NOT NULL,
        org_id            TEXT NOT NULL,
        project_id        TEXT NOT NULL,
        request_key       TEXT NOT NULL,
        job_id            TEXT,
        state             TEXT NOT NULL,
        version           INTEGER NOT NULL,
        created_at        INTEGER NOT NULL,
        settled_at        INTEGER,
        released_at       INTEGER,
        expires_at        INTEGER NOT NULL,
        settled_tokens    INTEGER,
        settled_duration_ms INTEGER,
        reason_code       TEXT,
        UNIQUE (tenant_id, request_key)
      )`,
      `CREATE INDEX quota_reservations_scope_idx ON quota_reservations (tenant_id, org_id, project_id, state)`,
      `CREATE TABLE usage_periods (
        tenant_id  TEXT NOT NULL,
        org_id     TEXT NOT NULL,
        project_id TEXT NOT NULL,
        period_started_at INTEGER NOT NULL,
        period_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (tenant_id, org_id, project_id)
      )`,
    ],
  },
  // Phase 2E: tenant-safe backpressure + fairness — a global capacity ceiling
  // so one tenant cannot exhaust shared execution capacity. Globally unique
  // migration name (dedup-by-name rule). The per-scope in_use counter already
  // enforces the per-tenant ceiling (Phase 1E); this adds a single global row
  // that bounds the sum across all tenants. A reservation that fits the
  // per-scope ceiling but exceeds the global ceiling is rejected honestly
  // (QUOTA_GLOBAL_FULL) — work is queued/admitted state, never silently dropped.
  {
    version: 5,
    name: "quota_global_capacity",
    statements: [
      `CREATE TABLE IF NOT EXISTS quota_global_capacity (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        max_concurrent INTEGER NOT NULL DEFAULT 0,
        in_use INTEGER NOT NULL DEFAULT 0
      )`,
      `INSERT INTO quota_global_capacity (id, max_concurrent, in_use) VALUES (1, 0, 0)
       ON CONFLICT (id) DO NOTHING`,
    ],
  },
]

interface ReservationRow {
  reservation_id: string
  tenant_id: string
  org_id: string
  project_id: string
  request_key: string
  job_id: string | null
  state: string
  version: number
  created_at: number
  settled_at: number | null
  released_at: number | null
  expires_at: number
  settled_tokens: number | null
  settled_duration_ms: number | null
  reason_code: string | null
}

interface LimitsRow {
  max_concurrent_jobs: number
  jobs_per_period: number
  period_ms: number
  max_tokens: number
  max_duration_ms: number
}

function toReservation(row: ReservationRow): QuotaReservation {
  return {
    reservationId: row.reservation_id,
    tenantId: row.tenant_id,
    orgId: row.org_id,
    projectId: row.project_id,
    requestKey: row.request_key,
    jobId: row.job_id,
    state: row.state as ReservationState,
    version: row.version,
    createdAt: row.created_at,
    settledAt: row.settled_at,
    releasedAt: row.released_at,
    expiresAt: row.expires_at,
    settledTokens: row.settled_tokens,
    settledDurationMs: row.settled_duration_ms,
    reasonCode: row.reason_code,
  }
}

function id(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`
}

export interface QuotaStoreOptions {
  readonly dialect?: SqlDialect
  readonly beforeCommit?: (op: string) => void
  /** Default reservation TTL (ms) before an active reservation expires. */
  readonly reservationTtlMs?: number
}

export class SqlQuotaStore extends SqlStoreBase {
  private readonly reservationTtlMs: number

  constructor(db: SqlDatabase, options: QuotaStoreOptions = {}) {
    super(db, QUOTA_MIGRATIONS, { ...(options.dialect ? { dialect: options.dialect } : {}), beforeCommit: options.beforeCommit })
    this.reservationTtlMs = options.reservationTtlMs ?? 3_600_000
  }

  async setLimits(scope: QuotaScope, limits: QuotaLimits): Promise<void> {
    this.atomic("setLimits", () => {
      this.prepare(
        `INSERT INTO quota_limits (tenant_id, org_id, project_id, max_concurrent_jobs, jobs_per_period, period_ms, max_tokens, max_duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, org_id, project_id) DO UPDATE SET
           max_concurrent_jobs = excluded.max_concurrent_jobs,
           jobs_per_period = excluded.jobs_per_period,
           period_ms = excluded.period_ms,
           max_tokens = excluded.max_tokens,
           max_duration_ms = excluded.max_duration_ms`,
      ).run(scope.tenantId, scope.orgId, scope.projectId, limits.maxConcurrentJobs, limits.jobsPerPeriod, limits.periodMs, limits.maxTokens, limits.maxDurationMs)
    })
  }

  async getLimits(scope: QuotaScope): Promise<QuotaLimits | null> {
    const row = this.prepare("SELECT * FROM quota_limits WHERE tenant_id = ? AND org_id = ? AND project_id = ?").get(scope.tenantId, scope.orgId, scope.projectId) as unknown as LimitsRow | undefined
    return row
      ? {
          maxConcurrentJobs: row.max_concurrent_jobs,
          jobsPerPeriod: row.jobs_per_period,
          periodMs: row.period_ms,
          maxTokens: row.max_tokens,
          maxDurationMs: row.max_duration_ms,
        }
      : null
  }

  /** Read-only usage snapshot (advisory; the counter is the source of truth
   * for capacity, but this is useful for dashboards). */
  async getUsage(scope: QuotaScope): Promise<{ inUse: number; activeReservations: number }> {
    const counter = this.prepare("SELECT in_use FROM quota_counters WHERE tenant_id = ? AND org_id = ? AND project_id = ?").get(scope.tenantId, scope.orgId, scope.projectId) as
      | { in_use: number }
      | undefined
    const active = this.prepare("SELECT COUNT(*) AS n FROM quota_reservations WHERE tenant_id = ? AND org_id = ? AND project_id = ? AND state = 'active'").get(scope.tenantId, scope.orgId, scope.projectId) as { n: number }
    return { inUse: counter?.in_use ?? 0, activeReservations: Number(active.n) }
  }

  async listReservations(scope: QuotaScope): Promise<QuotaReservation[]> {
    const rows = this.prepare("SELECT * FROM quota_reservations WHERE tenant_id = ? AND org_id = ? AND project_id = ? ORDER BY created_at ASC").all(scope.tenantId, scope.orgId, scope.projectId) as unknown as unknown as ReservationRow[]
    return rows.map(toReservation)
  }

  async getReservation(reservationId: string): Promise<QuotaReservation | null> {
    const row = this.prepare("SELECT * FROM quota_reservations WHERE reservation_id = ?").get(reservationId) as unknown as ReservationRow | undefined
    return row ? toReservation(row) : null
  }

  /**
   * Atomically reserve a slot. Idempotent on `requestKey`: a replay returns the
   * existing reservation without consuming more capacity. Throws
   * {@link QuotaError}("QUOTA_EXCEEDED") when capacity is full — and records a
   * durable 'rejected' reservation as proof of denial.
   */
  async reserve(scope: QuotaScope, requestKey: string, jobId: string | null, limits: QuotaLimits): Promise<QuotaReservation> {
    const now = Date.now()
    const expiresAt = now + this.reservationTtlMs
    return this.atomic("reserve", () => {
      // 1. Idempotent replay: an existing reservation for this request key.
      const existing = this.prepare("SELECT * FROM quota_reservations WHERE tenant_id = ? AND request_key = ?").get(scope.tenantId, requestKey) as unknown as ReservationRow | undefined
      if (existing) {
        return toReservation(existing)
      }

      // 2. Ensure the counter + period rows exist.
      this.prepare(
        `INSERT INTO quota_counters (tenant_id, org_id, project_id, in_use, period_started_at, period_count) VALUES (?, ?, ?, 0, ?, 0)
         ON CONFLICT (tenant_id, org_id, project_id) DO NOTHING`,
      ).run(scope.tenantId, scope.orgId, scope.projectId, now)
      this.prepare(
        `INSERT INTO usage_periods (tenant_id, org_id, project_id, period_started_at, period_count) VALUES (?, ?, ?, ?, 0)
         ON CONFLICT (tenant_id, org_id, project_id) DO NOTHING`,
      ).run(scope.tenantId, scope.orgId, scope.projectId, now)

      // 3. Roll the period window if expired; reset period_count.
      const period = this.prepare("SELECT period_started_at, period_count FROM usage_periods WHERE tenant_id = ? AND org_id = ? AND project_id = ?").get(scope.tenantId, scope.orgId, scope.projectId) as { period_started_at: number; period_count: number }
      if (now - period.period_started_at >= limits.periodMs) {
        this.prepare("UPDATE usage_periods SET period_started_at = ?, period_count = 0 WHERE tenant_id = ? AND org_id = ? AND project_id = ?").run(now, scope.tenantId, scope.orgId, scope.projectId)
      }
      if (period.period_count >= limits.jobsPerPeriod) {
        const rejectedId = id("res")
        this.prepare(
          "INSERT INTO quota_reservations (reservation_id, tenant_id, org_id, project_id, request_key, job_id, state, version, created_at, settled_at, released_at, expires_at, settled_tokens, settled_duration_ms, reason_code) VALUES (?, ?, ?, ?, ?, ?, 'rejected', 1, ?, NULL, NULL, ?, NULL, NULL, 'QUOTA_PERIOD_FULL')",
        ).run(rejectedId, scope.tenantId, scope.orgId, scope.projectId, requestKey, jobId, now, expiresAt)
        throw new QuotaError("QUOTA_PERIOD_FULL", `Period job limit (${limits.jobsPerPeriod}) reached for ${scope.orgId}/${scope.projectId}`)
      }

      // 4. Race-free capacity claim: conditional increment of in_use.
      const claim = this.prepare(
        "UPDATE quota_counters SET in_use = in_use + 1 WHERE tenant_id = ? AND org_id = ? AND project_id = ? AND in_use < ?",
      ).run(scope.tenantId, scope.orgId, scope.projectId, limits.maxConcurrentJobs)
      if (claim.changes === 0) {
        // Capacity full. Record a durable 'rejected' reservation (audit proof)
        // without bumping the counter, and throw.
        const rejectedId = id("res")
        this.prepare(
          "INSERT INTO quota_reservations (reservation_id, tenant_id, org_id, project_id, request_key, job_id, state, version, created_at, settled_at, released_at, expires_at, settled_tokens, settled_duration_ms, reason_code) VALUES (?, ?, ?, ?, ?, ?, 'rejected', 1, ?, NULL, NULL, ?, NULL, NULL, 'QUOTA_EXCEEDED')",
        ).run(rejectedId, scope.tenantId, scope.orgId, scope.projectId, requestKey, jobId, now, expiresAt)
        throw new QuotaError("QUOTA_EXCEEDED", `Concurrent job limit (${limits.maxConcurrentJobs}) reached for ${scope.orgId}/${scope.projectId}`)
      }

      // 4b. Phase 2E: global capacity ceiling (tenant-safe backpressure). A
      // reservation that fits the per-scope ceiling but exceeds the global
      // ceiling is rejected honestly — work is never silently dropped. The
      // per-scope claim is rolled back on global denial. When no global ceiling
      // is configured (max_concurrent = 0), this is a no-op.
      const global = this.prepare("SELECT max_concurrent, in_use FROM quota_global_capacity WHERE id = 1").get() as { max_concurrent: number; in_use: number } | undefined
      if (global && global.max_concurrent > 0) {
        const globalClaim = this.prepare(
          "UPDATE quota_global_capacity SET in_use = in_use + 1 WHERE id = 1 AND in_use < ?",
        ).run(global.max_concurrent)
        if (globalClaim.changes === 0) {
          // Roll back the per-scope claim and reject honestly.
          this.prepare("UPDATE quota_counters SET in_use = in_use - 1 WHERE tenant_id = ? AND org_id = ? AND project_id = ? AND in_use > 0").run(scope.tenantId, scope.orgId, scope.projectId)
          const rejectedId = id("res")
          this.prepare(
            "INSERT INTO quota_reservations (reservation_id, tenant_id, org_id, project_id, request_key, job_id, state, version, created_at, settled_at, released_at, expires_at, settled_tokens, settled_duration_ms, reason_code) VALUES (?, ?, ?, ?, ?, ?, 'rejected', 1, ?, NULL, NULL, ?, NULL, NULL, 'QUOTA_GLOBAL_FULL')",
          ).run(rejectedId, scope.tenantId, scope.orgId, scope.projectId, requestKey, jobId, now, expiresAt)
          throw new QuotaError("QUOTA_GLOBAL_FULL", `Global concurrent capacity (${global.max_concurrent}) reached`)
        }
      }

      // 5. Insert the active reservation. UNIQUE collisions are impossible here
      // (we checked), but defense-in-depth: roll back the claim on collision.
      const reservationId = id("res")
      try {
        this.prepare(
          "INSERT INTO quota_reservations (reservation_id, tenant_id, org_id, project_id, request_key, job_id, state, version, created_at, settled_at, released_at, expires_at, settled_tokens, settled_duration_ms, reason_code) VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?, NULL, NULL, ?, NULL, NULL, NULL)",
        ).run(reservationId, scope.tenantId, scope.orgId, scope.projectId, requestKey, jobId, now, expiresAt)
      } catch (error) {
        if (isUniqueViolation(error)) {
          // A concurrent reservation won the request_key race; undo the claim.
          this.prepare("UPDATE quota_counters SET in_use = in_use - 1 WHERE tenant_id = ? AND org_id = ? AND project_id = ?").run(scope.tenantId, scope.orgId, scope.projectId)
          if (global && global.max_concurrent > 0) {
            this.prepare("UPDATE quota_global_capacity SET in_use = in_use - 1 WHERE id = 1 AND in_use > 0").run()
          }
          const winner = this.prepare("SELECT * FROM quota_reservations WHERE tenant_id = ? AND request_key = ?").get(scope.tenantId, requestKey) as unknown as ReservationRow
          return toReservation(winner)
        }
        throw error
      }

      // 6. Increment period job count.
      this.prepare("UPDATE usage_periods SET period_count = period_count + 1 WHERE tenant_id = ? AND org_id = ? AND project_id = ?").run(scope.tenantId, scope.orgId, scope.projectId)

      const row = this.prepare("SELECT * FROM quota_reservations WHERE reservation_id = ?").get(reservationId) as unknown as ReservationRow
      return toReservation(row)
    })
  }

  /**
   * Attach the created job id to a reservation (admission creates the
   * reservation before the durable job; this links them afterwards). Idempotent.
   */
  async attachJob(reservationId: string, jobId: string): Promise<void> {
    this.atomic("attachJob", () => {
      this.prepare("UPDATE quota_reservations SET job_id = ? WHERE reservation_id = ? AND job_id IS NULL").run(jobId, reservationId)
    })
  }

  /**
   * Idempotently settle a reservation with actual usage and release unused
   * capacity. Fenced by `expectedVersion`: a stale writer (version mismatch) is
   * rejected and can never settle a newer reservation.
   */
  async settle(
    reservationId: string,
    expectedVersion: number,
    actual: { tokens: number; durationMs: number },
  ): Promise<QuotaReservation> {
    const now = Date.now()
    return this.atomic("settle", () => {
      const row = this.prepare("SELECT * FROM quota_reservations WHERE reservation_id = ?").get(reservationId) as unknown as ReservationRow | undefined
      if (!row) throw new QuotaError("RESERVATION_NOT_FOUND", `Reservation ${reservationId} not found`)
      if (row.state === "settled") return toReservation(row) // idempotent
      if (row.version !== expectedVersion) throw new QuotaError("RESERVATION_FENCED", `Reservation ${reservationId} is owned by a newer version`)
      if (row.state !== "active") {
        throw new QuotaError("INVALID_RESERVATION_STATE", `Cannot settle reservation in state "${row.state}"`)
      }
      const result = this.prepare(
        "UPDATE quota_reservations SET state = 'settled', settled_at = ?, settled_tokens = ?, settled_duration_ms = ?, version = version + 1 WHERE reservation_id = ? AND version = ?",
      ).run(now, actual.tokens, actual.durationMs, reservationId, expectedVersion)
      if (result.changes === 0) throw new QuotaError("RESERVATION_FENCED", `Reservation ${reservationId} is owned by a newer version`)
      // Release the unused capacity slot: settlement ends the reservation's
      // concurrency hold (per-scope + global).
      this.prepare("UPDATE quota_counters SET in_use = in_use - 1 WHERE tenant_id = ? AND org_id = ? AND project_id = ? AND in_use > 0").run(row.tenant_id, row.org_id, row.project_id)
      this.prepare("UPDATE quota_global_capacity SET in_use = in_use - 1 WHERE id = 1 AND in_use > 0").run()
      const updated = this.prepare("SELECT * FROM quota_reservations WHERE reservation_id = ?").get(reservationId) as unknown as ReservationRow
      return toReservation(updated)
    })
  }

  /**
   * Idempotently release an active reservation (e.g. failed admission
   * compensation or cancellation before settlement). Fenced by version. Stale
   * release is rejected and never decrements a newer reservation's capacity.
   */
  async release(reservationId: string, expectedVersion: number): Promise<QuotaReservation> {
    const now = Date.now()
    return this.atomic("release", () => {
      const row = this.prepare("SELECT * FROM quota_reservations WHERE reservation_id = ?").get(reservationId) as unknown as ReservationRow | undefined
      if (!row) throw new QuotaError("RESERVATION_NOT_FOUND", `Reservation ${reservationId} not found`)
      if (row.state === "released") return toReservation(row) // idempotent
      if (row.state === "settled") return toReservation(row) // settled reservations are not re-released
      if (row.version !== expectedVersion) throw new QuotaError("RESERVATION_FENCED", `Reservation ${reservationId} is owned by a newer version`)
      if (row.state !== "active") {
        throw new QuotaError("INVALID_RESERVATION_STATE", `Cannot release reservation in state "${row.state}"`)
      }
      const result = this.prepare(
        "UPDATE quota_reservations SET state = 'released', released_at = ?, version = version + 1 WHERE reservation_id = ? AND version = ?",
      ).run(now, reservationId, expectedVersion)
      if (result.changes === 0) throw new QuotaError("RESERVATION_FENCED", `Reservation ${reservationId} is owned by a newer version`)
      this.prepare("UPDATE quota_counters SET in_use = in_use - 1 WHERE tenant_id = ? AND org_id = ? AND project_id = ? AND in_use > 0").run(row.tenant_id, row.org_id, row.project_id)
      this.prepare("UPDATE quota_global_capacity SET in_use = in_use - 1 WHERE id = 1 AND in_use > 0").run()
      const updated = this.prepare("SELECT * FROM quota_reservations WHERE reservation_id = ?").get(reservationId) as unknown as ReservationRow
      return toReservation(updated)
    })
  }

  /** Mark expired active reservations released (reclaims their capacity).
   *
   * Phase 1F: the reaper is idempotent and fenced. It only transitions
   * `active` reservations whose `expires_at` has passed; a reservation that was
   * renewed (expiry pushed forward) or settled/released concurrently is skipped
   * by the `state = 'active' AND expires_at <= ?` predicate, so renewed or
   * settled work is NEVER reclaimed. Repeated reaper runs produce no
   * double-release: an already-`expired` row no longer matches the predicate.
   * Capacity is decremented at most once per reservation (per-scope + global). */
  async reapExpired(now: number = Date.now()): Promise<number> {
    return this.atomic("reapExpired", () => {
      const expired = this.prepare("SELECT reservation_id, tenant_id, org_id, project_id FROM quota_reservations WHERE state = 'active' AND expires_at <= ?").all(now) as Array<{
        reservation_id: string
        tenant_id: string
        org_id: string
        project_id: string
      }>
      for (const row of expired) {
        this.prepare("UPDATE quota_reservations SET state = 'expired', released_at = ?, version = version + 1 WHERE reservation_id = ? AND state = 'active'").run(now, row.reservation_id)
        this.prepare("UPDATE quota_counters SET in_use = in_use - 1 WHERE tenant_id = ? AND org_id = ? AND project_id = ? AND in_use > 0").run(row.tenant_id, row.org_id, row.project_id)
        this.prepare("UPDATE quota_global_capacity SET in_use = in_use - 1 WHERE id = 1 AND in_use > 0").run()
      }
      return expired.length
    })
  }

  /**
   * Renew (extend the expiry of) an active reservation for progressing work
   * (Phase 1F). This is the admission-reservation TTL refresh, distinct from
   * the execution ownership lease and the worker heartbeat (see docs). Fenced by
   * `expectedVersion`: a stale writer (version mismatch) is rejected and can
   * never extend a reservation it no longer owns. Renewing a settled/released/
   * expired reservation is rejected (it no longer holds capacity). Idempotent
   * only in the sense that re-renewing with the current version extends again;
   * callers must re-read the version after each renewal.
   */
  async renewReservation(reservationId: string, expectedVersion: number, extendMs: number): Promise<QuotaReservation> {
    const now = Date.now()
    return this.atomic("renewReservation", () => {
      const row = this.prepare("SELECT * FROM quota_reservations WHERE reservation_id = ?").get(reservationId) as unknown as ReservationRow | undefined
      if (!row) throw new QuotaError("RESERVATION_NOT_FOUND", `Reservation ${reservationId} not found`)
      if (row.version !== expectedVersion) throw new QuotaError("RESERVATION_FENCED", `Reservation ${reservationId} is owned by a newer version`)
      if (row.state !== "active") {
        throw new QuotaError("INVALID_RESERVATION_STATE", `Cannot renew reservation in state "${row.state}"`)
      }
      // Extend from the later of now and the current expiry so a renewal never
      // shortens an existing window (clock-skew safe).
      const base = Math.max(now, row.expires_at)
      const newExpiry = base + extendMs
      const result = this.prepare(
        "UPDATE quota_reservations SET expires_at = ?, version = version + 1 WHERE reservation_id = ? AND version = ? AND state = 'active'",
      ).run(newExpiry, reservationId, expectedVersion)
      if (result.changes === 0) throw new QuotaError("RESERVATION_FENCED", `Reservation ${reservationId} is owned by a newer version`)
      const updated = this.prepare("SELECT * FROM quota_reservations WHERE reservation_id = ?").get(reservationId) as unknown as ReservationRow
      return toReservation(updated)
    })
  }

  /** List active reservations whose TTL has elapsed (reaper candidates), for
   *  operational inspection. Does not mutate state. */
  async listExpiredActive(now: number = Date.now()): Promise<QuotaReservation[]> {
    const rows = this.prepare(
      "SELECT * FROM quota_reservations WHERE state = 'active' AND expires_at <= ?",
    ).all(now) as unknown as ReservationRow[]
    return rows.map(toReservation)
  }

  // -------------------------------------------------------------------------
  // Phase 2E: global capacity ceiling (tenant-safe backpressure + fairness).
  // -------------------------------------------------------------------------

  /** Set the global concurrent capacity ceiling. 0 disables the global ceiling
   *  (per-scope ceilings still apply). This bounds the SUM of in-use capacity
   *  across all tenants, so one tenant cannot exhaust shared execution
   *  capacity. A reservation that fits its per-scope ceiling but exceeds the
   *  global ceiling is rejected honestly (QUOTA_GLOBAL_FULL) — work is queued,
   *  never silently dropped. */
  async setGlobalCapacity(maxConcurrent: number): Promise<void> {
    this.atomic("setGlobalCapacity", () => {
      this.prepare("UPDATE quota_global_capacity SET max_concurrent = ? WHERE id = 1").run(Math.max(0, Math.floor(maxConcurrent)))
    })
  }

  /** Read-only global usage snapshot (advisory; the global counter is the
   *  source of truth for the global ceiling). */
  async getGlobalUsage(): Promise<{ maxConcurrent: number; inUse: number }> {
    const row = this.prepare("SELECT max_concurrent, in_use FROM quota_global_capacity WHERE id = 1").get() as { max_concurrent: number; in_use: number } | undefined
    return { maxConcurrent: row?.max_concurrent ?? 0, inUse: row?.in_use ?? 0 }
  }
}
