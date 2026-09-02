/**
 * SQL-backed admission idempotency registry (Phase 1F).
 *
 * Implements the claim/complete/fail state machine defined by the control
 * plane's {@link AdmissionIdempotencyRegistry} contract (matched structurally —
 * store-sql does not depend on the control package, preserving the dependency
 * direction Control → store-sql). The registry is the durable authority for
 * distributed admission idempotency:
 *
 * - `UNIQUE(tenant_id, idempotency_key)` is the linearization point: concurrent
 *   admissions across separate API processes serialize here, so exactly one
 *   caller wins the claim and proceeds to reserve quota + create a job.
 * - The request fingerprint distinguishes a legitimate replay (same fingerprint
 *   → return the original result) from a conflicting key reuse (different
 *   fingerprint → explicit 409, never a silent replay).
 * - Stale `failed_retriable` or expired records are reclaimable by a new claim.
 * - Only the SHA-256 fingerprint is stored; secret request material is never
 *   persisted.
 *
 * The state machine: pending → {completed | failed_retriable | failed_terminal}.
 * `completed` and `failed_terminal` are terminal (not reclaimable except by
 * expiry/TTL); `failed_retriable` is reclaimable by a fresh claim.
 */

import { MIGRATIONS } from "./migrations"
import { SqlStoreBase, type SqlStoreBaseOptions } from "./store-base"
import type { SqlDatabase } from "./driver"

export type AdmissionIdempotencyState = "pending" | "completed" | "failed_retriable" | "failed_terminal"

export interface AdmissionIdempotencyRecord {
  readonly tenantId: string
  readonly key: string
  readonly fingerprint: string
  readonly state: AdmissionIdempotencyState
  readonly jobId: string | null
  readonly reservationId: string | null
  readonly failureCode: string | null
  readonly failureDetail: string | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly expiresAt: number | null
}

export type AdmissionIdempotencyClaimResult =
  | { readonly kind: "new"; readonly slot: AdmissionIdempotencyRecord }
  | { readonly kind: "completed"; readonly slot: AdmissionIdempotencyRecord }
  | { readonly kind: "pending"; readonly slot: AdmissionIdempotencyRecord }
  | { readonly kind: "conflict"; readonly slot: AdmissionIdempotencyRecord; readonly detail: string }

interface Row {
  tenant_id: string
  idempotency_key: string
  fingerprint: string
  state: string
  job_id: string | null
  reservation_id: string | null
  failure_code: string | null
  failure_detail: string | null
  created_at: number
  updated_at: number
  expires_at: number | null
}

function toRecord(r: Row): AdmissionIdempotencyRecord {
  return {
    tenantId: r.tenant_id,
    key: r.idempotency_key,
    fingerprint: r.fingerprint,
    state: r.state as AdmissionIdempotencyState,
    jobId: r.job_id,
    reservationId: r.reservation_id,
    failureCode: r.failure_code,
    failureDetail: r.failure_detail,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    expiresAt: r.expires_at,
  }
}

/** Durable admission idempotency registry over the shared SQL database. */
export class SqlAdmissionIdempotencyRegistry extends SqlStoreBase {
  constructor(db: SqlDatabase, options: SqlStoreBaseOptions = {}) {
    super(db, MIGRATIONS, options)
  }

