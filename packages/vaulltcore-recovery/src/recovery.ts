/**
 * Phase 2B recovery: concrete operational reapers + a stuck-run scanner.
 *
 * The scanner reads authoritative automation state and enqueues operational
 * work items for stuck/expired resources. The reapers (implementing the neutral
 * {@link OpsReaper} seam) process those items by calling the automation
 * service's existing recovery-safe methods. Neither the scanner nor the reapers
 * ever invoke agent execution — they only repair projections, expire approvals,
 * retry deliveries, and re-drive stuck runs via {@link AutomationService.reconcileRun}.
 *
 * Recovery algorithm (per the Phase 2B contract):
 *   1. inspect authoritative state (read-only scan);
 *   2. detect incomplete projections / expired resources;
 *   3. enqueue ops work items (idempotent on kind+targetRef);
 *   4. the ops worker claims + runs the matching reaper (fenced);
 *   5. reapers repair only safe projections / re-drive eligible work;
 *   6. historical evidence (events, audit) is preserved — never rewritten.
 *
 * Dependency direction: recovery → {automation, ops, store-sql, audit}. It
 * never depends on the runner or the control plane. The runner is unmodified.
 */

import type { AutomationService } from "@vaulltcore/automation"
import type { AutomationStore } from "@vaulltcore/automation"
import type { SqlAuditStore } from "@vaulltcore/audit"
import { SqlOpsStore } from "@vaulltcore/ops"
import type { OpsReaper, OpsWorkItem, OpsClaim, OpsWorkResult } from "@vaulltcore/ops"

/** The set of operational reapers bound to an automation store + service. */
export interface RecoveryReapers {
  readonly approvalExpiry: OpsReaper
  readonly deliveryRetry: OpsReaper
  readonly abandonedRun: OpsReaper
}

export interface RecoveryScannerOptions {
  readonly store: AutomationStore
  readonly opsStore: SqlOpsStore
  readonly audit: SqlAuditStore
  /** Tenant to scan. */
  readonly tenantId: string
  /** Max stuck runs to enqueue per scan (backpressure). Default 100. */
  readonly maxPerScan?: number
  readonly now?: () => number
}

/** Result of a recovery scan. */
export interface ScanResult {
  readonly enqueued: number
  readonly expiredApprovals: number
  readonly failedDeliveries: number
  readonly abandonedRuns: number
}

/**
 * Scans authoritative automation state and enqueues operational work items for
 * stuck/expired resources. The scan is read-only; it never mutates run state.
 * All repairs happen through the fenced ops worker + reapers.
 */
export class RecoveryScanner {
  private readonly store: AutomationStore
  private readonly opsStore: SqlOpsStore
  private readonly audit: SqlAuditStore
  private readonly tenantId: string
  private readonly maxPerScan: number
  private readonly now: () => number

  constructor(options: RecoveryScannerOptions) {
    this.store = options.store
    this.opsStore = options.opsStore
    this.audit = options.audit
    this.tenantId = options.tenantId
    this.maxPerScan = options.maxPerScan ?? 100
    this.now = options.now ?? Date.now
  }

