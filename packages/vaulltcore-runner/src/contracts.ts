/**
 * Vaulltcore neutral execution contracts.
 *
 * These types are engine-agnostic. The OpenCode-derived agent engine sits
 * behind the {@link AgentEngine} seam and must be replaceable without
 * changing the control-plane job contract defined here.
 *
 * No runtime dependencies. Plain types + hand-rolled validation only.
 */

import type { LeaseRenewalResult } from "./distributed"

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Tenant-scoped identity carried by every piece of job-owned state. */
export interface JobIdentity {
  readonly tenantId: string
  readonly orgId: string
  readonly projectId: string
}

// ---------------------------------------------------------------------------
// Job lifecycle
// ---------------------------------------------------------------------------

/**
 * Non-terminal flow:
 *   queued → leased → preparing → running ⇄ checkpointing
 *     → suspended (worker loss / explicit suspend; non-terminal, resumable)
 *     → resuming → running
 * Terminal:
 *   completed | failed | cancelled
 */
export const JOB_STATUSES = [
  "queued",
  "leased",
  "preparing",
  "running",
  "checkpointing",
  "suspended",
  "resuming",
  "completed",
  "failed",
  "cancelled",
] as const

export type JobStatus = (typeof JOB_STATUSES)[number]

export const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set(["completed", "failed", "cancelled"])

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

// ---------------------------------------------------------------------------
// Execution policy
// ---------------------------------------------------------------------------

/** What to do with a tool call that was durably recorded but has no committed
 * result after a crash — it may or may not have produced side effects. */
export type UncertainToolCallPolicy =
  /** Default, safest: never re-execute. Commit an explicit "uncertain" tool
   * result so the model sees the call did not produce a trustworthy outcome. */
  | "mark_uncertain"
  /** Fail the job (terminal `failed`) for operator reconciliation. */
  | "fail_job"

export interface ExecutionPolicy {
  /** Bumped whenever the resume-relevant semantics of this policy change.
   * Checkpoints pin the version they were written under; a mismatched resume
   * is rejected rather than silently reinterpreted. */
  readonly version: string
  /** Hard bound on agent steps (one provider turn = one step). */
  readonly maxSteps: number
  /** Reconciliation strategy for recorded-but-unsettled tool calls. */
  readonly onUncertainToolCall: UncertainToolCallPolicy
  /** Names of tools the agent may call. Empty array = no tools allowed. */
  readonly allowedTools: readonly string[]
  /** Tool names that may be re-executed after uncertain interruption because
   * the caller asserts they are idempotent for the same idempotency key. */
  readonly idempotentTools: readonly string[]
  /** Wall-clock lease for a single worker attempt, milliseconds. */
  readonly leaseMs: number
  /** Phase 1F: soft token budget (input+output+reasoning). Enforcement happens
   *  at the next safe boundary (after a turn's usage is committed), so overshoot
   *  is bounded to one provider turn — model usage is only known after a turn.
   *  null/undefined = no token budget. Checkpoint correctness is never
   *  sacrificed: the turn's committed usage stays durable and accounted. */
  readonly maxTokens?: number | null
  /** Phase 1F: soft wall-clock budget for the whole job, milliseconds. Checked
   *  at step boundaries (not mid-turn). null/undefined = no duration budget. */
  readonly maxDurationMs?: number | null
}

export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = {
  version: "1",
  maxSteps: 25,
  onUncertainToolCall: "mark_uncertain",
  allowedTools: [],
  idempotentTools: [],
  leaseMs: 60_000,
  maxTokens: null,
  maxDurationMs: null,
}

/** Reason recorded on a durable budget-exhaustion transition (Phase 1F). */
export type BudgetExhaustionReason = "token_budget_exhausted" | "duration_budget_exhausted"

export function budgetExhaustionEvent(reason: BudgetExhaustionReason, detail: { consumedTokens: number; maxTokens?: number | null; elapsedMs: number; maxDurationMs?: number | null }): {
  type: "budget_exhausted"
  data: { reason: BudgetExhaustionReason; consumedTokens: number; maxTokens?: number | null; elapsedMs: number; maxDurationMs?: number | null }
} {
  return { type: "budget_exhausted", data: { reason, ...detail } }
}

