/**
 * Scheduler engine (Phase 2B).
 *
 * The tick: for each active schedule, compute due occurrences (those whose
 * scheduled time is <= now and after the last-admitted watermark), apply the
 * missed-run policy, and admit at most one run per occurrence. Admission is
 * idempotent on the (scheduleId, occurrenceId) durable identity — a scheduler
 * crash + restart recomputes the same occurrenceId and the UNIQUE constraint in
 * the store rejects a duplicate, so no duplicate runs are created.
 *
 * Occurrence identity is deterministic: `occ:<scheduleId>:<scheduledTimeMs>`.
 * Two scheduler instances ticking the same schedule at the same time both
 * compute the same occurrenceId; exactly one wins the UNIQUE insert and admits
 * a run; the other sees `admitted: false` and skips. This is the at-least-once
 * execution / exactly-once admission boundary.
 *
 * This is NOT a general workflow engine. Each occurrence admits a single
 * automation run; there are no DAGs, loops, or parallel branches.
 */

import { nextRun, parseCron, validateTimezone, type ParsedCron } from "./cron"
import type { ScheduleAdmitter, SchedulerTickResult, ScheduleOwner } from "./contracts"
import type { SqlScheduleStore } from "./store"

export interface SchedulerOptions {
  readonly store: SqlScheduleStore
  readonly admitter: ScheduleAdmitter
  /** Max occurrences admitted per tick per schedule (backpressure). Default 100. */
  readonly maxPerTick?: number
  readonly now?: () => number
}

export class Scheduler {
  private readonly store: SqlScheduleStore
  private readonly admitter: ScheduleAdmitter
  private readonly maxPerTick: number
  private readonly now: () => number
  private readonly parsedCache = new Map<string, ParsedCron>()

  constructor(options: SchedulerOptions) {
    this.store = options.store
    this.admitter = options.admitter
    this.maxPerTick = options.maxPerTick ?? 100
    this.now = options.now ?? Date.now
  }

  /** Run one tick across all active schedules (optionally tenant-scoped). */
  async tick(tenantId?: string): Promise<SchedulerTickResult> {
    const now = this.now()
    const schedules = this.store.listActive(tenantId ?? null)
    const admitted: Array<{ scheduleId: string; occurrenceId: string; runId: string }> = []
    let skipped = 0
    for (const sched of schedules) {
      const version = this.store.getCurrentVersion(sched.scheduleId)
      if (!version) continue
      const dueTimes = this.computeDue(sched.scheduleId, version.cron, version.scheduledAt, version.timezone, sched.lastAdmittedAt, now, version.kind)
      // Apply missed-run policy.
      let toAdmit: number[]
      if (dueTimes.length === 0) continue
      if (version.missedRunPolicy === "skip") {
        // Admit only the latest due occurrence.
        toAdmit = [dueTimes[dueTimes.length - 1]!]
      } else {
        // catch_up: bounded by maxCatchUp and maxPerTick.
        const cap = Math.min(version.maxCatchUp, this.maxPerTick)
        toAdmit = dueTimes.slice(0, cap)
      }
      for (const t of toAdmit) {
        const occurrenceId = `occ:${sched.scheduleId}:${t}`
        const rec = this.store.recordOccurrence({ occurrenceId, scheduleId: sched.scheduleId, version: sched.currentVersion, scheduledTime: t, now })
        if (!rec.admitted) {
          // Already admitted by a prior tick / another scheduler instance.
          skipped++
          continue
        }
        // THIS call owns the occurrence; admit exactly one run.
        const owner: ScheduleOwner = sched.owner
        try {
          const { runId } = await this.admitter.admit({
            owner,
            automationVersionId: version.automationVersionId,
            input: version.input,
            occurrenceId,
            idempotencyKey: occurrenceId,
          })
          this.store.setAdmittedRun(occurrenceId, runId, now)
          this.store.advanceWatermark(sched.scheduleId, t, sched.currentVersion)
          admitted.push({ scheduleId: sched.scheduleId, occurrenceId, runId })
        } catch (error) {
          // Admission failed; the occurrence row remains without a runId. A
          // later tick will NOT re-admit (recordOccurrence returns admitted:false
          // because the row exists) — this is correct: we do not blindly retry
          // a non-idempotent admission. Reconciliation inspects + repairs.
          // Re-raise so the caller knows the tick was partial.
          throw error
        }
      }
    }
    return { admitted, skipped }
  }

  /** Compute due occurrence times strictly after the watermark and <= now. */
  private computeDue(scheduleId: string, cron: string | null, scheduledAt: number | null, tz: string, lastAdmittedAt: number | null, now: number, kind: string): number[] {
    if (kind === "one_time") {
      if (scheduledAt == null) return []
      const after = lastAdmittedAt ?? 0
      if (scheduledAt <= now && scheduledAt > after) return [scheduledAt]
      return []
    }
    if (!cron) return []
    validateTimezone(tz)
    const parsed = this.parsedCache.get(cron) ?? parseCron(cron)
    this.parsedCache.set(cron, parsed)
    const after = lastAdmittedAt ?? (now - 24 * 60 * 60_000) // default: look back 24h
    const due: number[] = []
    // Walk forward from `after` to `now`, collecting matches. Bounded by a sane
    // cap to avoid unbounded polling on a long outage.
    const cap = 1000
    let cursor = after
    for (let i = 0; i < cap; i++) {
      const t = nextRun(parsed, cursor, tz)
      if (t > now) break
      due.push(t)
      cursor = t
    }
    return due
  }
}
