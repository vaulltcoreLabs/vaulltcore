/**
 * Operator redrive service (Phase 2E).
 *
 * A single, authorized, tenant-safe redrive entry point for both ops work items
 * and dead-lettered trigger dispatches. Redrive is:
 *   - explicit (operator-authorized; the control plane checks role before call)
 *   - tenant-isolated (every operation is tenant-scoped; cross-tenant = 404)
 *   - idempotent (redriving an already-re-armed item is a no-op; never creates
 *     duplicate durable identities)
 *   - never auto-retries permanent policy/auth/quota rejection (terminal states
 *     are never resurrected)
 *   - audited (emits a redriven telemetry event)
 *
 * Never exposes secrets or raw credentials in diagnostics.
 */

import type { SqlOpsStore } from "@vaulltcore/ops"
import type { SqlTriggerStore } from "@vaulltcore/automation"
import type { TelemetrySink } from "./telemetry"

export interface RedriveServiceOptions {
  readonly opsStore: SqlOpsStore
  readonly triggerStore?: SqlTriggerStore
  readonly telemetry?: TelemetrySink
  readonly tenantId: string
  readonly now?: () => number
}

/** Result of a redrive operation. */
export interface RedriveResult {
  readonly kind: "ops" | "dispatch"
  readonly itemId: string
  readonly reArmed: boolean
  /** The post-redrive state (for diagnostics). */
  readonly state: string
}

/**
 * Redrive dead-lettered / stuck work. Operates on a single item id (the caller
 * specifies the kind). Idempotent: redriving terminal succeeded/failed_terminal
 * ops work or run_created/rejected dispatches is a no-op (never resurrects).
 */
export class RedriveService {
  private readonly opsStore: SqlOpsStore
  private readonly triggerStore?: SqlTriggerStore
  private readonly telemetry?: TelemetrySink
  private readonly tenantId: string
  private readonly now: () => number

  constructor(options: RedriveServiceOptions) {
    this.opsStore = options.opsStore
    this.triggerStore = options.triggerStore
    this.telemetry = options.telemetry
    this.tenantId = options.tenantId
    this.now = options.now ?? Date.now
  }

  /** Redrive an ops work item (dead-lettered or stuck failed_retriable). */
  async redriveOps(itemId: string): Promise<RedriveResult> {
    const before = this.opsStore.get(this.tenantId, itemId)
    const now = this.now()
    const updated = this.opsStore.redrive(this.tenantId, itemId, now)
    if (!updated) return { kind: "ops", itemId, reArmed: false, state: "not_found" }
    const reArmed = before?.state === "dead_letter" || before?.state === "failed_retriable"
    await this.telemetry?.emit({
      tenantId: this.tenantId,
      orgId: updated.orgId,
      projectId: updated.projectId,
      type: "work_redriven",
      metadata: { kind: "ops", itemId, fromState: before?.state ?? "unknown", toState: updated.state, reArmed },
    })
    return { kind: "ops", itemId, reArmed, state: updated.state }
  }

  /** Redrive a dead-lettered trigger dispatch (re-arm to retryable_failure). */
  async redriveDispatch(dispatchId: string): Promise<RedriveResult> {
    if (!this.triggerStore) throw new Error("trigger store not wired for redrive")
    const before = await this.triggerStore.getDispatch(this.tenantId, dispatchId)
    const now = this.now()
    const updated = await this.triggerStore.redriveDeadLetter(this.tenantId, dispatchId, now)
    if (!updated) return { kind: "dispatch", itemId: dispatchId, reArmed: false, state: "not_found" }
    const reArmed = before?.state === "dead_letter"
    await this.telemetry?.emit({
      tenantId: this.tenantId,
      orgId: updated.orgId,
      projectId: updated.projectId,
      type: "work_redriven",
      metadata: { kind: "dispatch", dispatchId, fromState: before?.state ?? "unknown", toState: updated.state, reArmed },
    })
    return { kind: "dispatch", itemId: dispatchId, reArmed, state: updated.state }
  }
}
