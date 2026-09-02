/**
 * AutomationRun state machine + transition validation (Phase 2A).
 *
 * Non-terminal flow:
 *   created → validating_input → admitted → running → collecting
 *     → awaiting_approval → delivering → completed
 * Terminal alternatives: failed | cancelled | rejected
 * Explicit suspension: suspended (non-terminal, resumable)
 *
 * Every transition is validated against an explicit table. Illegal transitions
 * fail WITHOUT partially advancing the run — the store's fenced, atomic
 * transition either commits the full new state or rolls back entirely. The run
 * `runVersion` fencing token ensures a stale writer (version mismatch) can never
 * mutate the run after a newer transition committed.
 */

import {
  type AutomationRun,
  type RunStatus,
  AutomationError,
} from "./contracts"
import { newRunId } from "./ids"

export class IllegalRunTransitionError extends AutomationError {
  constructor(runId: string, from: RunStatus, to: RunStatus) {
    super("ILLEGAL_RUN_TRANSITION", `Run ${runId} cannot transition ${from} → ${to}`, 409)
  }
}

/** A stale writer tried to mutate a run whose fencing version has moved on. */
export class RunFencedError extends AutomationError {
  constructor(runId: string) {
    super("RUN_FENCED", `Run ${runId} is owned by a newer version`, 409)
  }
}

/** Explicit transition table. Any pair not present is illegal. */
const TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  created: ["validating_input", "failed", "cancelled"],
  validating_input: ["admitted", "failed", "cancelled"],
  admitted: ["running", "failed", "cancelled", "suspended"],
  running: ["collecting", "awaiting_approval", "failed", "cancelled", "suspended"],
  collecting: ["awaiting_approval", "delivering", "completed", "failed", "cancelled"],
  awaiting_approval: ["delivering", "rejected", "failed", "cancelled"],
  delivering: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
  rejected: [],
  suspended: ["admitted", "running", "collecting", "failed", "cancelled"],
}

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  if (from === to) return false
  return TRANSITIONS[from].includes(to)
}

/** Validate a single transition; throw on illegal. */
export function assertTransition(runId: string, from: RunStatus, to: RunStatus): void {
  if (!canTransition(from, to)) throw new IllegalRunTransitionError(runId, from, to)
}

/** Whether a run in `status` may be advanced by the orchestrator (non-terminal,
 *  not awaiting an external decision or suspended). */
export function isAdvancing(status: RunStatus): boolean {
  return (
    status === "admitted" ||
    status === "running" ||
    status === "collecting"
  )
}

/** Build a fresh run record at `created`. The store assigns `runVersion=1`. */
export function buildRun(args: {
  readonly tenantId: string
  readonly orgId: string
  readonly projectId: string
  readonly templateId: string
  readonly versionId: string
  readonly version: number
  readonly inputRevisionId: string
  readonly createdBy: string
  readonly now?: number
}): AutomationRun {
  const now = args.now ?? Date.now()
  return {
    runId: newRunId(),
    tenantId: args.tenantId,
    orgId: args.orgId,
    projectId: args.projectId,
    templateId: args.templateId,
    versionId: args.versionId,
    version: args.version,
    status: "created",
    inputRevisionId: args.inputRevisionId,
    runVersion: 1,
    createdBy: args.createdBy,
    error: null,
    createdAt: now,
    updatedAt: now,
    suspendedAt: null,
    completedAt: null,
  }
}

/** Apply a transition to a run record, returning the updated record. Does NOT
 *  mutate the input; the store performs the fenced persist. */
export function applyTransition(run: AutomationRun, to: RunStatus, extra?: { readonly error?: string | null; readonly now?: number }): AutomationRun {
  assertTransition(run.runId, run.status, to)
  const now = extra?.now ?? Date.now()
  return {
    ...run,
    status: to,
    error: extra?.error !== undefined ? extra.error : run.error,
    updatedAt: now,
    runVersion: run.runVersion + 1,
    suspendedAt: to === "suspended" ? now : run.suspendedAt,
    completedAt: to === "completed" || to === "failed" || to === "cancelled" || to === "rejected" ? now : null,
  }
}
