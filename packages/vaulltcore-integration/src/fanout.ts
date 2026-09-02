/**
 * Fan-out service (Phase 2C).
 *
 * Given a persisted normalized event, find matching subscriptions and record
 * idempotent triggers. The actual automation-run creation is delegated to a
 * narrow {@link AutomationTriggerSink} seam (implemented by the control plane
 * over the Phase 2A automation service) so the integration layer never imports
 * automation internals and never invokes agent execution directly.
 *
 * Guarantees:
 * - A duplicate event (same providerEventId) is deduplicated at persist time.
 * - A duplicate match (same subscription+event) is deduplicated at trigger time.
 * - A trigger is driven at-least-once; its settlement (automation run created)
 *   is idempotent on the trigger id.
 * - Recovery re-drives pending triggers; never invokes the agent to repair.
 */

import type { SqlSubscriptionStore } from "./subscriptions"
import type { NormalizedEvent } from "./contracts"

/**
 * Narrow seam the control plane implements: create an automation run for a
 * trigger. MUST be idempotent on triggerId — a replay returns the original run.
 */
export interface AutomationTriggerSink {
  createRunForTrigger(args: {
    readonly tenantId: string
    readonly orgId: string
    readonly projectId: string
    readonly automationTemplateId: string
    readonly triggerId: string
    readonly event: NormalizedEvent
    readonly inputMapping: Readonly<Record<string, unknown>>
  }): Promise<{ automationRunId: string }>
}

export interface FanOutOptions {
  readonly store: SqlSubscriptionStore
  readonly sink: AutomationTriggerSink
}

export class FanOutService {
  constructor(private readonly options: FanOutOptions) {}

  /** Drive pending triggers for a tenant. Returns counts. Idempotent on re-run. */
  async drivePending(tenantId: string, limit = 100): Promise<{ driven: number; created: number; failed: number }> {
    const pending = await this.options.store.listPendingTriggers(tenantId, limit)
    let driven = 0
    let created = 0
    let failed = 0
    for (const t of pending) {
      driven++
      const event = await this.options.store.getEvent(tenantId, t.eventId)
      if (!event) {
        // event gone (data loss / retention): fail the trigger safely.
        await this.options.store.failTrigger(tenantId, t.triggerId, "event not found")
        failed++
        continue
      }
      try {
        const { automationRunId } = await this.options.sink.createRunForTrigger({
          tenantId, orgId: event.orgId, projectId: event.projectId,
          automationTemplateId: t.automationTemplateId, triggerId: t.triggerId, event, inputMapping: {},
        })
        await this.options.store.completeTrigger(tenantId, t.triggerId, automationRunId)
        created++
      } catch (error) {
        await this.options.store.failTrigger(tenantId, t.triggerId, error instanceof Error ? error.message : "unknown")
        failed++
      }
    }
    return { driven, created, failed }
  }

  /**
   * Fan out a single event: match subscriptions, record idempotent triggers,
   * then drive them immediately (within the same call). A duplicate event
   * returns without creating new triggers. Returns the trigger ids created.
   */
  async fanOutEvent(event: NormalizedEvent): Promise<{ triggerIds: readonly string[]; runIds: readonly string[] }> {
    const subs = await this.options.store.matchSubscriptions(event)
    const triggerIds: string[] = []
    const runIds: string[] = []
    for (const sub of subs) {
      const trig = await this.options.store.recordTrigger(sub, event)
      triggerIds.push(trig.triggerId)
      if (!trig.created) {
        if (trig.existingRunId) runIds.push(trig.existingRunId)
        continue
      }
      try {
        const { automationRunId } = await this.options.sink.createRunForTrigger({
          tenantId: event.tenantId, orgId: event.orgId, projectId: event.projectId,
          automationTemplateId: sub.automationTemplateId, triggerId: trig.triggerId, event, inputMapping: sub.inputMapping,
        })
        await this.options.store.completeTrigger(event.tenantId, trig.triggerId, automationRunId)
        runIds.push(automationRunId)
      } catch (error) {
        await this.options.store.failTrigger(event.tenantId, trig.triggerId, error instanceof Error ? error.message : "unknown")
      }
    }
    await this.options.store.markEventProcessed(event.tenantId, event.eventId)
    return { triggerIds, runIds }
  }
}
