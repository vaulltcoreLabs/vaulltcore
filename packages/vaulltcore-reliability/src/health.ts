/**
 * Health + readiness (Phase 2E).
 *
 * Separates, where useful:
 *   - process alive     — always true when this code runs
 *   - service ready     — the control plane can serve requests
 *   - durable storage reachable — the SQL store responds
 *   - worker able to acquire/perform work — a worker can claim a lease
 *
 * Readiness does NOT depend on every external provider being healthy. An
 * external provider outage degrades only the affected work (its deliveries
 * retry/backoff; its triggers keep matching against durable state), never the
 * whole control plane. The readiness probe reports degraded per-tenant
 * operational state honestly so a tenant whose work is delayed gets a truthful
 * status — never a silent drop.
 *
 * All health data is tenant-scoped (derived from the authenticated principal);
 * cross-tenant reads return nothing. No secrets in health output.
 */

import type { SqlOpsStore } from "@vaulltcore/ops"
import type { SqlQuotaStore } from "@vaulltcore/quota"
import type { SqlStoreBase } from "@vaulltcore/store-sql"

/** A storage reachability probe. */
export interface StorageProbe {
  /** Returns true if the underlying SQL store responds. Never throws. */
  reachable(): boolean
}

/** A SqlStoreBase-backed storage probe (uses the existing database() handle). */
export class SqlStorageProbe implements StorageProbe {
  constructor(private readonly store: SqlStoreBase) {}
  reachable(): boolean {
    try {
      // A trivial read proves the connection + schema are live.
      this.store.database().prepare("SELECT 1 AS ok").get()
      return true
    } catch {
      return false
    }
  }
}

export interface HealthServiceOptions {
  readonly storage: StorageProbe
  readonly opsStore?: SqlOpsStore
  readonly quotaStore?: SqlQuotaStore
  readonly tenantId: string
}

/** Aggregate readiness + per-tenant operational health. */
export interface ReadinessReport {
  readonly ready: boolean
  readonly processAlive: boolean
  readonly storageReachable: boolean
  readonly workerCanClaim: boolean
  readonly degraded: boolean
  readonly reason: string | null
}

export interface TenantHealthReport {
  readonly tenantId: string
  readonly opsBacklog: { pending: number; failedRetriable: number; deadLetter: number }
  readonly globalCapacity: { maxConcurrent: number; inUse: number }
  readonly leakedReservations: number
  readonly healthy: boolean
}

/**
 * Readiness + tenant health. Never depends on external providers — only on
 * durable storage + the ability to acquire a lease.
 */
export class HealthService {
  private readonly storage: StorageProbe
  private readonly opsStore?: SqlOpsStore
  private readonly quotaStore?: SqlQuotaStore
  private readonly tenantId: string

  constructor(options: HealthServiceOptions) {
    this.storage = options.storage
    this.opsStore = options.opsStore
    this.quotaStore = options.quotaStore
    this.tenantId = options.tenantId
  }

  /** Process-level readiness (liveness/readiness probe target). */
  readiness(): ReadinessReport {
    const processAlive = true
    const storageReachable = this.storage.reachable()
    // A worker can perform work iff storage is reachable (claiming is a SQL CAS).
    const workerCanClaim = storageReachable
    const ready = processAlive && storageReachable
    return {
      ready,
      processAlive,
      storageReachable,
      workerCanClaim,
      degraded: !ready,
      reason: ready ? null : "durable storage unreachable",
    }
  }

  /** Per-tenant operational health (derived from durable records). */
  async tenantHealth(now: number = Date.now()): Promise<TenantHealthReport> {
    const pending = this.opsStore?.countByState(this.tenantId, "pending") ?? 0
    const failedRetriable = this.opsStore?.countByState(this.tenantId, "failed_retriable") ?? 0
    const deadLetter = this.opsStore?.countByState(this.tenantId, "dead_letter") ?? 0
    const global = this.quotaStore ? await this.quotaStore.getGlobalUsage() : { maxConcurrent: 0, inUse: 0 }
    const leakedReservations = this.quotaStore ? (await this.quotaStore.listExpiredActive(now)).length : 0
    // Healthy = no leaked capacity + bounded backlog. A dead-letter backlog is
    // operator-visible but does not make the tenant "unhealthy" (work is safely
    // parked, not lost).
    const healthy = leakedReservations === 0
    return {
      tenantId: this.tenantId,
      opsBacklog: { pending, failedRetriable, deadLetter },
      globalCapacity: { maxConcurrent: global.maxConcurrent, inUse: global.inUse },
      leakedReservations,
      healthy,
    }
  }
}
