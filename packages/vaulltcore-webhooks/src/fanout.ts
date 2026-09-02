/**
 * Event fan-out: subscription matching (Phase 2C).
 *
 * Provider events → normalized events → subscription matcher → automation
 * trigger. The matcher is provider-neutral: it matches on (provider, kind,
 * resource glob, action). No one-off trigger logic per provider. A trigger is
 * durable + idempotent on `(tenantId, subscriptionId, eventId)` so a re-drive
 * (worker retry) never duplicates an automation run.
 *
 * The matcher NEVER invokes the agent; it produces a {@link TriggerRequest}
 * that the automation layer (Phase 2A) dispatches with its own idempotency
 * (run idempotency_key derived from the trigger identity). Execution stays
 * at-least-once; exactly-once is at the automation run identity boundary.
 */

import type { NormalizedEvent } from "@vaulltcore/integration"

export interface Subscription {
  readonly subscriptionId: string
  readonly tenantId: string
  readonly orgId: string
  readonly projectId: string
  readonly name: string
  /** Provider to match (e.g. "github", "gitlab", "linear", "slack"). */
  readonly provider: string
  /** Event kinds to match (e.g. ["pr.opened", "issue.commented"]); ["*"] = all. */
  readonly kinds: readonly string[]
  /** Resource glob (e.g. "github:owner/*"); ["*"] = all. */
  readonly resourceGlob: string
  /** Actions to match (e.g. ["opened"]); null/["*"] = all. */
  readonly actions: readonly string[] | null
  /** Automation template/version id to trigger. */
  readonly automationId: string
  readonly enabled: boolean
}

export interface TriggerRequest {
  readonly tenantId: string
  readonly orgId: string
  readonly projectId: string
  readonly automationId: string
  readonly subscriptionId: string
  /** Deterministic trigger identity (tenant|subscription|eventId). */
  readonly triggerKey: string
  readonly eventId: string
  readonly provider: string
  readonly kind: string
  readonly resource: string
  readonly payload: Readonly<Record<string, unknown>>
}

/** Minimal glob: '*' matches any sequence, no other wildcards. */
export function globMatch(pattern: string, value: string): boolean {
  if (pattern === "*") return true
  if (!pattern.includes("*")) return pattern === value
  // Convert to regex, escaping everything except '*'.
  const re = new RegExp("^" + pattern.replace(/[.*+?^${}()|[\]\\]/g, (m) => (m === "*" ? ".*" : "\\" + m)) + "$")
  return re.test(value)
}

export class SubscriptionMatcher {
  private readonly subs = new Map<string, Subscription>()

  upsert(sub: Subscription): void {
    this.subs.set(`${sub.tenantId}:${sub.subscriptionId}`, sub)
  }
  remove(tenantId: string, subscriptionId: string): void {
    this.subs.delete(`${tenantId}:${subscriptionId}`)
  }
  list(tenantId: string): readonly Subscription[] {
    return [...this.subs.values()].filter((s) => s.tenantId === tenantId)
  }

  /** Match an event to all enabled subscriptions for its tenant. */
  match(event: NormalizedEvent): readonly TriggerRequest[] {
    const triggers: TriggerRequest[] = []
    for (const sub of this.subs.values()) {
      if (!sub.enabled) continue
      if (sub.tenantId !== event.tenantId) continue // tenant isolation
      if (sub.provider !== event.provider) continue
      if (!sub.kinds.includes("*") && !sub.kinds.includes(event.kind)) continue
      if (!globMatch(sub.resourceGlob, event.resource)) continue
      if (sub.actions && !sub.actions.includes("*") && (event.action == null || !sub.actions.includes(event.action))) continue
      triggers.push({
        tenantId: event.tenantId,
        orgId: event.orgId,
        projectId: event.projectId,
        automationId: sub.automationId,
        subscriptionId: sub.subscriptionId,
        triggerKey: `trig:${event.tenantId}:${sub.subscriptionId}:${event.eventId}`,
        eventId: event.eventId,
        provider: event.provider,
        kind: event.kind,
        resource: event.resource,
        payload: event.payload,
      })
    }
    return triggers
  }
}