// ---------------------------------------------------------------------------
// Job specification and record
// ---------------------------------------------------------------------------

export interface JobSpec {
  /** Engine to run this job with, e.g. "opencode". */
  readonly engine: string
  /** Model identifier understood by the engine's ModelProvider boundary. */
  readonly model: string
  /** Initial admitted input (the "prompt"). */
  readonly input: string
  /** Opaque engine-specific options (system prompt, temperature, ...). */
  readonly engineOptions?: Record<string, unknown>
}

export interface JobRecord extends JobIdentity {
  readonly jobId: string
  readonly spec: JobSpec
  status: JobStatus
  /** Monotonic attempt counter; incremented on every lease acquisition. */
  attempt: number
  /** Fencing token for the current lease holder, null when not leased. */
  leaseToken: string | null
  leaseExpiresAt: number | null
  cancelRequested: boolean
  error: string | null
  /** Explicit env map handed to tools. Never seeded from process.env. */
  readonly env: Record<string, string>
  /** Execution policy resolved at creation; pinned for the job's lifetime. */
  readonly policy: ExecutionPolicy
  /**
   * Latest compatible execution snapshot reference, mutable only under
   * ownership fencing. Auxiliary: the checkpoint + event log are
   * authoritative; a snapshot is an optimization for compute resume.
   */
  latestSnapshot: ExecutionSnapshot | null
  readonly createdAt: number
  updatedAt: number
}

export type Job = JobRecord

// ---------------------------------------------------------------------------
// Events (append-only, monotonic seq per job)
// ---------------------------------------------------------------------------

/** Stable public event vocabulary. Engine-internal event names never leak. */
export const JOB_EVENT_TYPES = [
  "queued",
  "started",
  "resumed",
  "checkpoint",
  "message",
  "tool_request",
  "tool_response",
  "usage",
  "warning",
  "error",
  "budget_exhausted",
  "completed",
  "cancelled",
] as const

export type JobEventType = (typeof JOB_EVENT_TYPES)[number]

export interface JobEvent<T = unknown> {
  readonly jobId: string
  /** Monotonic durable sequence within the job, starting at 1. */
  readonly seq: number
  readonly timestamp: number
  readonly type: JobEventType
  readonly data: T
}

export type NewJobEvent<T = unknown> = Omit<JobEvent<T>, "seq">

// ---------------------------------------------------------------------------
// Messages / tool calls (neutral wire shape, mirrors the extracted kernel)
// ---------------------------------------------------------------------------

export type Role = "system" | "user" | "assistant" | "tool"

export interface TextPart {
  readonly type: "text"
  readonly text: string
}

export interface ToolCallPart {
  readonly type: "tool_call"
  /** Provider-assigned call id; durable identity is namespaced by the runner
   * as `${stepIndex}:${toolCallId}` (the idempotency key). */
  readonly toolCallId: string
  readonly toolName: string
  readonly input: unknown
}

export interface ToolResultPart {
  readonly type: "tool_result"
  readonly toolCallId: string
  readonly toolName: string
  readonly output: unknown
  readonly isError: boolean
  /** Set when the result was reconstructed during resume reconciliation
   * rather than produced by a real execution. */
  readonly uncertain?: boolean
}

export type ContentPart = TextPart | ToolCallPart | ToolResultPart

export interface ChatMessage {
  readonly role: Role
  readonly content: readonly ContentPart[]
}

// ---------------------------------------------------------------------------
// Usage / metrics
// ---------------------------------------------------------------------------

export interface JobMetrics {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  totalTokens: number
  /** One provider turn = one step. */
  steps: number
  toolCalls: number
}

export function emptyMetrics(): JobMetrics {
  return { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, steps: 0, toolCalls: 0 }
}

export function addUsage(
  metrics: JobMetrics,
  usage: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number },
): JobMetrics {
  const input = metrics.inputTokens + (usage.inputTokens ?? 0)
  const output = metrics.outputTokens + (usage.outputTokens ?? 0)
  const reasoning = metrics.reasoningTokens + (usage.reasoningTokens ?? 0)
  return { ...metrics, inputTokens: input, outputTokens: output, reasoningTokens: reasoning, totalTokens: input + output + reasoning }
}