  /** Run one scan. Enqueues ops work items for detected gaps. */
  async scan(): Promise<ScanResult> {
    const now = this.now()
    let expiredApprovals = 0
    let failedDeliveries = 0
    let abandonedRuns = 0
    let enqueued = 0

    // 1. Expired pending approvals (expires_at <= now).
    for (const a of await this.store.listExpiredApprovals(this.tenantId, now)) {
      const run = await this.store.getRun(this.tenantId, a.runId)
      if (!run) continue
      this.opsStore.enqueue({ id: `ops:approval_expiry:${a.approvalId}`, tenantId: this.tenantId, orgId: run.orgId, projectId: run.projectId, kind: "approval_expiry", targetRef: a.approvalId, idempotencyKey: `approval_expiry:${a.approvalId}` })
      expiredApprovals++
      enqueued++
    }

    // 2. Failed deliveries whose run is still in a delivery-capable state.
    for (const d of await this.store.listFailedDeliveriesForRetry(this.tenantId)) {
      const run = await this.store.getRun(this.tenantId, d.runId)
      if (!run) continue
      this.opsStore.enqueue({ id: `ops:delivery_retry:${d.deliveryId}`, tenantId: this.tenantId, orgId: run.orgId, projectId: run.projectId, kind: "delivery_retry", targetRef: `${d.runId}:${d.deliveryId}`, idempotencyKey: `delivery_retry:${d.deliveryId}` })
      failedDeliveries++
      enqueued++
    }

    // 3. Abandoned runs: non-terminal runs whose updated_at is older than a
    //    staleness threshold. Re-drive via reconcileRun (idempotent re-project +
    //    re-drive; dispatcher deduplicates on (runId, stepId)).
    const staleThreshold = now - 5 * 60_000 // 5 min
    for (const r of await this.store.listStaleRuns(this.tenantId, staleThreshold, this.maxPerScan)) {
      this.opsStore.enqueue({ id: `ops:abandoned_run:${r.runId}`, tenantId: this.tenantId, orgId: r.orgId, projectId: r.projectId, kind: "abandoned_run", targetRef: r.runId, idempotencyKey: `abandoned_run:${r.runId}` })
      abandonedRuns++
      enqueued++
    }

    await this.audit.append({
      actor: { principalId: "recovery-scanner", kind: "service_account", tenantId: this.tenantId },
      scope: { tenantId: this.tenantId },
      type: "automation_recovery_scan",
      metadata: { enqueued, expiredApprovals, failedDeliveries, abandonedRuns },
    })

    return { enqueued, expiredApprovals, failedDeliveries, abandonedRuns }
  }
}

/** Build the three concrete reapers. They call the automation store directly
 *  for expiry, and {@link AutomationService.reconcileRun} for re-drives. */
export function buildReapers(service: AutomationService, store: AutomationStore, now: () => number = Date.now): RecoveryReapers {
  const approvalExpiry: OpsReaper = {
    kind: "approval_expiry",
    async process(item: OpsWorkItem): Promise<OpsWorkResult> {
      const approval = await store.expireApproval(item.tenantId, item.targetRef, now())
      if (!approval) return { kind: "failed_terminal", reason: "approval_not_found" }
      return { kind: "succeeded" }
    },
  }

  const deliveryRetry: OpsReaper = {
    kind: "delivery_retry",
    async process(item: OpsWorkItem): Promise<OpsWorkResult> {
      const [runId, deliveryId] = item.targetRef.split(":")
      if (!runId || !deliveryId) return { kind: "failed_terminal", reason: "malformed_target_ref" }
      const run = await store.getRun(item.tenantId, runId)
      if (!run) return { kind: "failed_terminal", reason: "run_not_found" }
      try {
        await service.reconcileRun(adminPrincipal(item.tenantId, item.orgId, item.projectId), runId)
        return { kind: "succeeded" }
      } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown"
        return { kind: "failed_retriable", reason, retryClass: "transient", nextRetryAt: now() + 60_000 }
      }
    },
  }

  const abandonedRun: OpsReaper = {
    kind: "abandoned_run",
    async process(item: OpsWorkItem): Promise<OpsWorkResult> {
      try {
        await service.reconcileRun(adminPrincipal(item.tenantId, item.orgId, item.projectId), item.targetRef)
        return { kind: "succeeded" }
      } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown"
        return { kind: "failed_retriable", reason, retryClass: "transient", nextRetryAt: now() + 60_000 }
      }
    },
  }

  return { approvalExpiry, deliveryRetry, abandonedRun }
}

/** A system principal for privileged recovery re-drives. Recovery operates on
 *  durable state the caller already authenticated; the admin flag bypasses the
 *  internal projectScope check. It never exposes cross-tenant data through an
 *  API — recovery is an internal privileged worker, not a request path. */
function adminPrincipal(tenantId: string, orgId: string, projectId: string) {
  return {
    tenantId,
    orgId,
    projectId,
    principalId: "recovery-worker",
    kind: "service_account" as const,
    role: "service_account" as const,
    admin: true,
    projectScope: ["*"] as ReadonlyArray<string>,
  }
}

// Re-export for the worker wiring.
export type { OpsClaim, OpsWorkItem, OpsWorkResult }