  /** Atomically claim an admission idempotency slot. */
  claim(tenantId: string, key: string, fingerprint: string): Promise<AdmissionIdempotencyClaimResult> {
    const now = Date.now()
    const result = this.atomic("admission_idem_claim", (): AdmissionIdempotencyClaimResult => {
      const row = this.prepare(
        "SELECT tenant_id, idempotency_key, fingerprint, state, job_id, reservation_id, failure_code, failure_detail, created_at, updated_at, expires_at FROM admission_idempotency WHERE tenant_id = ? AND idempotency_key = ?",
      ).get(tenantId, key) as Row | undefined
      if (row) {
        const reclaimable =
          row.state === "failed_retriable" || (row.expires_at !== null && row.expires_at < now)
        if (!reclaimable) {
          const slot = toRecord(row)
          if (row.fingerprint !== fingerprint) {
            return { kind: "conflict", slot, detail: "idempotency key reused with a different request body" }
          }
          if (row.state === "completed") return { kind: "completed", slot }
          return { kind: "pending", slot }
        }
        // Reclaimable: overwrite as a fresh pending slot.
        this.prepare(
          "UPDATE admission_idempotency SET fingerprint = ?, state = 'pending', job_id = NULL, reservation_id = NULL, failure_code = NULL, failure_detail = NULL, created_at = ?, updated_at = ?, expires_at = NULL WHERE tenant_id = ? AND idempotency_key = ?",
        ).run(fingerprint, now, now, tenantId, key)
        const fresh: AdmissionIdempotencyRecord = {
          tenantId,
          key,
          fingerprint,
          state: "pending",
          jobId: null,
          reservationId: null,
          failureCode: null,
          failureDetail: null,
          createdAt: now,
          updatedAt: now,
          expiresAt: null,
        }
        return { kind: "new", slot: fresh }
      }
      // No prior record: insert a pending slot. UNIQUE(tenant_id, idempotency_key)
      // serializes concurrent inserts; a loser raises a constraint violation
      // caught below and retried as a re-read.
      this.prepare(
        "INSERT INTO admission_idempotency (tenant_id, idempotency_key, fingerprint, state, job_id, reservation_id, failure_code, failure_detail, created_at, updated_at, expires_at) VALUES (?, ?, ?, 'pending', NULL, NULL, NULL, NULL, ?, ?, NULL)",
      ).run(tenantId, key, fingerprint, now, now)
      const slot: AdmissionIdempotencyRecord = {
        tenantId,
        key,
        fingerprint,
        state: "pending",
        jobId: null,
        reservationId: null,
        failureCode: null,
        failureDetail: null,
        createdAt: now,
        updatedAt: now,
        expiresAt: null,
      }
      return { kind: "new", slot }
    })
    return Promise.resolve(result)
  }

  /** Mark a claimed slot completed with the created job + reservation. */
  complete(tenantId: string, key: string, jobId: string, reservationId: string): Promise<AdmissionIdempotencyRecord | null> {
    const now = Date.now()
    const result = this.atomic("admission_idem_complete", (): AdmissionIdempotencyRecord | null => {
      const row = this.prepare(
        "SELECT tenant_id, idempotency_key, fingerprint, state, job_id, reservation_id, failure_code, failure_detail, created_at, updated_at, expires_at FROM admission_idempotency WHERE tenant_id = ? AND idempotency_key = ?",
      ).get(tenantId, key) as Row | undefined
      if (!row) return null
      // Only transition pending/failed_retriable -> completed. A terminal slot
      // is never resurrected; a completed slot is idempotent (no-op update).
      if (row.state === "failed_terminal") return toRecord(row)
      this.prepare(
        "UPDATE admission_idempotency SET state = 'completed', job_id = ?, reservation_id = ?, failure_code = NULL, failure_detail = NULL, updated_at = ? WHERE tenant_id = ? AND idempotency_key = ?",
      ).run(jobId, reservationId, now, tenantId, key)
      return { ...toRecord(row), state: "completed", jobId, reservationId, failureCode: null, failureDetail: null, updatedAt: now }
    })
    return Promise.resolve(result)
  }

  /** Mark a claimed slot failed. `retriable=false` pins the slot terminal. */
  fail(tenantId: string, key: string, code: string, detail: string, retriable: boolean): Promise<AdmissionIdempotencyRecord | null> {
    const now = Date.now()
    const state = retriable ? "failed_retriable" : "failed_terminal"
    const result = this.atomic("admission_idem_fail", (): AdmissionIdempotencyRecord | null => {
      const row = this.prepare(
        "SELECT tenant_id, idempotency_key, fingerprint, state, job_id, reservation_id, failure_code, failure_detail, created_at, updated_at, expires_at FROM admission_idempotency WHERE tenant_id = ? AND idempotency_key = ?",
      ).get(tenantId, key) as Row | undefined
      if (!row) return null
      // A completed slot is never moved back to failed.
      if (row.state === "completed") return toRecord(row)
      this.prepare(
        "UPDATE admission_idempotency SET state = ?, failure_code = ?, failure_detail = ?, updated_at = ? WHERE tenant_id = ? AND idempotency_key = ?",
      ).run(state, code, detail, now, tenantId, key)
      return { ...toRecord(row), state, failureCode: code, failureDetail: detail, updatedAt: now }
    })
    return Promise.resolve(result)
  }

  /** Read a record (no state transition). */
  lookup(tenantId: string, key: string): Promise<AdmissionIdempotencyRecord | null> {
    const row = this.prepare(
      "SELECT tenant_id, idempotency_key, fingerprint, state, job_id, reservation_id, failure_code, failure_detail, created_at, updated_at, expires_at FROM admission_idempotency WHERE tenant_id = ? AND idempotency_key = ?",
    ).get(tenantId, key) as Row | undefined
    return Promise.resolve(row ? toRecord(row) : null)
  }
}