// ---------------------------------------------------------------------------
// Checkpoint
// ---------------------------------------------------------------------------

export type ToolCallState =
  | { readonly status: "recorded"; readonly recordedAtSeq: number }
  | {
      readonly status: "completed"
      readonly recordedAtSeq: number
      readonly completedAtSeq: number
      /** Reference to the durable `tool_response` event carrying the result. */
      readonly resultSeq: number
      readonly reused?: boolean
    }
  | {
      readonly status: "uncertain"
      readonly recordedAtSeq: number
      readonly reason: string
    }

/** Where execution continues after resume. */
export type ContinuationPoint =
  | { readonly type: "provider_turn"; readonly nextStepIndex: number }
  | { readonly type: "settle_tools"; readonly stepIndex: number; readonly pendingToolCallIds: readonly string[] }
  | { readonly type: "done" }

/**
 * The durable checkpoint. Identity fields are frozen at creation; the
 * progress fields are mutable on the worker's draft but every persisted
 * revision is sealed by the checksum.
 */
export interface JobCheckpoint extends JobIdentity {
  readonly jobId: string
  /** Durable execution/session identity, stable across attempts. */
  readonly executionId: string
  status: JobStatus
  /** Attempt (fencing) this checkpoint revision was written under. */
  attempt: number
  /** Watermark: every event with seq <= lastEventSeq is committed. */
  lastEventSeq: number
  lastCompletedStep: { readonly stepIndex: number; readonly finishedAt: number } | null
  /** Durable tool-call table keyed by idempotency key `${stepIndex}:${toolCallId}`. */
  toolCalls: Record<string, ToolCallState>
  /** Admitted but not yet consumed input. */
  pendingInput: string[]
  continuation: ContinuationPoint
  /** Reference to the model/session context used to rebuild engine history. */
  contextRef: { readonly kind: "event_projection"; readonly throughSeq: number }
  usage: JobMetrics
  readonly policyVersion: string
  readonly engineVersion: string
  readonly createdAt: number
  /** SHA-256 over the canonical checkpoint payload (excluding this field). */
  readonly checksum: string
}

/** Everything the runner needs to continue a job, derived from the store. */
export interface ResumeState {
  readonly record: JobRecord
  readonly checkpoint: JobCheckpoint
  /** Committed events up to the checkpoint watermark, for projection. */
  readonly events: readonly JobEvent[]
  readonly nextAttempt: number
  readonly leaseToken: string
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  readonly name: string
  readonly description: string
  /** JSON Schema for the tool input. */
  readonly parameters: Record<string, unknown>
  /** Callers assert calls with the same idempotency key are safe to re-run. */
  readonly idempotent?: boolean
}

export interface ToolContext {
  readonly job: JobIdentity & { readonly jobId: string; readonly executionId: string }
  /** Idempotency key for this call: `${stepIndex}:${toolCallId}`. */
  readonly idempotencyKey: string
  readonly workspace: WorkspaceHandle | null
  /** Scrubbed environment — never the worker's process.env. */
  readonly env: Readonly<Record<string, string>>
  readonly signal: AbortSignal
}

