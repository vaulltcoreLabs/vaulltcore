/**
 * Trigger → Run dispatch service (Phase 2D).
 *
 * The critical Phase 2D pipeline, operating AFTER durable webhook persistence:
 *
 *   normalized event (durable)
 *     → find eligible triggers (durable revisions active now)
 *     → deterministic match (declarative criteria only)
 *     → reserve durable dispatch identity (UNIQUE per event/trigger)
 *     → admission pipeline (policy/quota) — NEVER bypassed
 *     → automation run creation (Phase 2A, idempotent on triggerId)
 *     → existing execution lifecycle (at-least-once)
 *
 * This boundary is exactly-once: one dispatch record per
 * (tenant, source_event_id, trigger_revision). A crash after dispatch
 * reservation but before run projection recovers by reconciliation/re-drive,
 * NOT by blindly creating another dispatch.
 *
 * A policy/quota rejection is recorded honestly (state `rejected`, kind
 * `policy`/`quota`); it is NEVER silently retried as infrastructure failure.
 * A retryable infrastructure failure (transient) transitions to
 * `retryable_failure` and is re-driven by the recovery worker.
 *
 * Dependency direction: dispatch → {trigger-store, automation (types), audit,
 * identity (types)}. It never imports the runner directly; it drives run
 * creation through a narrow {@link TriggerRunSink} seam the control plane
 * implements over {@link AutomationService.createRun}.
 */

import type { NormalizedEvent } from "@vaulltcore/integration"
import type { SqlTriggerStore, TriggerDispatch, DispatchRejectionKind } from "./trigger-store"
import type { TriggerDefinition } from "./trigger"
import type { SqlAuditStore } from "@vaulltcore/audit"
import { sanitizeMetadata } from "@vaulltcore/audit"

/**
 * Narrow seam the control plane implements: create an automation run for a
 * matched trigger through the admission boundary. MUST be idempotent on
 * triggerId — a replay returns the original run. The sink MUST surface
 * policy/quota denials as typed rejections (never silently swallow them).
 */
export interface TriggerRunSink {
  createRunForTrigger(args: {
    readonly tenantId: string
    readonly orgId: string
    readonly projectId: string
    readonly triggerId: string
    readonly triggerRevision: number
    readonly templateId: string
    readonly versionId: string
    readonly dispatchId: string
    readonly event: NormalizedEvent
    readonly inputMapping: Readonly<Record<string, unknown>>
  }): Promise<{ runId: string | null; rejection?: TriggerRunRejection }>
}

/** A typed admission rejection surfaced from the sink. */
export interface TriggerRunRejection {
  readonly kind: DispatchRejectionKind
  readonly reason: string
}

export interface TriggerDispatchServiceOptions {
  readonly store: SqlTriggerStore
  readonly sink: TriggerRunSink
  readonly audit?: SqlAuditStore
  /** Max attempts before dead-lettering a retryable dispatch. */
  readonly maxAttempts?: number
  /** Phase 2E: fenced redrive lease duration (ms). Default 60s. */
  readonly redriveLeaseMs?: number
}

export interface DispatchEventResult {
  readonly dispatches: readonly TriggerDispatch[]
  /** Dispatch ids that produced a run. */
  readonly runIds: readonly string[]
}

export class TriggerDispatchService {
  private readonly store: SqlTriggerStore
  private readonly sink: TriggerRunSink
  private readonly audit?: SqlAuditStore
  private readonly maxAttempts: number
  private readonly redriveLeaseMs: number

  constructor(options: TriggerDispatchServiceOptions) {
    this.store = options.store
    this.sink = options.sink
    this.audit = options.audit
    this.maxAttempts = options.maxAttempts ?? 5
    this.redriveLeaseMs = options.redriveLeaseMs ?? 60_000
  }

  /**
   * Dispatch a single durable event: match triggers, reserve dispatches
   * idempotently, drive each through admission → run creation. A duplicate
   * event (same sourceEventId) returns the existing dispatches without
   * creating new work. One event matching N triggers creates N dispatches
   * (one per trigger identity).
   */
  async dispatchEvent(event: NormalizedEvent): Promise<DispatchEventResult> {
    const triggers = await this.store.matchTriggers({
      tenantId: event.tenantId,
      provider: event.provider,
      kind: event.kind,
      resource: event.resource,
      action: event.action,
    })
    const dispatches: TriggerDispatch[] = []
    const runIds: string[] = []
    for (const trigger of triggers) {
      const { dispatch, created } = await this.store.reserveDispatch({
        tenantId: event.tenantId,
        orgId: event.orgId,
        projectId: event.projectId,
        sourceEventId: event.eventId,
        trigger,
      })
      dispatches.push(dispatch)
      // A duplicate match (already reserved) — do not re-drive if terminal.
      if (!created) {
        if (dispatch.automationRunId) runIds.push(dispatch.automationRunId)
        continue
      }
      // Drive the dispatch through admission → run creation.
      const driven = await this.driveDispatch(dispatch, trigger, event)
      if (driven) runIds.push(driven)
    }
    return { dispatches, runIds }
  }

