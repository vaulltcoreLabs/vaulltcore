/**
 * Shared test fixtures for the automation package (Phase 2A).
 *
 * A deterministic {@link FakeJobDispatcher} that records calls, deduplicates on
 * idempotency key, and lets tests preset a terminal assistant text + job state
 * per step. Plus helpers to build a minimal version definition + principal.
 */

import { type JobEvent, type JobState, type JobMetrics } from "@vaulltcore/runner"
import type { ResolvedPrincipal, Role } from "@vaulltcore/identity"
import { type AutomationDefinition, type InputContract, type AutomationStep, type DispatchStepRequest, type DispatchStepResult, type AutomationJobDispatcher } from "../src"

/** A deterministic dispatcher that simulates the Phase 1 kernel for tests.
 *  Outcomes are keyed by stepId so tests can configure each step independently
 *  and override them at any time before the step is dispatched. */
export class FakeJobDispatcher implements AutomationJobDispatcher {
  readonly calls: DispatchStepRequest[] = []
  private readonly jobs = new Map<string, { events: JobEvent[]; state: JobState }>()
  private readonly byIdempotencyKey = new Map<string, string>()
  private seq = 0
  /** Preset the terminal assistant text + status a step's job should report. */
  private readonly stepOutcomes = new Map<string, { text: string; status: JobState["status"]; error?: string }>()
  /** When set, the next dispatchAndRun creates + records the job but throws
   *  before returning — emulating a crash after job creation before projection. */
  crashAfterJob = false

  /** Configure the outcome for a stepId. The dispatcher synthesizes a started +
   *  assistant message + completed (or error) event sequence. */
  setStepOutcome(stepId: string, outcome: { text: string; status?: JobState["status"]; error?: string }): void {
    this.stepOutcomes.set(stepId, { text: outcome.text, status: outcome.status ?? "completed", error: outcome.error })
  }

  async dispatchAndRun(request: DispatchStepRequest): Promise<DispatchStepResult> {
    this.calls.push(request)
    const existing = this.byIdempotencyKey.get(request.idempotencyKey)
    if (existing) {
      const job = this.jobs.get(existing)!
      return { jobId: existing, replayed: true, state: job.state }
    }
    const jobId = `job_${this.seq++}`
    // Derive the stepId from the idempotency key (format: auto:runId:stepId) so
    // the outcome lookup is stable regardless of the resolved prompt text.
    const stepId = request.idempotencyKey.split(":").pop() ?? "default"
    const outcome = this.stepOutcomes.get(stepId) ?? { text: `{"result":"${request.input}"}`, status: "completed" as const }
    const events = this.synthesizeEvents(jobId, request, outcome)
    const usage: JobMetrics = {
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 0,
      totalTokens: 15,
      steps: events.filter((e) => e.type === "message" && (e.data as { role?: string }).role === "assistant").length,
      toolCalls: 0,
    }
    const state: JobState = {
      jobId,
      identity: { ...request.identity },
      status: outcome.status,
      attempt: 1,
      lastEventSeq: events.length,
      usage,
      error: outcome.error ?? null,
      checkpoint: null,
    }
    this.jobs.set(jobId, { events, state })
    this.byIdempotencyKey.set(request.idempotencyKey, jobId)
    // Emulate a crash after the job was durably created but before the caller
    // could project the result. The job survives (durable), the call throws.
    if (this.crashAfterJob) {
      this.crashAfterJob = false
      throw new Error("simulated crash after job creation")
    }
    return { jobId, replayed: false, state }
  }

  private synthesizeEvents(jobId: string, request: DispatchStepRequest, outcome: { text: string; status: JobState["status"]; error?: string }): JobEvent[] {
    const now = Date.now()
    const events: JobEvent[] = [
      { jobId, seq: 1, timestamp: now, type: "queued", data: { engine: request.engine, model: request.model } },
      { jobId, seq: 2, timestamp: now, type: "started", data: { attempt: 1, executionId: "exec" } },
    ]
    if (outcome.status === "completed") {
      events.push({ jobId, seq: 3, timestamp: now, type: "message", data: { role: "assistant", stepIndex: 0, text: outcome.text, toolCalls: [] } })
      events.push({ jobId, seq: 4, timestamp: now, type: "usage", data: { stepIndex: 0, inputTokens: 10, outputTokens: 5, durationMs: 100 } })
      events.push({ jobId, seq: 5, timestamp: now, type: "completed", data: { usage: { inputTokens: 10, outputTokens: 5, steps: 1 }, steps: 1 } })
    } else if (outcome.status === "failed") {
      events.push({ jobId, seq: 3, timestamp: now, type: "error", data: { terminal: true, message: outcome.error ?? "step failed" } })
    }
    return events
  }

  async listJobEvents(jobId: string, afterSeq = 0): Promise<readonly JobEvent[]> {
    const job = this.jobs.get(jobId)
    return job ? job.events.filter((e) => e.seq > afterSeq) : []
  }

  async getJobState(jobId: string): Promise<JobState | null> {
    return this.jobs.get(jobId)?.state ?? null
  }

  /** Test helper: total distinct jobs created (replays excluded). */
  distinctJobCount(): number {
    return this.jobs.size
  }
}

/** A minimal single-step definition with an artifact + no approval. */
export function simpleDefinition(args: {
  readonly prompt?: string
  readonly outputText?: string
  readonly requiresApproval?: boolean
  readonly destination?: string
}): AutomationDefinition {
  return {
    steps: [
      simpleStep({ stepId: "step1", prompt: args.prompt ?? "${input.query}" }),
    ],
    artifacts: [{ artifactId: "art1", stepId: "step1", type: "text", name: "result.txt", path: "result" }],
    approval: {
      required: args.requiresApproval ?? false,
      gateId: args.requiresApproval ? "gate1" : "",
      minApproverRole: "operator",
      contextArtifacts: [],
      expiresAfterMs: null,
    },
    delivery: {
      destination: args.destination ?? "test-destination",
      artifactIds: [],
    },
  }
}

/** Build a complete AutomationStep (avoids partial-spread type widening in tests). */
export function simpleStep(args: {
  readonly stepId: string
  readonly prompt?: string
  readonly dependsOn?: readonly string[]
  readonly outputKey?: string
}): AutomationStep {
  return {
    stepId: args.stepId,
    execution: {
      engine: "script",
      model: "test",
      prompt: args.prompt ?? "${input.query}",
      maxSteps: 10,
      maxTokens: null,
      maxDurationMs: null,
      allowedTools: [],
      engineOptions: {},
    },
    inputMappings: [{ fieldId: "query", placeholder: "query" }],
    outputMappings: [{ key: args.outputKey ?? "result", path: args.outputKey ?? "result" }],
    dependsOn: args.dependsOn ?? [],
  }
}

export function simpleInputContract(): InputContract {
  return {
    fields: [
      { fieldId: "query", type: "string", required: true, description: null },
    ],
  }
}

export function adminPrincipal(tenantId = "tenant_a", orgId = "org_a", projectId = "proj_a"): ResolvedPrincipal {
  return {
    principalId: `user:${tenantId}`,
    kind: "user",
    tenantId,
    orgId,
    role: "admin",
    projectScope: ["*"],
    admin: true,
  }
}

export function memberPrincipal(tenantId = "tenant_a", orgId = "org_a", projectId = "proj_a", role: Role = "operator"): ResolvedPrincipal {
  return {
    principalId: `member:${tenantId}`,
    kind: "user",
    tenantId,
    orgId,
    role,
    projectScope: [projectId],
    admin: false,
  }
}