export interface Tool {
  readonly definition: ToolDefinition
  execute(input: unknown, ctx: ToolContext): Promise<unknown>
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

export interface WorkspaceSnapshotRef {
  readonly workspaceId: string
  /** Provider-specific opaque pointer (tarball path, volume id, ...). */
  readonly ref: string
  readonly createdAt: number
}

export interface WorkspaceHandle {
  readonly id: string
  /** Local root for this disposable workspace, if the provider exposes one. */
  readonly root: string | null
}

/** A workspace belongs to exactly one job execution and is disposable. */
export interface WorkspaceProvider {
  prepare(jobId: string): Promise<WorkspaceHandle>
  restore(jobId: string, snapshot: WorkspaceSnapshotRef): Promise<WorkspaceHandle>
  snapshot(handle: WorkspaceHandle): Promise<WorkspaceSnapshotRef>
  destroy(handle: WorkspaceHandle): Promise<void>
}

// ---------------------------------------------------------------------------
// Execution environment + snapshots (Phase 1B)
// ---------------------------------------------------------------------------

/** Why a job was suspended. All reasons are explicit; none are errors. */
export type SuspensionReason =
  | "worker_loss"
  | "infrastructure_eviction"
  | "idle_policy"
  | "waiting_for_input"
  | "planned_hibernation"
  | "worker_unavailable"

/**
 * Vendor-neutral workspace identity. Root is provider-local (may be null for
 * remote-only providers); identity is bound to exactly one job.
 */
export interface WorkspaceState {
  readonly workspaceId: string
  readonly root: string | null
  /** Opaque provider pointer to the latest workspace snapshot, if any. */
  readonly snapshotRef: string | null
}

/**
 * A reference to a suspended compute environment (LEVEL 2 recovery).
 *
 * The snapshot itself is never the source of truth: the durable JobCheckpoint
 * and append-only event log remain authoritative. A snapshot is an
 * optimization for faster continuation; if it cannot be restored or fails
 * integrity/compatibility checks, recovery MUST fall back to logical resume.
 */
export interface ExecutionSnapshot {
  readonly snapshotId: string
  readonly jobId: string
  /** Ownership generation under which the snapshot was captured. */
  readonly attempt: number
  /** Engine compatibility pin; restore requires exact match. */
  readonly engineVersion: string
  /** Environment compatibility pin; restore requires exact match. */
  readonly environmentVersion: string
  readonly createdAt: number
  /** Integrity metadata over the snapshot payload. */
  readonly integrity: { readonly algorithm: "sha256"; readonly checksum: string }
  /** Storage pointer (never vendor-specific in the contract). */
  readonly storage: { readonly kind: string; readonly uri: string }
  readonly workspaceState?: WorkspaceState
}

/**
 * Native capabilities of an execution environment (Phase 1C). Everything an
 * environment cannot do natively must be reported here so the controller can
 * fall back explicitly — an environment must never pretend that a logical
 * checkpoint is a compute (VM/sandbox) snapshot.
 */
export interface ExecutionCapabilities {
  /** Compute can be paused without consuming model tokens. */
  readonly nativeSuspend: boolean
  /** Environment can capture a real compute snapshot. */
  readonly nativeSnapshot: boolean
  /** Environment can materialize compute from a snapshot. */
  readonly nativeRestore: boolean
  /** Workspace contents survive worker loss without a snapshot. */
  readonly durableWorkspace: boolean
}

/** Environments that predate the capability contract are assumed fully capable. */
export const FULL_EXECUTION_CAPABILITIES: ExecutionCapabilities = {
  nativeSuspend: true,
  nativeSnapshot: true,
  nativeRestore: true,
  durableWorkspace: true,
}

/**
 * Compute/environment seam. A future provider may implement snapshots using VM
 * snapshots, filesystem layers, object storage, containers, or another
 * mechanism. The runner never depends on the ambient cwd: environment identity
 * is bound explicitly to the job.
 */
export interface ExecutionEnvironment {
  readonly environmentVersion: string
  /** Native capability report (Phase 1C). Optional for backward compatibility;
   * absent ⇒ treated as {@link FULL_EXECUTION_CAPABILITIES}. */
  capabilities?(): ExecutionCapabilities | Promise<ExecutionCapabilities>
  /** Create (or reattach to) the job's execution environment. */
  create(jobId: string): Promise<WorkspaceHandle>
  /** Current workspace identity of a handle. */
  getState(handle: WorkspaceHandle): Promise<WorkspaceState>
  /**
   * Capture a suspendable snapshot + integrity metadata. Returns null when no
   * native snapshot could be captured — an explicit "not captured" result, so
   * the controller records nothing and the durable checkpoint remains the
   * only continuation source.
   */
  snapshot(handle: WorkspaceHandle, meta: { jobId: string; attempt: number; engineVersion: string }): Promise<ExecutionSnapshot | null>
  /** Materialize an environment from a snapshot (validates job binding + integrity). */
  restore(snapshot: ExecutionSnapshot): Promise<WorkspaceHandle>
  /** Suspend compute (optimization hook; no model tokens may be consumed). */
  suspend(handle: WorkspaceHandle): Promise<void>
  /** Resume compute after a suspend (optimization hook). */
  resume(handle: WorkspaceHandle): Promise<WorkspaceHandle>
  /** Destroy the job's environment and all of its snapshots. */
  destroy(handle: WorkspaceHandle): Promise<void>
}

// ---------------------------------------------------------------------------
// Ownership + actor lifecycle (Phase 1B)
// ---------------------------------------------------------------------------

/** Durable ownership (fencing) grant; ownership changes are explicit. */
export interface OwnershipGrant {
  readonly jobId: string
  /** Ownership generation: monotonic attempt counter. */
  readonly generation: number
  /** Fencing token; validated durably against the record on every mutation. */
  readonly token: string
  readonly expiresAt: number
}

/** A live, ownership-fenced execution handle. */
export interface ActorHandle {
  readonly jobId: string
  readonly ownership: OwnershipGrant
  readonly record: JobRecord
}

/** Validated recovery context built by the controller's recovery algorithm. */
export interface RecoveryContext {
  readonly handle: ActorHandle
  /** Validated checkpoint (null ⇒ restart from step 0). */
  readonly checkpoint: JobCheckpoint | null
  /** Committed events up to the checkpoint watermark. */
  readonly committedEvents: readonly JobEvent[]
  /** Orphaned in-flight remnants after the watermark (never replayed). */
  readonly orphanedEvents: readonly JobEvent[]
  /** Materialized workspace (compute restore preferred, logical fallback). */
  readonly workspace: WorkspaceHandle | null
  /** True when a compute snapshot restore succeeded. */
  readonly restoredFromSnapshot: boolean
  readonly reusedToolCalls: number
}

/**
 * Actor lifecycle coordinator (AX `ate` Create/Resume/Suspend adapted, and
 * hardened with Vaulltcore durable ownership). Exactly one active execution
 * owner may advance a job; every mutation is fenced by the ownership
 * generation/token. A worker/actor is replaceable compute; the durable job
 * survives the actor.
 */
export interface ExecutionActorController {
  /** Take durable fenced ownership of a job. */
  acquire(jobId: string): Promise<ActorHandle>
  /** Transition a freshly acquired actor into preparing. */
  start(handle: ActorHandle): Promise<JobRecord>
  /**
   * Suspend at the latest safe continuation boundary. Captures a compute
   * snapshot when an environment is configured, records its reference durably,
   * then parks the job (no model tokens are consumed while suspended).
   */
  suspend(handle: ActorHandle, reason?: SuspensionReason): Promise<JobState>
  /** Recovery algorithm entry point (worker-loss semantics). */
  recover(jobId: string): Promise<RecoveryContext>
  /** Recovery algorithm entry point (explicit resume semantics). */
  resume(jobId: string): Promise<RecoveryContext>
  /** Capture and durably record an execution snapshot reference. */
  snapshot(handle: ActorHandle, workspace: WorkspaceHandle | null, engineVersion: string): Promise<ExecutionSnapshot | null>
  /** Explicitly release durable ownership. */
  release(handle: ActorHandle): Promise<void>
  /** Destroy the actor's execution environment (terminal/suspend cleanup). */
  destroy(jobId: string, workspace: WorkspaceHandle | null): Promise<void>
}

// ---------------------------------------------------------------------------
// Agent engine seam (implemented by vaulltcore-runner-opencode, ...)
// ---------------------------------------------------------------------------

export interface EngineInit {
  readonly identity: JobIdentity & { readonly jobId: string; readonly executionId: string }
  readonly spec: JobSpec
  readonly workspace: WorkspaceHandle | null
}

/** Events produced by the engine while streaming one provider turn. */
export type EngineTurnEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool_call"; readonly toolCallId: string; readonly toolName: string; readonly input: unknown }
  | { readonly type: "usage"; readonly usage: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } }
  | { readonly type: "finish"; readonly reason: "stop" | "tool_calls" | "max_tokens" | "cancelled" }

