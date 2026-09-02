/**
 * DurableAgentRunner — the Vaulltcore-owned execution orchestrator.
 *
 * Owns the job lifecycle state machine, commit boundaries, checkpointing,
 * tool-call idempotency, cancellation, and event replay. The agent engine
 * (OpenCode-derived or otherwise) sits behind {@link AgentEngine} and is
 * replaceable without changing this control-plane contract.
 *
 * Commit boundaries (each = one `checkpoint` event + checkpoint file write):
 *   1. assistant turn committed (message + usage events durable)
 *   2. tool call recorded (tool_request durable, before any side effect)
 *   3. tool result committed (tool_response durable)
 *   4. continuation advanced to the next provider turn
 *   5. terminal transition
 *
 * A worker may die at any point. Whatever happened after the last committed
 * boundary is uncommitted and is reconciled — never blindly replayed.
 */

import type {
  AgentEngine,
  AgentRunner,
  ActorHandle,
  BudgetExhaustionReason,
  ChatMessage,
  CreateJobInput,
  EngineSession,
  ExecutionEnvironment,
  ExecutionPolicy,
  JobCheckpoint,
  JobEvent,
  JobEventType,
  JobMetrics,
  JobRecord,
  JobState,
  JobStatus,
  JobView,
  NewJobEvent,
  RecoveryContext,
  SuspensionReason,
  Tool,
  ToolContext,
  WorkspaceHandle,
  WorkspaceProvider,
} from "./contracts"
import { DEFAULT_EXECUTION_POLICY, addUsage, emptyMetrics, isTerminal } from "./contracts"
import { finalizeCheckpoint, validateCheckpoint } from "./checkpoint"
import { ExecutionActorControllerImpl } from "./actor"
import { SimulatedCrashError } from "./engine"
import {
  EngineNotFoundError,
  InvalidCheckpointError,
  InvalidJobStateError,
  JobNotFoundError,
  VaulltcoreError,
} from "./errors"
import { newExecutionId, newJobId, newLeaseToken } from "./ids"
import type { LeaseRenewalResult } from "./distributed"
import type { SnapshotPolicy } from "./snapshot-policy"
import type { DurableJobStore } from "./store"
import { envForJob } from "./workspace"

export interface RunnerDeps {
  readonly store: DurableJobStore
  readonly engines: readonly AgentEngine[]
  readonly tools: readonly Tool[]
  readonly workspace: WorkspaceProvider | null
  /**
   * Phase 1B execution environment (compute/worker stream). When set, it
   * supersedes `workspace` for environment materialization and snapshots.
   */
  readonly environment?: ExecutionEnvironment | null
  /** Phase 1C cost-aware snapshot policy (optional, advisory only). */
  readonly snapshotPolicy?: SnapshotPolicy
}

/** Mutable checkpoint draft; finalized (checksummed) at every boundary. */
type Draft = Omit<JobCheckpoint, "checksum">

interface ActiveRun {
  readonly controller: AbortController
  readonly attempt: number
  readonly leaseToken: string
}

const TERMINAL_EVENT_TYPES: ReadonlySet<JobEventType> = new Set(["completed", "cancelled"])

export class DurableAgentRunner implements AgentRunner {
  private readonly store: DurableJobStore
  private readonly engines = new Map<string, AgentEngine>()
  private readonly tools = new Map<string, Tool>()
  private readonly workspace: WorkspaceProvider | null
  private readonly environment: ExecutionEnvironment | null
  private readonly active = new Map<string, ActiveRun>()
  private readonly subscribers = new Map<string, Set<(event: JobEvent) => void>>()
  /** Actor lifecycle coordinator: ownership, suspension, recovery, snapshots. */
  private readonly controller: ExecutionActorControllerImpl

  constructor(deps: RunnerDeps) {
    this.store = deps.store
    for (const engine of deps.engines) this.engines.set(engine.id, engine)
    for (const tool of deps.tools) this.tools.set(tool.definition.name, tool)
    this.workspace = deps.workspace
    this.environment = deps.environment ?? null
    this.controller = new ExecutionActorControllerImpl({
      store: this.store,
      environment: this.environment,
      workspace: this.workspace,
      resolveEngine: (record) => this.engineFor(record),
      resolvePolicy: (record) => this.policyFor(record),
      toJobState: (record) => this.toState(record),
      ...(deps.snapshotPolicy ? { snapshotPolicy: deps.snapshotPolicy } : {}),
    })
  }

  // -------------------------------------------------------------------------
  // Control-plane API
  // -------------------------------------------------------------------------

