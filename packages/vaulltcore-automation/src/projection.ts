/**
 * Product event projection (Phase 2A).
 *
 * Projects Phase 1 runner {@link JobEvent}s (execution evidence) into stable
 * {@link AutomationEvent}s (product-level history). Runner events are internal
 * execution evidence; automation events are the customer-facing API. The
 * projection is a pure function of (stepId, runnerEvents) so it is
 * deterministic and replayable: a fresh process rebuilding run state from the
 * durable event log produces identical automation events.
 *
 * The projection never mutates runner events and never depends on runner
 * internals beyond the public event vocabulary.
 */

import type { JobEvent, JobStatus } from "@vaulltcore/runner"
import type { AutomationEvent, AutomationEventType } from "./contracts"

/** Project a slice of runner events for one step into automation events. The
 *  caller passes the events belonging to the step's job (via listEvents) and
 *  the next automation seq to assign. Returns the projected automation events
 *  (already assigned seqs) and the next seq after them. */
export function projectStepEvents(args: {
  readonly runId: string
  readonly stepId: string
  readonly jobId: string
  readonly events: readonly JobEvent[]
  readonly startSeq: number
  readonly now?: () => number
}): { events: AutomationEvent[]; nextSeq: number } {
  let seq = args.startSeq
  const now = args.now ?? Date.now
  const out: AutomationEvent[] = []
  let started = false
  let lastText = ""
  for (const e of args.events) {
    if (e.type === "started" && !started) {
      started = true
      out.push({ runId: args.runId, seq: seq++, timestamp: now(), type: "automation.step.started", data: { stepId: args.stepId, jobId: args.jobId, attempt: (e.data as { attempt?: number }).attempt } })
    } else if (e.type === "message" && (e.data as { role?: string }).role === "assistant") {
      const text = (e.data as { text?: string }).text ?? ""
      if (text) lastText = text
      out.push({ runId: args.runId, seq: seq++, timestamp: now(), type: "automation.step.progress", data: { stepId: args.stepId, jobId: args.jobId, text } })
    } else if (e.type === "completed") {
      out.push({ runId: args.runId, seq: seq++, timestamp: now(), type: "automation.step.completed", data: { stepId: args.stepId, jobId: args.jobId, usage: (e.data as { usage?: unknown }).usage } })
    }
  }
  void lastText
  return { events: out, nextSeq: seq }
}

/** Map a runner job status to a product step status. */
export function stepStatusFromJobStatus(status: JobStatus): "pending" | "running" | "completed" | "failed" | "skipped" {
  switch (status) {
    case "queued":
    case "leased":
    case "preparing":
      return "pending"
    case "running":
    case "checkpointing":
    case "suspended":
    case "resuming":
      return "running"
    case "completed":
      return "completed"
    case "failed":
    case "cancelled":
      return "failed"
    default:
      return "pending"
  }
}

/** Build a single automation event with the next seq. */
export function automationEvent(args: {
  readonly runId: string
  readonly seq: number
  readonly type: AutomationEventType
  readonly data: unknown
  readonly now?: () => number
}): AutomationEvent {
  return { runId: args.runId, seq: args.seq, timestamp: (args.now ?? Date.now)(), type: args.type, data: args.data }
}