  /**
   * Drive a single dispatch through the admission boundary. Honors:
   * - disabled triggers → rejected (kind disabled_trigger), no run.
   * - policy/quota rejection → rejected honestly, never retried as infra.
   * - retryable infra failure → retryable_failure (re-driveable).
   * - crash recovery → re-drive idempotent on dispatchId.
   */
  async driveDispatch(dispatch: TriggerDispatch, trigger: TriggerDefinition, event: NormalizedEvent): Promise<string | null> {
    if (trigger.state === "disabled") {
      await this.store.markRejected(dispatch.tenantId, dispatch.dispatchId, "disabled_trigger", "trigger is disabled")
      await this.auditDispatch(dispatch, "trigger_rejected", { reason: "disabled_trigger" })
      return null
    }
    // dispatching
    await this.store.transitionDispatch(dispatch.tenantId, dispatch.dispatchId, dispatch.state, "dispatching")
    try {
      const result = await this.sink.createRunForTrigger({
        tenantId: dispatch.tenantId,
        orgId: dispatch.orgId,
        projectId: dispatch.projectId,
        triggerId: trigger.triggerId,
        triggerRevision: trigger.revision,
        templateId: trigger.templateId,
        versionId: trigger.versionId,
        dispatchId: dispatch.dispatchId,
        event,
        inputMapping: trigger.inputMapping,
      })
      if (result.rejection) {
        await this.store.markRejected(dispatch.tenantId, dispatch.dispatchId, result.rejection.kind, result.rejection.reason)
        await this.auditDispatch(dispatch, "trigger_rejected", { reason: result.rejection.kind, detail: result.rejection.reason })
        return null
      }
      if (result.runId) {
        await this.store.markRunCreated(dispatch.tenantId, dispatch.dispatchId, result.runId)
        await this.auditDispatch(dispatch, "trigger_dispatched", { runId: result.runId })
        return result.runId
      }
      // No run and no rejection — treat as retryable (unexpected).
      await this.store.markRetryable(dispatch.tenantId, dispatch.dispatchId, "sink returned no run and no rejection")
      return null
    } catch (error) {
      const msg = error instanceof Error ? error.message : "unknown"
      await this.store.markRetryable(dispatch.tenantId, dispatch.dispatchId, msg)
      return null
    }
  }

  /**
   * Re-drive non-terminal dispatches (recovery). A crashed dispatch is
   * re-driven under a FENCED lease (Phase 2E): claimRedriveDispatch stamps a
   * redrive_generation; a stale owner whose generation was superseded cannot
   * finalize. The dispatch identity is unique, so re-driving never creates a
   * duplicate dispatch. After maxAttempts, dead-letter honestly. A terminal
   * dispatch (run_created/rejected/dead_letter) is never claimed — a late retry
   * cannot resurrect terminal work.
   */
  async redrive(tenantId: string, limit = 100, owner = `redrive-${Date.now()}`): Promise<{ driven: number; created: number; failed: number }> {
    const stranded = await this.store.listStrandedDispatches(tenantId, limit)
    let driven = 0
    let created = 0
    let failed = 0
    const now = Date.now()
    for (const dispatch of stranded) {
      // Claim a fenced redrive lease. A terminal dispatch (concurrently
      // finalized) returns null — skip it (never resurrect).
      const lease = await this.store.claimRedriveDispatch(tenantId, dispatch.dispatchId, owner, this.redriveLeaseMs, now)
      if (!lease) continue
      driven++
      if (dispatch.attempts >= this.maxAttempts) {
        await this.store.deadLetter(tenantId, dispatch.dispatchId, `exhausted ${this.maxAttempts} attempts`)
        await this.store.releaseRedriveLease(tenantId, dispatch.dispatchId, lease.generation, now)
        await this.auditDispatch(dispatch, "trigger_dead_lettered", { attempts: dispatch.attempts })
        failed++
        continue
      }
      const trigger = await this.store.getTrigger(tenantId, dispatch.triggerId)
      if (!trigger) {
        await this.store.markRejected(tenantId, dispatch.dispatchId, "no_trigger", "trigger definition no longer exists")
        await this.store.releaseRedriveLease(tenantId, dispatch.dispatchId, lease.generation, now)
        failed++
        continue
      }
      // Re-hydrate a minimal event from the dispatch's source. The full event
      // payload is held by the durable webhook store; recovery re-derives the
      // match identity from the trigger revision (pinned into the dispatch).
      const event: NormalizedEvent = {
        eventId: dispatch.sourceEventId,
        tenantId: dispatch.tenantId,
        orgId: dispatch.orgId,
        projectId: dispatch.projectId,
        provider: trigger.criteria?.provider ?? "",
        providerEventId: dispatch.sourceEventId,
        kind: "custom",
        resource: "",
        action: null,
        actor: null,
        payload: {},
        providerTimestamp: null,
        receivedAt: dispatch.createdAt,
      }
      const runId = await this.driveDispatch(dispatch, trigger, event)
      // Release the lease (driveDispatch already advanced the state; a terminal
      // dispatch's lease was cleared by markRunCreated/markRejected).
      await this.store.releaseRedriveLease(tenantId, dispatch.dispatchId, lease.generation, now)
      if (runId) created++
    }
    return { driven, created, failed }
  }

  private async auditDispatch(dispatch: TriggerDispatch, type: string, metadata: Record<string, unknown>): Promise<void> {
    await this.audit?.append({
      actor: { principalId: "trigger-dispatch", kind: "service_account", tenantId: dispatch.tenantId },
      scope: { tenantId: dispatch.tenantId, orgId: dispatch.orgId, projectId: dispatch.projectId },
      type: type as never,
      metadata: sanitizeMetadata({ dispatchId: dispatch.dispatchId, triggerId: dispatch.triggerId, ...metadata }),
    }).catch(() => {})
  }
}