  async createJob(input: CreateJobInput): Promise<JobRecord> {
    const engine = this.engines.get(input.spec.engine)
    if (!engine) throw new EngineNotFoundError(input.spec.engine)
    const now = Date.now()
    const record: JobRecord = {
      jobId: newJobId(),
      tenantId: input.tenantId,
      orgId: input.orgId,
      projectId: input.projectId,
      spec: input.spec,
      status: "queued",
      attempt: 0,
      leaseToken: null,
      leaseExpiresAt: null,
      cancelRequested: false,
      error: null,
      env: { ...(input.env ?? {}) },
      policy: { ...DEFAULT_EXECUTION_POLICY, ...(input.policy ?? {}) },
      latestSnapshot: null,
      createdAt: now,
      updatedAt: now,
    }
    await this.store.createJobRecord(record)
    await this.append(record.jobId, [{ jobId: record.jobId, timestamp: now, type: "queued", data: { engine: input.spec.engine, model: input.spec.model } }])
    return record
  }

  async runJob(jobId: string): Promise<JobState> {
    const record = await this.requireRecord(jobId)
    if (record.status === "suspended") return this.resumeJob(jobId)
    if (isTerminal(record.status)) return this.toState(record)
    if (record.status !== "queued") throw new InvalidJobStateError(jobId, record.status, "run")
    if (record.cancelRequested) return this.finalizeCancelled(record, null, null)
    const engine = this.engineFor(record)
    const handle = await this.controller.acquire(jobId)
    const attempt = handle.ownership.generation
    const abort = new AbortController()
    this.active.set(jobId, { controller: abort, attempt, leaseToken: handle.ownership.token })
    try {
      let draft: Draft | null = null
      let workspace: WorkspaceHandle | null = null
      try {
        await this.controller.start(handle)
        workspace = await this.createEnvironment(jobId)
        const executionId = newExecutionId()
        const session = await engine.createSession({
          identity: { ...this.identityOf(record), jobId, executionId },
          spec: record.spec,
          workspace,
        })
        const started = await this.append(
          jobId,
          [{ jobId, timestamp: Date.now(), type: "started", data: { attempt, executionId } }],
          attempt,
        )
        draft = this.newDraft(record, attempt, executionId, started[0]!.seq)
        // Drain input admitted while queued (seqs lower than `started`).
        const appliedInputs = new Set<number>()
        await this.drainAdmittedInput(jobId, session, engine, draft, appliedInputs)
        await this.setStatus(record, attempt, "running")
        await this.commitBoundary(record, draft)
        return await this.loop(record, engine, session, draft, workspace, abort.signal, appliedInputs)
      } catch (error) {
        if (error instanceof SimulatedCrashError) throw error
        return await this.failJob(record, attempt, draft, workspace, error)
      }
    } finally {
      this.active.delete(jobId)
      await this.controller.release(handle).catch(() => {})
    }
  }

  async resumeJob(jobId: string): Promise<JobState> {
    const record = await this.requireRecord(jobId)
    if (isTerminal(record.status)) return this.toState(record)
    if (record.status === "queued") return this.runJob(jobId)
    if (record.cancelRequested) return this.finalizeCancelled(record, null, null)
    const engine = this.engineFor(record)
    const abort = new AbortController()
    // Recovery algorithm (validate → fence → checkpoint → events → workspace
    // → snapshot) lives in the actor controller; invalid continuation parks
    // the job suspended inside the controller and rethrows.
    const ctx: RecoveryContext = await this.controller.recover(jobId)
    const handle = ctx.handle
    const attempt = handle.ownership.generation
    this.active.set(jobId, { controller: abort, attempt, leaseToken: handle.ownership.token })
    let workspace: WorkspaceHandle | null = ctx.workspace
    try {
      if (!ctx.checkpoint) {
        // Crashed before the first commit boundary: nothing committed, safe
        // to start from step 0 with a fresh session.
        return await this.restartFromScratch(record, engine, handle, abort, workspace)
      }
      const checkpoint = ctx.checkpoint
      const executionId = checkpoint.executionId
      const history = engine.projectHistory(ctx.committedEvents)
      const session = await engine.restoreSession(
        { identity: { ...this.identityOf(record), jobId, executionId }, spec: record.spec, workspace },
        history,
      )
      // Revive the draft from the durable checkpoint. pendingInput is a pure
      // projection summary (user input admitted since the last assistant
      // turn) and is already part of the restored history.
      const draft: Draft = { ...checkpoint, attempt, status: "resuming" }
      await this.setStatus(record, attempt, "running")
      draft.status = "running"
      // Inputs already committed are part of the restored history; mark them
      // applied so the drain only picks up admissions after the watermark.
      const appliedInputs = new Set(
        ctx.committedEvents.filter((e) => e.type === "message" && (e.data as { role?: string }).role === "user").map((e) => e.seq),
      )
      return await this.loop(record, engine, session, draft, workspace, abort.signal, appliedInputs)
    } catch (error) {
      if (error instanceof SimulatedCrashError) throw error
      return await this.failJob(record, attempt, null, workspace, error)
    } finally {
      this.active.delete(jobId)
      await this.controller.release(handle).catch(() => {})
    }
  }