export interface EngineSession {
  /** Engine-private session handle (history, context, provider state). */
  readonly handle: unknown
}

export interface AgentEngine {
  readonly id: string
  /** Bumped when resume-relevant engine behavior changes; pinned in checkpoints. */
  readonly version: string
  /** Fresh session for a new job. */
  createSession(init: EngineInit): Promise<EngineSession>
  /** Rebuild a session from committed history projected from durable events. */
  restoreSession(init: EngineInit, history: readonly ChatMessage[]): Promise<EngineSession>
  /** Stream exactly one provider turn. The runner owns durability: it commits
   * the turn's outputs and settles tool calls itself. */
  runTurn(session: EngineSession, tools: readonly ToolDefinition[], signal: AbortSignal): AsyncIterable<EngineTurnEvent>
  /** Project committed durable events into engine history messages. */
  projectHistory(events: readonly JobEvent[]): ChatMessage[]
  /** Append a committed assistant turn to the live session. */
  recordAssistantTurn(session: EngineSession, message: ChatMessage): void
  /** Append committed tool results to the live session. */
  recordToolResults(session: EngineSession, results: readonly ChatMessage[]): void
  /** Append user input admitted while the job was running. */
  recordUserInput(session: EngineSession, text: string): void
}

// ---------------------------------------------------------------------------
// AgentRunner — the control-plane contract
// ---------------------------------------------------------------------------

