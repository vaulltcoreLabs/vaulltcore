/**
 * Idempotency registry for POST /jobs (Phase 1C/1D). Repeating a POST with the
 * same authenticated identity and the same `Idempotency-Key` returns the same
 * logical job instead of creating duplicate work.
 *
 * Phase 1D upgrades the contract to a claim/fulfill model with request-hash
 * conflict detection: same tenant + same key + same request hash returns the
 * original job; a *different* request body under the same key is an explicit
 * conflict (409). The claim and the job creation must be transactional so a
 * crash after job creation cannot produce a duplicate on retry.
 *
 * The registry interface is the neutral runner contract
 * ({@link IdempotencyRegistry}); the in-memory map below is the test/local
 * default, and production wiring backs it by the SQL store
 * ({@link SqlIdempotencyRegistry} in `@vaulltcore/store-sql`), where the
 * `UNIQUE(tenant_id, idempotency_key)` constraint serializes concurrent claims
 * across separate control-plane processes.
 */

import { createHash } from "node:crypto"
import type { IdempotencyClaim, IdempotencyClaimResult, IdempotencyRegistry } from "@vaulltcore/runner"

export type { IdempotencyClaim, IdempotencyClaimResult, IdempotencyRegistry }

/** Compute a stable SHA-256 request hash over a canonicalized body. */
export function requestHashFor(body: unknown): string {
  return createHash("sha256").update(stableString(body)).digest("hex")
}

/** In-memory registry for tests/local single-process deployment. */
export class InMemoryIdempotencyRegistry implements IdempotencyRegistry {
  private readonly entries = new Map<string, { requestHash: string; jobId: string | null; responseStatus: number | null }>()
  private composite(tenantId: string, key: string): string {
    return `${tenantId}${key}`
  }
  claim(claim: IdempotencyClaim): IdempotencyClaimResult {
    const k = this.composite(claim.tenantId, claim.key)
    const existing = this.entries.get(k)
    if (existing) {
      if (existing.requestHash !== claim.requestHash) {
        return { kind: "conflict", jobId: existing.jobId, detail: "idempotency key reused with a different request body" }
      }
      if (existing.jobId !== null && existing.responseStatus !== null) {
        return { kind: "fulfilled", jobId: existing.jobId, responseStatus: existing.responseStatus }
      }
      return { kind: "pending", slotId: k }
    }
    this.entries.set(k, { requestHash: claim.requestHash, jobId: null, responseStatus: null })
    return { kind: "new", slotId: k }
  }
  fulfill(slotId: string, jobId: string, responseStatus: number): void {
    const existing = this.entries.get(slotId)
    if (existing) {
      existing.jobId = jobId
      existing.responseStatus = responseStatus
    } else {
      // Slot vanished: re-create as fulfilled so the result is durable.
      this.entries.set(slotId, { requestHash: "", jobId, responseStatus })
    }
  }
  lookup(tenantId: string, key: string): { jobId: string; responseStatus: number | null } | null {
    const e = this.entries.get(this.composite(tenantId, key))
    if (!e || e.jobId === null) return null
    return { jobId: e.jobId, responseStatus: e.responseStatus }
  }
  get(tenantId: string, key: string): { tenantId: string; key: string; requestHash: string; jobId: string | null; responseStatus: number | null; createdAt: number; expiresAt: number | null } | null {
    const e = this.entries.get(this.composite(tenantId, key))
    if (!e) return null
    return { tenantId, key, requestHash: e.requestHash, jobId: e.jobId, responseStatus: e.responseStatus, createdAt: 0, expiresAt: null }
  }
  delete(tenantId: string, key: string): void {
    this.entries.delete(this.composite(tenantId, key))
  }
}

function stableString(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableString).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableString(v)}`)
  return `{${entries.join(",")}}`
}