  async cancelJob(jobId: string): Promise<JobState> {
    const record = await this.requireRecord(jobId)
    if (isTerminal(record.status)) return this.toState(record)
    const next = await this.store.updateJobRecord(jobId, record.attempt, () => ({ cancelRequested: true }))
    const run = this.active.get(jobId)
    if (run) run.controller.abort()
    if (next.status === "queued" || next.status === "suspended") {
      return this.finalizeCancelled(next, null, null)
    }
    return this.toState(next)
  }

  async renewLease(jobId: string, leaseMs: number): Promise<LeaseRenewalResult> {
    const run = this.active.get(jobId)
    if (!run) return { renewed: false, reason: "not_found" }
    if (!this.store.renewLease) return { renewed: false, reason: "not_found" }
    return this.store.renewLease(jobId, run.leaseToken, leaseMs)
  }

  async suspendJob(jobId: string, reason: SuspensionReason = "worker_loss"): Promise<JobState> {
    const record = await this.requireRecord(jobId)
    if (isTerminal(record.status)) return this.toState(record)
    // Supervisor-side suspension: park at the latest safe boundary, capture a
    // compute snapshot when an environment is configured, then release the
    // lease. No model tokens are consumed while suspended.
    const handle: ActorHandle = {
      jobId,
      ownership: { jobId, generation: record.attempt, token: record.leaseToken ?? "supervisor", expiresAt: record.leaseExpiresAt ?? 0 },
      record,
    }
    const state = await this.controller.suspend(handle, reason)
    const run = this.active.get(jobId)
    if (run) run.controller.abort()
    return state
  }

  async submitInput(jobId: string, text: string): Promise<JobState> {
    const record = await this.requireRecord(jobId)
    if (isTerminal(record.status)) throw new InvalidJobStateError(jobId, record.status, "submit input to")
    await this.append(jobId, [{ jobId, timestamp: Date.now(), type: "message", data: { role: "user", text, admitted: true } }])
    return this.toState(record)
  }

  async getJobState(jobId: string): Promise<JobState> {
    const record = await this.requireRecord(jobId)
    return this.toState(record)
  }

  /** Control-plane read seam (Phase 1C): a resource-style view assembled from
   * the durable record, checkpoint usage, and admitted-but-pending input.
   * Returns null for unknown ids instead of throwing. */
  async getJob(jobId: string): Promise<JobView | null> {
    const record = await this.store.getJobRecord(jobId).catch(() => null)
    if (!record) return null
    const events = await this.store.listEvents(jobId)
    const checkpoint = await this.store.getCheckpoint(jobId)
    const watermark = checkpoint?.lastEventSeq ?? 0
    const pending = [...(checkpoint?.pendingInput ?? [])]
    for (const event of events) {
      if (event.type === "message" && event.seq > watermark) {
        const data = event.data as { role?: string; admitted?: boolean; text?: string }
        if (data.role === "user" && data.admitted && data.text) pending.push(data.text)
      }
    }
    return {
      id: record.jobId,
      tenantId: record.tenantId,
      orgId: record.orgId,
      projectId: record.projectId,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      usage: checkpoint?.usage ?? emptyMetrics(),
      pendingInput: pending,
    }
  }

  /** Non-following replay (Phase 1C control-plane read seam). */
  async listEvents(jobId: string, afterSeq = 0): Promise<JobEvent[]> {
    await this.requireRecord(jobId)
    return this.store.listEvents(jobId, afterSeq)
  }

  async collectUsage(jobId: string): Promise<JobMetrics> {
    const record = await this.requireRecord(jobId)
    const checkpoint = await this.store.getCheckpoint(jobId)
    if (checkpoint) return checkpoint.usage
    void record
    return emptyMetrics()
  }

