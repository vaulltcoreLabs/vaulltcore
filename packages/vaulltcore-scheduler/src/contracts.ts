/**
 * Durable automation scheduling contracts (Phase 2B).
 *
 * One-time and recurring schedules for automation versions. A schedule is
 * versioned (immutable on publish; changes = new version), timezone-aware, and
 * supports pause/resume/cancel. The scheduler admits at most one run per
 * occurrence: the durable (scheduleId, occurrenceId) identity is the idempotency
 * boundary — a scheduler crash + restart recomputes the same occurrence and
 * finds the existing admission (UNIQUE), so no duplicate runs are created.
 *
 * Missed-run policy: `catch_up` (admit each missed occurrence up to a cap) or
 * `skip` (admit only the latest). The default is `skip` to avoid runaway
 * catch-up storms after an outage; `catch_up` is bounded by `maxCatchUp`.
 *
 * This is NOT a general workflow engine. Each occurrence admits a single
 * automation run for the scheduled version.
 */

import type { AutomationArtifact, DeliveryProvider } from "@vaulltcore/automation"

export type ScheduleKind = "one_time" | "recurring"

export type ScheduleState = "active" | "paused" | "cancelled"

export type MissedRunPolicy = "skip" | "catch_up"

export interface ScheduleOwner {
  readonly tenantId: string
  readonly orgId: string
  readonly projectId: string
}

/** An immutable published schedule version. */
export interface ScheduleVersion {
  readonly versionId: string
  readonly scheduleId: string
  readonly version: number
  readonly kind: ScheduleKind
  /** Cron expression (recurring) or ISO-8601 scheduled time (one-time). */
  readonly cron: string | null
  readonly scheduledAt: number | null
  readonly timezone: string
  readonly automationVersionId: string
  readonly missedRunPolicy: MissedRunPolicy
  readonly maxCatchUp: number
  readonly input: Readonly<Record<string, unknown>> | null
  readonly createdAt: number
  readonly checksum: string
}

/** A schedule (versioned; the latest active version is authoritative). */
export interface Schedule {
  readonly scheduleId: string
  readonly owner: ScheduleOwner
  readonly name: string
  readonly state: ScheduleState
  readonly currentVersion: number
  /** Watermark: the last occurrence epoch ms that was admitted (or null). */
  readonly lastAdmittedAt: number | null
  readonly createdAt: number
  readonly updatedAt: number
}

/** A fired occurrence admission record (idempotency boundary). */
export interface ScheduleOccurrence {
  readonly occurrenceId: string
  readonly scheduleId: string
  readonly version: number
  readonly scheduledTime: number
  readonly admittedRunId: string | null
  readonly admittedAt: number | null
  readonly createdAt: number
}

/** A scheduler tick result. */
export interface SchedulerTickResult {
  readonly admitted: ReadonlyArray<{ readonly scheduleId: string; readonly occurrenceId: string; readonly runId: string }>
  readonly skipped: number
}

/** Admits a run for an occurrence. Must be idempotent on occurrenceId. */
export interface ScheduleAdmitter {
  admit(args: {
    readonly owner: ScheduleOwner
    readonly automationVersionId: string
    readonly input: Readonly<Record<string, unknown>> | null
    readonly occurrenceId: string
    readonly idempotencyKey: string
  }): Promise<{ readonly runId: string }>
}

export type { AutomationArtifact, DeliveryProvider }
