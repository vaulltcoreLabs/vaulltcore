/**
 * Durable trigger model contracts (Phase 2D).
 *
 * A trigger is NOT execution. It is an immutable, versioned declarative rule
 * that matches normalized external events (or schedules) to an automation
 * version target. Trigger changes create a new versioned revision; historical
 * events remain explainable against the trigger definition active when matched
 * — a recovery pass never reinterprets an old match using a newer version.
 *
 * Trigger classes (the only supported classes — this is NOT a general engine):
 *   webhook_event       — match normalized provider events
 *   schedule            — reuse the Phase 2B scheduler (no second system)
 *   manual              — invoked explicitly through the API
 *   integration_event   — alias of webhook_event for non-webhook integrations
 *
 * Matching is deterministic + declarative ONLY: provider, event kind(s),
 * resource glob, action, optional connection reference, optional selectors.
 * No arbitrary JavaScript / unbounded user code for filtering.
 */

import type { JobIdentity } from "@vaulltcore/runner"
import type { NormalizedEventKind } from "@vaulltcore/integration"
import { createHash } from "node:crypto"

/** Supported trigger classes. Adding a class requires a deliberate migration. */
export const TRIGGER_CLASSES = [
  "webhook_event",
  "schedule",
  "manual",
  "integration_event",
] as const
export type TriggerClass = (typeof TRIGGER_CLASSES)[number]

/** Lifecycle state of a trigger definition (the current revision). */
export const TRIGGER_STATES = ["enabled", "disabled"] as const
export type TriggerState = (typeof TRIGGER_STATES)[number]

/**
 * Deterministic declarative filter criteria for matching an event to a trigger.
 * Every field is a literal/glob — never executable code.
 */
export interface TriggerMatchCriteria {
  /** Provider the event must come from (e.g. "github"). */
  readonly provider: string
  /** Event kind(s) to match; empty = all kinds. */
  readonly eventKinds: readonly NormalizedEventKind[]
  /** Glob matched against event.resource (e.g. "github:owner/*"). "*" = all. */
  readonly resourcePattern: string
  /** Optional action filter (literal; null = any action). */
  readonly action: string | null
  /** Optional connection the event must be bound to. */
  readonly connectionId: string | null
  /** Optional project/repository/resource selectors (literal globs). */
  readonly selectors: Readonly<Record<string, string>>
}

/**
 * A trigger definition revision. Immutable once published; any change creates a
 * new revision (versioned). The `version` is pinned into every dispatch so a
 * historical match stays explainable against the definition active at match
 * time. A trigger is associated with a specific automation version target.
 */
export interface TriggerDefinition extends JobIdentity {
  readonly triggerId: string
  readonly templateId: string
  readonly versionId: string
  /** The automation version this trigger targets. */
  readonly triggerClass: TriggerClass
  readonly name: string
  /** Match criteria (webhook_event/integration_event classes). */
  readonly criteria: TriggerMatchCriteria | null
  /** Schedule id (schedule class only; reuses Phase 2B scheduler). */
  readonly scheduleId: string | null
  /** Input mapping derived from the event payload into the run's input. */
  readonly inputMapping: Readonly<Record<string, unknown>>
  readonly state: TriggerState
  /** Monotonic per-trigger revision number, starting at 1. */
  readonly revision: number
  /** SHA-256 over the canonical definition (corruption detection). */
  readonly checksum: string
  readonly createdAt: number
  readonly createdBy: string
  readonly updatedAt: number
}

/** Input to publish a trigger definition (create or revise). */
export interface PublishTriggerInput {
  readonly tenantId: string
  readonly orgId: string
  readonly projectId: string
  readonly principalId: string
  readonly templateId: string
  readonly versionId: string
  readonly triggerClass: TriggerClass
  readonly name: string
  readonly criteria?: TriggerMatchCriteria | null
  readonly scheduleId?: string | null
  readonly inputMapping?: Readonly<Record<string, unknown>>
  readonly state?: TriggerState
}

/** Compute the canonical checksum over a trigger definition. */
export function triggerChecksum(input: PublishTriggerInput): string {
  const canonical = JSON.stringify({
    templateId: input.templateId,
    versionId: input.versionId,
    triggerClass: input.triggerClass,
    name: input.name,
    criteria: input.criteria ?? null,
    scheduleId: input.scheduleId ?? null,
    inputMapping: input.inputMapping ?? {},
  })
  return createHash("sha256").update(canonical).digest("hex")
}