  async *streamEvents(jobId: string, afterSeq = 0, signal?: AbortSignal): AsyncIterable<JobEvent> {
    await this.requireRecord(jobId)
    let last = afterSeq
    for (const event of await this.store.listEvents(jobId, afterSeq)) {
      yield event
      last = event.seq
    }
    const queue: JobEvent[] = []
    let notify: (() => void) | null = null
    const subscriber = (event: JobEvent): void => {
      queue.push(event)
      notify?.()
    }
    this.subscribe(jobId, subscriber)
    try {
      // Fill the gap between the replay snapshot and subscription.
      for (const event of await this.store.listEvents(jobId, last)) {
        if (event.seq > last) {
          yield event
          last = event.seq
        }
      }
      while (true) {
        while (queue.length > 0) {
          const event = queue.shift()!
          if (event.seq > last) {
            yield event
            last = event.seq
          }
          if (TERMINAL_EVENT_TYPES.has(event.type)) return
          if (event.type === "error" && (event.data as { terminal?: boolean }).terminal === true) return
        }
        if (signal?.aborted) return
        const record = await this.store.getJobRecord(jobId)
        if (record && isTerminal(record.status)) return
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 100)
          notify = () => {
            clearTimeout(timer)
            resolve()
          }
          signal?.addEventListener("abort", () => resolve(), { once: true })
        })
        notify = null
      }
    } finally {
      this.unsubscribe(jobId, subscriber)
    }
  }

  // -------------------------------------------------------------------------
  // Execution loop
  // -------------------------------------------------------------------------

  private async loop(
    record: JobRecord,
    engine: AgentEngine,
    session: EngineSession,
    draft: Draft,
    workspace: WorkspaceHandle | null,
    signal: AbortSignal,
    appliedInputs: Set<number>,
  ): Promise<JobState> {
    const policy = this.policyFor(record)
    for (;;) {
      const current = await this.requireRecord(record.jobId)
      if (current.cancelRequested || signal.aborted) return this.finalizeCancelled(current, draft, workspace)

      if (draft.continuation.type === "settle_tools") {
        await this.settleTools(record, engine, session, draft, workspace, signal, {
          stepIndex: draft.continuation.stepIndex,
          pendingKeys: [...draft.continuation.pendingToolCallIds],
          resume: true,
        })
        continue
      }
      if (draft.continuation.type === "done") {
        return this.completeJob(current, draft, workspace)
      }

      const stepIndex = draft.continuation.nextStepIndex
      if (stepIndex >= policy.maxSteps) {
        return this.failJob(current, draft.attempt, draft, workspace, new VaulltcoreError("MAX_STEPS", `Job exceeded max steps (${policy.maxSteps})`))
      }

      // Honor input admitted while the previous turn was running.
      await this.drainAdmittedInput(record.jobId, session, engine, draft, appliedInputs)

      // One provider turn per step. Turn outputs are committed atomically at
      // turn finish; a crash mid-turn loses only this uncommitted turn.
      const textParts: string[] = []
      const toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }> = []
      let turnUsage: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } = {}
      let finishReason: string = "stop"
      try {
        const toolDefs = [...this.tools.values()].map((t) => t.definition).filter((d) => policy.allowedTools.includes(d.name))
        for await (const event of engine.runTurn(session, toolDefs, signal)) {
          if (signal.aborted) break
          switch (event.type) {
            case "text":
              textParts.push(event.text)
              break
            case "tool_call":
              toolCalls.push({ toolCallId: event.toolCallId, toolName: event.toolName, input: event.input })
              break
            case "usage":
              turnUsage = {
                inputTokens: (turnUsage.inputTokens ?? 0) + (event.usage.inputTokens ?? 0),
                outputTokens: (turnUsage.outputTokens ?? 0) + (event.usage.outputTokens ?? 0),
                reasoningTokens: (turnUsage.reasoningTokens ?? 0) + (event.usage.reasoningTokens ?? 0),
              }
              break
            case "finish":
              finishReason = event.reason
              break
          }
        }
      } catch (error) {
        if (error instanceof SimulatedCrashError) throw error
        return this.failJob(record, draft.attempt, draft, workspace, error)
      }
      if (signal.aborted || finishReason === "cancelled") {
        return this.finalizeCancelled(await this.requireRecord(record.jobId), draft, workspace)
      }

      // Commit boundary: assistant turn.
      const message: ChatMessage = {
        role: "assistant",
        content: [
          ...(textParts.length > 0 ? [{ type: "text" as const, text: textParts.join("") }] : []),
          ...toolCalls.map((c) => ({ type: "tool_call" as const, toolCallId: c.toolCallId, toolName: c.toolName, input: c.input })),
        ],
      }
      const turnEvents: NewJobEvent[] = [
        {
          jobId: record.jobId,
          timestamp: Date.now(),
          type: "message",
          data: { role: "assistant", stepIndex, text: textParts.join("") || undefined, toolCalls },
        },
      ]
      if (Object.values(turnUsage).some((v) => (v ?? 0) > 0)) {
        turnEvents.push({ jobId: record.jobId, timestamp: Date.now(), type: "usage", data: { stepIndex, ...turnUsage } })
      }
      await this.append(record.jobId, turnEvents, draft.attempt)
      engine.recordAssistantTurn(session, message)
      draft.usage = addUsage(draft.usage, turnUsage)
      draft.usage.steps += 1
      draft.usage.toolCalls += toolCalls.length
      draft.lastCompletedStep = { stepIndex, finishedAt: Date.now() }
      draft.pendingInput = []

      // Phase 1F: runtime economic enforcement at a SAFE boundary. Model usage
      // is only known after a completed provider turn, so token/duration budgets
      // are checked here — after the turn's usage is durably committed but before
      // the next step begins. Overshoot is bounded to one provider turn. On
      // exhaustion the job transitions through a durable, explainable state
      // (budget_exhausted event + cancelled) preserving the checkpoint boundary;
      // the already-consumed resources stay durably accounted. Checkpoint
      // correctness is NEVER sacrificed to enforce billing/quota.
      const budgetHit = this.checkBudgets(record, draft, policy)
      if (budgetHit) {
        return this.finalizeBudgetExhausted(await this.requireRecord(record.jobId), draft, workspace, budgetHit)
      }

      if (toolCalls.length === 0) {
        draft.continuation = { type: "done" }
        return this.completeJob(await this.requireRecord(record.jobId), draft, workspace)
      }

      // Record every tool call durably BEFORE any side effect begins.
      const keys: string[] = []
      const requestEvents: NewJobEvent[] = toolCalls.map((call) => {
        const key = `${stepIndex}:${call.toolCallId}`
        keys.push(key)
        return {
          jobId: record.jobId,
          timestamp: Date.now(),
          type: "tool_request",
          data: { stepIndex, toolCallId: call.toolCallId, idempotencyKey: key, toolName: call.toolName, input: call.input },
        }
      })
      const stamped = await this.append(record.jobId, requestEvents, draft.attempt)
      for (const [i, key] of keys.entries()) {
        draft.toolCalls = { ...draft.toolCalls, [key]: { status: "recorded", recordedAtSeq: stamped[i]!.seq } }
      }
      draft.continuation = { type: "settle_tools", stepIndex, pendingToolCallIds: keys }
      await this.commitBoundary(record, draft)

      await this.settleTools(record, engine, session, draft, workspace, signal, {
        stepIndex,
        pendingKeys: keys,
        calls: toolCalls,
        resume: false,
      })
    }
  }

  /** Settle recorded tool calls with idempotency guarantees. */
  private async settleTools(
    record: JobRecord,
    engine: AgentEngine,
    session: EngineSession,
    draft: Draft,
    workspace: WorkspaceHandle | null,
    signal: AbortSignal,
    plan: { stepIndex: number; pendingKeys: string[]; calls?: Array<{ toolCallId: string; toolName: string; input: unknown }>; resume: boolean },
  ): Promise<void> {
    const policy = this.policyFor(record)
    const jobId = record.jobId
    const newResults: ChatMessage[] = []
    let events: JobEvent[] | null = null
    if (plan.resume) events = await this.store.listEvents(jobId)

    while (plan.pendingKeys.length > 0) {
      const current = await this.requireRecord(jobId)
      if (current.cancelRequested || signal.aborted) return
      const key = plan.pendingKeys[0]!
      const state = draft.toolCalls[key]
      const sep = key.indexOf(":")
      const stepIndex = Number(key.slice(0, sep))
      const toolCallId = key.slice(sep + 1)

      if (state?.status === "completed") {
        // Committed before the interruption: reuse, never re-execute. The
        // result is already part of the restored history via projection.
        plan.pendingKeys.shift()
        draft.continuation = { type: "settle_tools", stepIndex: plan.stepIndex, pendingToolCallIds: [...plan.pendingKeys] }
        await this.commitBoundary(record, draft)
        continue
      }

      // Resolve the recorded request (from the live plan or the durable log).
      let toolName: string | undefined
      let input: unknown
      if (!plan.resume) {
        const call = plan.calls?.find((c) => c.toolCallId === toolCallId)
        toolName = call?.toolName
        input = call?.input
      } else {
        const request = (events ?? []).find((e) => e.type === "tool_request" && (e.data as { idempotencyKey?: string }).idempotencyKey === key)
        const data = request?.data as { toolName?: string; input?: unknown } | undefined
        toolName = data?.toolName
        input = data?.input
      }
      if (!toolName) {
        throw new InvalidCheckpointError(jobId, `pending tool call ${key} has no recorded tool_request`)
      }

      const tool = this.tools.get(toolName)
      const allowed = policy.allowedTools.includes(toolName)
      const idempotent = tool?.definition.idempotent === true && policy.idempotentTools.includes(toolName)

      if (plan.resume && state?.status === "recorded" && !idempotent && allowed && tool) {
        // The call was durably recorded but no result was committed: it may
        // have partially executed with side effects. Do NOT blindly rerun.
        if (policy.onUncertainToolCall === "fail_job") {
          const current = await this.requireRecord(jobId)
          await this.failJob(current, draft.attempt, draft, workspace, new VaulltcoreError("UNCERTAIN_TOOL_CALL", `Tool call ${key} was recorded but never settled; refusing to re-execute`))
          return
        }
        const output = { error: "execution_interrupted", detail: "tool call was recorded but its outcome is unknown after worker loss" }
        const stamped = await this.append(
          jobId,
          [{ jobId, timestamp: Date.now(), type: "tool_response", data: { stepIndex, toolCallId, idempotencyKey: key, toolName, output, isError: true, uncertain: true } }],
          draft.attempt,
        )
        draft.toolCalls = { ...draft.toolCalls, [key]: { status: "uncertain", recordedAtSeq: state.recordedAtSeq, reason: "interrupted_before_result" } }
        plan.pendingKeys.shift()
        draft.continuation = { type: "settle_tools", stepIndex: plan.stepIndex, pendingToolCallIds: [...plan.pendingKeys] }
        await this.commitBoundary(record, draft)
        newResults.push({ role: "tool", content: [{ type: "tool_result", toolCallId: toolCallId!, toolName, output, isError: true, uncertain: true }] })
        continue
      }

      // Execute (fresh call, or idempotent re-execution after uncertainty).
      let output: unknown
      let isError = false
      if (!tool || !allowed) {
        output = { error: "tool_not_allowed", toolName }
        isError = true
      } else {
        const ctx: ToolContext = {
          job: { ...this.identityOf(record), jobId, executionId: draft.executionId },
          idempotencyKey: key,
          workspace,
          env: envForJob(record.env),
          signal,
        }
        try {
          output = await tool.execute(input, ctx)
        } catch (error) {
          if (error instanceof SimulatedCrashError) throw error
          output = { error: "tool_execution_failed", detail: error instanceof Error ? error.message : String(error) }
          isError = true
        }
      }
      const reconciled = plan.resume && state?.status === "recorded"
      const stamped = await this.append(
        jobId,
        [{ jobId, timestamp: Date.now(), type: "tool_response", data: { stepIndex, toolCallId, idempotencyKey: key, toolName, output, isError, ...(reconciled ? { reconciled: true } : {}) } }],
        draft.attempt,
      )
      draft.toolCalls = {
        ...draft.toolCalls,
        [key]: { status: "completed", recordedAtSeq: state?.status === "recorded" ? state.recordedAtSeq : stamped[0]!.seq, completedAtSeq: stamped[0]!.seq, resultSeq: stamped[0]!.seq },
      }
      plan.pendingKeys.shift()
      draft.continuation = { type: "settle_tools", stepIndex: plan.stepIndex, pendingToolCallIds: [...plan.pendingKeys] }
      await this.commitBoundary(record, draft)
      newResults.push({ role: "tool", content: [{ type: "tool_result", toolCallId: toolCallId!, toolName, output, isError }] })
    }

    if (newResults.length > 0) engine.recordToolResults(session, newResults)
    draft.continuation = { type: "provider_turn", nextStepIndex: plan.stepIndex + 1 }
    await this.commitBoundary(record, draft)
  }

  /**
   * Drain user input admitted at any point into the live session. Admission
   * seqs do not align with the commit watermark (input can arrive mid-turn or
   * mid-settlement), so application is tracked by event seq in
   * `appliedInputs`. Full-log scan is acceptable at Phase 1A scale; a typed
   * index is a Phase 1B optimization.
   */
  private async drainAdmittedInput(
    jobId: string,
    session: EngineSession,
    engine: AgentEngine,
    draft: Draft,
    appliedInputs: Set<number>,
  ): Promise<void> {
    const events = await this.store.listEvents(jobId, 0)
    for (const event of events) {
      if (event.type !== "message") continue
      const data = event.data as { role?: string; text?: string }
      if (data.role === "user" && data.text && !appliedInputs.has(event.seq)) {
        appliedInputs.add(event.seq)
        engine.recordUserInput(session, data.text)
        draft.pendingInput = [...draft.pendingInput, data.text]
      }
    }
  }

  // -------------------------------------------------------------------------
  // Terminal transitions
  // -------------------------------------------------------------------------

  private async completeJob(record: JobRecord, draft: Draft, workspace: WorkspaceHandle | null): Promise<JobState> {
    await this.append(record.jobId, [{ jobId: record.jobId, timestamp: Date.now(), type: "completed", data: { usage: draft.usage, steps: draft.usage.steps } }])
    draft.status = "completed"
    draft.continuation = { type: "done" }
    await this.commitBoundary(record, draft, "completed")
    const next = await this.store.updateJobRecord(record.jobId, draft.attempt, () => ({ status: "completed" as JobStatus, leaseToken: null, leaseExpiresAt: null }))
    await this.disposeEnvironment(record.jobId, workspace)
    return this.toState(next)
  }

  private async failJob(record: JobRecord, attempt: number, draft: Draft | null, workspace: WorkspaceHandle | null, error: unknown): Promise<JobState> {
    const message = error instanceof Error ? error.message : String(error)
    await this.append(record.jobId, [{ jobId: record.jobId, timestamp: Date.now(), type: "error", data: { terminal: true, message } }])
    if (draft) {
      draft.status = "failed"
      await this.commitBoundary(record, draft, "failed").catch(() => {})
    }
    const next = await this.store
      .updateJobRecord(record.jobId, attempt, () => ({ status: "failed" as JobStatus, error: message, leaseToken: null, leaseExpiresAt: null }))
      .catch(() => ({ ...record, status: "failed" as JobStatus, error: message }))
    await this.disposeEnvironment(record.jobId, workspace)
    return this.toState(next)
  }

  private async finalizeCancelled(record: JobRecord, draft: Draft | null, workspace: WorkspaceHandle | null): Promise<JobState> {
    await this.append(record.jobId, [{ jobId: record.jobId, timestamp: Date.now(), type: "cancelled", data: {} }])
    if (draft) {
      draft.status = "cancelled"
      await this.commitBoundary(record, draft, "cancelled").catch(() => {})
    }
    const next = await this.store
      .updateJobRecord(record.jobId, record.attempt, () => ({ status: "cancelled" as JobStatus, leaseToken: null, leaseExpiresAt: null }))
      .catch(() => ({ ...record, status: "cancelled" as JobStatus }))
    await this.disposeEnvironment(record.jobId, workspace)
    return this.toState(next)
  }

  /**
   * Phase 1F: evaluate token/duration budgets at a safe boundary. Returns the
   * exhaustion reason if a budget is exceeded, or null to continue. Token usage
   * is only known after a completed turn (bounded overshoot = one turn); the
   * turn's usage is already committed to `draft.usage` before this is called, so
   * accounting is preserved regardless of the outcome. Duration is measured from
   * the attempt start (`draft.createdAt`).
   */
  private checkBudgets(
    _record: JobRecord,
    draft: Draft,
    policy: ExecutionPolicy,
  ): BudgetExhaustionReason | null {
    const maxTokens = policy.maxTokens ?? null
    if (maxTokens !== null && draft.usage.totalTokens >= maxTokens) {
      return "token_budget_exhausted"
    }
    const maxDurationMs = policy.maxDurationMs ?? null
    if (maxDurationMs !== null && Date.now() - draft.createdAt >= maxDurationMs) {
      return "duration_budget_exhausted"
    }
    return null
  }

  /**
   * Phase 1F: durable budget-exhaustion transition. Emits a `budget_exhausted`
   * event carrying the reason + consumed resources, then finalizes as
   * `cancelled` through the SAME durable commit boundary as a normal
   * cancellation — so the checkpoint, committed usage, and continuation are all
   * preserved for reconciliation/recovery. The job is NOT silently killed: its
   * accounting for already-consumed resources stays durable and billable.
   */
  private async finalizeBudgetExhausted(
    record: JobRecord,
    draft: Draft,
    workspace: WorkspaceHandle | null,
    reason: BudgetExhaustionReason,
  ): Promise<JobState> {
    const policy = this.policyFor(record)
    const elapsedMs = Date.now() - draft.createdAt
    await this.append(record.jobId, [
      {
        jobId: record.jobId,
        timestamp: Date.now(),
        type: "budget_exhausted",
        data: {
          reason,
          consumedTokens: draft.usage.totalTokens,
          maxTokens: policy.maxTokens ?? null,
          elapsedMs,
          maxDurationMs: policy.maxDurationMs ?? null,
        },
      },
    ])
    draft.status = "cancelled"
    await this.commitBoundary(record, draft, "cancelled").catch(() => {})
    const next = await this.store
      .updateJobRecord(record.jobId, record.attempt, () => ({ status: "cancelled" as JobStatus, leaseToken: null, leaseExpiresAt: null }))
      .catch(() => ({ ...record, status: "cancelled" as JobStatus }))
    await this.disposeEnvironment(record.jobId, workspace)
    return this.toState(next)
  }

  /** Materialize the job's execution environment/workspace. */
  private async createEnvironment(jobId: string): Promise<WorkspaceHandle | null> {
    if (this.environment) return this.environment.create(jobId)
    if (this.workspace) return this.workspace.prepare(jobId)
    return null
  }

  private async disposeEnvironment(jobId: string, workspace: WorkspaceHandle | null): Promise<void> {
    await this.controller.destroy(jobId, workspace).catch(() => {})
  }

  // -------------------------------------------------------------------------
  // Checkpoint + event plumbing
  // -------------------------------------------------------------------------

  private newDraft(record: JobRecord, attempt: number, executionId: string, lastEventSeq: number): Draft {
    return {
      jobId: record.jobId,
      tenantId: record.tenantId,
      orgId: record.orgId,
      projectId: record.projectId,
      executionId,
      status: "running",
      attempt,
      lastEventSeq,
      lastCompletedStep: null,
      toolCalls: {},
      pendingInput: [],
      continuation: { type: "provider_turn", nextStepIndex: 0 },
      contextRef: { kind: "event_projection", throughSeq: lastEventSeq },
      usage: emptyMetrics(),
      policyVersion: this.policyFor(record).version,
      engineVersion: this.engineFor(record).version,
      createdAt: Date.now(),
    }
  }

  /** One commit boundary: append the `checkpoint` event, then persist the checkpoint. */
  private async commitBoundary(record: JobRecord, draft: Draft, resumeStatus: JobStatus = "running"): Promise<void> {
    await this.setStatus(record, draft.attempt, "checkpointing")
    draft.status = "checkpointing"
    const stamped = await this.append(
      record.jobId,
      [
        {
          jobId: record.jobId,
          timestamp: Date.now(),
          type: "checkpoint",
          data: {
            continuation: draft.continuation,
            steps: draft.usage.steps,
            toolCalls: Object.keys(draft.toolCalls).length,
            pendingInput: draft.pendingInput.length,
          },
        },
      ],
      draft.attempt,
    )
    draft.lastEventSeq = stamped[0]!.seq
    draft.contextRef = { kind: "event_projection", throughSeq: draft.lastEventSeq }
    draft.status = resumeStatus
    await this.store.saveCheckpoint(record.jobId, finalizeCheckpoint(draft))
    if (!isTerminal(resumeStatus)) await this.setStatus(record, draft.attempt, resumeStatus)
  }

  private async append(jobId: string, events: NewJobEvent[], expectedAttempt?: number): Promise<JobEvent[]> {
    const stamped = await this.store.appendEvents(jobId, events, expectedAttempt)
    for (const event of stamped) {
      const subs = this.subscribers.get(jobId)
      if (subs) for (const sub of subs) sub(event)
    }
    return stamped
  }

  private subscribe(jobId: string, sub: (event: JobEvent) => void): void {
    let subs = this.subscribers.get(jobId)
    if (!subs) {
      subs = new Set()
      this.subscribers.set(jobId, subs)
    }
    subs.add(sub)
  }

  private unsubscribe(jobId: string, sub: (event: JobEvent) => void): void {
    const subs = this.subscribers.get(jobId)
    if (!subs) return
    subs.delete(sub)
    if (subs.size === 0) this.subscribers.delete(jobId)
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async requireRecord(jobId: string): Promise<JobRecord> {
    const record = await this.store.getJobRecord(jobId)
    if (!record) throw new JobNotFoundError(jobId)
    return record
  }

  private async setStatus(record: JobRecord, attempt: number, status: JobStatus, error?: string): Promise<JobRecord> {
    return this.store.updateJobRecord(record.jobId, attempt, () => ({ status, ...(error !== undefined ? { error } : {}) }))
  }

  private engineFor(record: JobRecord): AgentEngine {
    const engine = this.engines.get(record.spec.engine)
    if (!engine) throw new EngineNotFoundError(record.spec.engine)
    return engine
  }

  private policyFor(record: JobRecord): ExecutionPolicy {
    return record.policy
  }

  private identityOf(record: JobRecord): { tenantId: string; orgId: string; projectId: string } {
    return { tenantId: record.tenantId, orgId: record.orgId, projectId: record.projectId }
  }

  private async restartFromScratch(
    record: JobRecord,
    engine: AgentEngine,
    handle: ActorHandle,
    controller: AbortController,
    workspace: WorkspaceHandle | null,
  ): Promise<JobState> {
    // No checkpoint exists: nothing was ever committed, so a clean start is
    // the correct continuation. (runJob path could not be reused because the
    // record is not queued anymore.)
    const jobId = record.jobId
    const attempt = handle.ownership.generation
    try {
      const executionId = newExecutionId()
      const session = await engine.createSession({ identity: { ...this.identityOf(record), jobId, executionId }, spec: record.spec, workspace })
      const started = await this.append(jobId, [{ jobId, timestamp: Date.now(), type: "started", data: { attempt, executionId, reason: "no_checkpoint" } }], attempt)
      const draft = this.newDraft(record, attempt, executionId, started[0]!.seq)
      const appliedInputs = new Set<number>()
      await this.drainAdmittedInput(jobId, session, engine, draft, appliedInputs)
      await this.setStatus(record, attempt, "running")
      await this.commitBoundary(record, draft)
      return await this.loop(record, engine, session, draft, workspace, controller.signal, appliedInputs)
    } catch (error) {
      if (error instanceof SimulatedCrashError) throw error
      return this.failJob(record, attempt, null, workspace, error)
    }
  }

  private async toState(record: JobRecord): Promise<JobState> {
    const checkpoint = await this.store.getCheckpoint(record.jobId)
    let lastEventSeq = checkpoint?.lastEventSeq ?? 0
    if (lastEventSeq === 0) lastEventSeq = (await this.store.listEvents(record.jobId)).length
    return {
      jobId: record.jobId,
      identity: this.identityOf(record),
      status: record.status,
      attempt: record.attempt,
      lastEventSeq,
      usage: checkpoint?.usage ?? emptyMetrics(),
      error: record.error,
      checkpoint,
    }
  }
}