export interface CreateJobInput extends JobIdentity {
  readonly spec: JobSpec
  readonly policy?: Partial<ExecutionPolicy>
  readonly env?: Record<string, string>
}

export interface JobState {
  readonly jobId: string
  /** Immutable tenant identity (Phase 1C: lets facades authorize without
   * trusting request-supplied identity claims). */
  readonly identity: JobIdentity
  readonly status: JobStatus
  readonly attempt: number
  readonly lastEventSeq: number
  readonly usage: JobMetrics
  readonly error: string | null
  readonly checkpoint: JobCheckpoint | null
}

/** Resource-style read model assembled by the runner (used by the control
 * plane). Status + usage + admitted-but-pending input + immutable identity. */
export interface JobView {
  readonly id: string
  readonly tenantId: string
  readonly orgId: string | null
  readonly projectId: string | null
  readonly status: JobStatus
  readonly createdAt: number
  readonly updatedAt: number
  readonly usage: JobMetrics
  readonly pendingInput: readonly string[]
}

export interface AgentRunner {
  createJob(input: CreateJobInput): Promise<JobRecord>
  /** Start a queued job. Resolves when the job reaches a terminal state. */
  runJob(jobId: string): Promise<JobState>
  /** Resume a suspended/interrupted job from its durable continuation point. */
  resumeJob(jobId: string): Promise<JobState>
  /**
   * Phase 1D: fenced heartbeat renewal of the execution lease for an
   * actively-running job the caller owns. Uses the lease token tracked for
   * the active run; a stale owner (token mismatched by a newer generation) is
   * rejected — it can never reclaim authority. Returns the store's renewal
   * result; `renewed:false` means the worker has lost ownership and must stop.
   */
  renewLease(jobId: string, leaseMs: number): Promise<LeaseRenewalResult>
  /** Request cancellation. Durable; effective at the next commit boundary. */
  cancelJob(jobId: string): Promise<JobState>
  /**
   * Supervisor action: mark a non-terminal job suspended and release its
   * lease. Used when a worker is known/likely gone. Transient worker loss
   * becomes `suspended` (non-terminal, resumable), never silently `failed`.
   */
  suspendJob(jobId: string, reason?: string): Promise<JobState>
  /** Admit user/system input while the job is non-terminal. Durable; takes
   * effect at the next step boundary, never mid-turn. */
  submitInput(jobId: string, text: string): Promise<JobState>
  getJobState(jobId: string): Promise<JobState>
  /** Assembled resource view (identity + status + usage + pending input).
   * Used by the control plane for read endpoints. Null when unknown. */
  getJob(jobId: string): Promise<JobView | null>
  /** Replay events with seq > afterSeq, then follow live events until the
   * job reaches a terminal state or the signal aborts. */
  streamEvents(jobId: string, afterSeq?: number, signal?: AbortSignal): AsyncIterable<JobEvent>
  /** Non-following replay: all committed events with seq > afterSeq. Used by
   * the control plane for follow=false event reads. */
  listEvents(jobId: string, afterSeq?: number): Promise<JobEvent[]>
  collectUsage(jobId: string): Promise<JobMetrics>
}
