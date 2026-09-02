/**
 * AutomationService — the product orchestration layer (Phase 2A).
 *
 * Ties templates → versions → runs → jobs → artifacts → approvals → delivery
 * together above the Phase 1 kernel. It orchestrates Phase 1 jobs; it does NOT
 * execute models directly. Job creation/run/observation goes through the narrow
 * {@link AutomationJobDispatcher} seam (implemented by the control plane over
 * the existing admission/runner contracts), so the product layer never depends
 * on runner internals.
 *
 * Recovery: if orchestration crashes after a job was created but before the
 * mapping was projected, {@link reconcileRun} reads the durable job mappings
 * (UNIQUE (runId, stepId)) and re-projects safe state — it never creates new
 * execution work. A restart never creates a duplicate job for the same step
 * because the dispatcher's idempotency key is derived from (runId, stepId) and
 * the admission pipeline collapses a duplicate create into the original job.
 *
 * Execution guarantee: at-least-once with durable idempotent settlement at
 * explicitly defined identity boundaries (job mappings, approvals, deliveries,
 * artifacts). Exactly-once execution is NOT claimed.
 */

import type { JobEvent, JobIdentity, JobState } from "@vaulltcore/runner"
import { type ResolvedPrincipal, IdentityError, ROLE_RANK } from "@vaulltcore/identity"
import type { SqlAuditStore, AuditInput } from "@vaulltcore/audit"
import { sanitizeMetadata } from "@vaulltcore/audit"
import {
  type ApprovalRequest,
  type ArtifactStore,
  type AutomationArtifact,
  type AutomationEvent,
  type AutomationRun,
  type AutomationTemplate,
  type AutomationVersion,
  type DeliveryAttempt,
  type DeliveryProvider,
  type JobMapping,
  type RunInputRevision,
  type RunStepState,
  AutomationError,
} from "./contracts"
import type { AutomationStore } from "./store"
import { type ApprovalDecision, authorizeApprover, buildApprovalRequest } from "./approval"
import { buildDeliveryAttempt, settleDelivered, settleFailed, startAttempt } from "./delivery"
import { buildArtifact, contentChecksum, verifyArtifact } from "./artifact"
import { buildInputRevision, validateInput, valuesToMap } from "./input"
import { buildRun } from "./run"
import { buildVersion, executionOrder } from "./version"
import { newMappingId, stepIdempotencyKey } from "./ids"
import { projectStepEvents, stepStatusFromJobStatus, automationEvent } from "./projection"

// ---------------------------------------------------------------------------
// Narrow job-dispatcher seam (implemented by the control plane)
// ---------------------------------------------------------------------------

/** A step's resolved execution request handed to the dispatcher. */
export interface DispatchStepRequest {
  readonly identity: JobIdentity
  readonly engine: string
  readonly model: string
  readonly input: string
  readonly engineOptions?: Record<string, unknown>
  readonly maxSteps?: number | null
  readonly maxTokens?: number | null
  readonly maxDurationMs?: number | null
  readonly allowedTools?: readonly string[]
  /** Idempotency key derived from (runId, stepId) — collapses duplicate creates. */
  readonly idempotencyKey: string
}

/** The outcome of dispatching a step to the Phase 1 kernel. */
export interface DispatchStepResult {
  readonly jobId: string
  /** Whether this dispatch reused an existing job (idempotent replay). */
  readonly replayed: boolean
  /** Final terminal job state, if the dispatcher ran the job to completion. */
  readonly state: JobState
}

/**
 * Narrow seam over the Phase 1 admission + runner contracts. The control plane
 * implements this; the automation product layer never calls the runner directly.
 * The dispatcher decides how/where the job runs (worker dispatch, inline run,
 * …); the product layer only records the durable mapping + observes events.
 *
 * The dispatcher MUST be idempotent on `idempotencyKey`: a replay returns the
 * original job without creating duplicate work.
 */
export interface AutomationJobDispatcher {
  dispatchAndRun(request: DispatchStepRequest): Promise<DispatchStepResult>
  /** Observe committed events for a job (non-following replay). */
  listJobEvents(jobId: string, afterSeq?: number): Promise<readonly JobEvent[]>
  /** Read a job's current state (for projection). */
  getJobState(jobId: string): Promise<JobState | null>
}

// ---------------------------------------------------------------------------
// Service dependencies
// ---------------------------------------------------------------------------

export interface AutomationServiceDeps {
  readonly store: AutomationStore
  readonly artifacts: ArtifactStore
  readonly delivery: DeliveryProvider
  readonly dispatcher: AutomationJobDispatcher
  readonly audit: SqlAuditStore
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function auditActor(principal: ResolvedPrincipal) {
  return { principalId: principal.principalId, kind: principal.kind, tenantId: principal.tenantId }
}

function scopeOf(scope: JobIdentity): JobIdentity {
  return { tenantId: scope.tenantId, orgId: scope.orgId, projectId: scope.projectId }
}

/** Resolve a step prompt template against durable input + completed step outputs. */
function resolvePrompt(template: string, input: Readonly<Record<string, unknown>>, stepOutputs: ReadonlyMap<string, Readonly<Record<string, unknown>>>): string {
  return template.replace(/\$\{input\.([a-zA-Z0-9_]+)\}/g, (_, field) => {
    const v = input[field]
    return v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v)
  }).replace(/\$\{steps\.([a-zA-Z0-9_]+)\.output\.([a-zA-Z0-9_]+)\}/g, (_, stepId, key) => {
    const outs = stepOutputs.get(stepId)
    const v = outs?.[key]
    return v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v)
  })
}

/** Extract outputs from a completed job's terminal assistant text. Phase 2A uses
 *  a simple JSON-parsing convention: the step's output mappings read keys from a
 *  JSON object the assistant produced. If the text is not JSON, the whole text is
 *  placed under a `text` key. */
function extractOutputs(text: string, mappings: ReadonlyArray<{ readonly key: string; readonly path: string }>): Record<string, unknown> {
  let parsed: unknown = text
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = { text }
  }
  const out: Record<string, unknown> = {}
  for (const m of mappings) {
    out[m.key] = readPath(parsed, m.path)
  }
  if (Object.keys(out).length === 0) out.text = text
  return out
}

function readPath(value: unknown, path: string): unknown {
  if (!path) return value
  const parts = path.split(".")
  let cur: unknown = value
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p]
    } else {
      return undefined
    }
  }
  return cur
}

/** Read the last assistant message text from a job's committed events. */
function lastAssistantText(events: ReadonlyArray<{ readonly type: string; readonly data: unknown }>): string {
  let text = ""
  for (const e of events) {
    if (e.type === "message" && (e.data as { role?: string }).role === "assistant") {
      const t = (e.data as { text?: string }).text
      if (t) text = t
    }
  }
  return text
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class AutomationService {
  constructor(private readonly deps: AutomationServiceDeps) {}

  // -- templates -----------------------------------------------------------
  async createTemplate(args: {
    readonly principal: ResolvedPrincipal
    readonly orgId: string
    readonly projectId: string
    readonly name: string
    readonly description?: string | null
  }): Promise<AutomationTemplate> {
    await this.authorize(args.principal, args.orgId, args.projectId)
    const now = Date.now()
    const template: AutomationTemplate = {
      templateId: `tmpl_${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      tenantId: args.principal.tenantId,
      orgId: args.orgId,
      projectId: args.projectId,
      name: args.name,
      description: args.description ?? null,
      status: "draft",
      createdAt: now,
      createdBy: args.principal.principalId,
      archivedAt: null,
    }
    const created = await this.deps.store.createTemplate(template)
    await this.audit(args.principal, scopeOf(template), "automation_template_created", { templateId: created.templateId, name: created.name })
    return created
  }

  async getTemplate(principal: ResolvedPrincipal, templateId: string): Promise<AutomationTemplate | null> {
    const t = await this.deps.store.getTemplate(principal.tenantId, templateId)
    if (!t) return null
    if (!await this.canAccess(principal, t.orgId, t.projectId)) return null
    return t
  }

  async archiveTemplate(principal: ResolvedPrincipal, templateId: string): Promise<AutomationTemplate | null> {
    const t = await this.getTemplate(principal, templateId)
    if (!t) return null
    const archived = await this.deps.store.archiveTemplate(principal.tenantId, templateId)
    if (archived) {
      await this.audit(principal, scopeOf(archived), "automation_template_archived", { templateId })
    }
    return archived
  }

  // -- versions ------------------------------------------------------------
  async publishVersion(args: {
    readonly principal: ResolvedPrincipal
    readonly templateId: string
    readonly definition: AutomationVersion["definition"]
    readonly inputContract: AutomationVersion["inputContract"]
  }): Promise<AutomationVersion> {
    const t = await this.getTemplate(args.principal, args.templateId)
    if (!t) throw new AutomationError("TEMPLATE_NOT_FOUND", `Template ${args.templateId} not found`, 404)
    if (t.status === "archived") throw new AutomationError("TEMPLATE_ARCHIVED", `Template ${args.templateId} is archived`, 409)
    const versionNumber = await this.deps.store.nextVersionNumber(args.principal.tenantId, args.templateId)
    const version = buildVersion({
      tenantId: t.tenantId,
      orgId: t.orgId,
      projectId: t.projectId,
      templateId: t.templateId,
      version: versionNumber,
      definition: args.definition,
      inputContract: args.inputContract,
      createdBy: args.principal.principalId,
    })
    const saved = await this.deps.store.createVersion(version)
    await this.audit(args.principal, scopeOf(t), "automation_version_published", { templateId: t.templateId, versionId: saved.versionId, version: saved.version, checksum: saved.checksum })
    return saved
  }

  async getVersion(principal: ResolvedPrincipal, versionId: string): Promise<AutomationVersion | null> {
    const v = await this.deps.store.getVersion(principal.tenantId, versionId)
    if (!v) return null
    if (!await this.canAccess(principal, v.orgId, v.projectId)) return null
    return v
  }

  async listVersions(principal: ResolvedPrincipal, templateId: string): Promise<AutomationVersion[]> {
    const t = await this.getTemplate(principal, templateId)
    if (!t) return []
    return this.deps.store.listVersions(principal.tenantId, templateId)
  }

  async listTemplates(principal: ResolvedPrincipal, orgId?: string, projectId?: string): Promise<AutomationTemplate[]> {
    return this.deps.store.listTemplates(principal.tenantId, orgId, projectId)
  }

  // -- runs ---------------------------------------------------------------
  /** Create + durably advance a run through input validation → admission. The
   *  accepted input is frozen as a revision; invalid input creates no job and no
   *  run (validation happens before any persistence). Duplicate create requests
   *  under the same idempotency key return the existing run. */
  async createRun(args: {
    readonly principal: ResolvedPrincipal
    readonly orgId: string
    readonly projectId: string
    readonly templateId: string
    readonly versionId: string
    readonly input: ReadonlyArray<{ readonly fieldId: string; readonly value: unknown }>
    readonly idempotencyKey: string
  }): Promise<AutomationRun> {
    await this.authorize(args.principal, args.orgId, args.projectId)
    const version = await this.deps.store.getVersion(args.principal.tenantId, args.versionId)
    if (!version) throw new AutomationError("VERSION_NOT_FOUND", `Version ${args.versionId} not found`, 404)
    if (version.templateId !== args.templateId) {
      throw new AutomationError("VERSION_TEMPLATE_MISMATCH", `Version ${args.versionId} does not belong to template ${args.templateId}`, 400)
    }
    if (version.tenantId !== args.principal.tenantId || version.orgId !== args.orgId || version.projectId !== args.projectId) {
      throw new AutomationError("VERSION_SCOPE_MISMATCH", `Version ${args.versionId} does not belong to this project`, 403)
    }
    const template = await this.deps.store.getTemplate(args.principal.tenantId, args.templateId)
    if (!template) throw new AutomationError("TEMPLATE_NOT_FOUND", `Template ${args.templateId} not found`, 404)
    if (template.status === "archived") throw new AutomationError("TEMPLATE_ARCHIVED", `Template ${args.templateId} is archived`, 409)

    // Idempotency: a replay under the same key returns the existing run if any.
    const existing = await this.findRunByIdempotency(args.principal.tenantId, args.idempotencyKey)
    if (existing) {
      if (existing.templateId !== args.templateId || existing.versionId !== args.versionId) {
        throw new AutomationError("IDEMPOTENCY_CONFLICT", `Idempotency key reused with a different template/version`, 409)
      }
      return existing
    }

    // Validate input BEFORE persisting anything: invalid input creates no run
    // and no job.
    const valuesMap = valuesToMap(args.input)
    validateInput(version.inputContract, valuesMap)

    const run = buildRun({
      tenantId: args.principal.tenantId,
      orgId: args.orgId,
      projectId: args.projectId,
      templateId: args.templateId,
      versionId: args.versionId,
      version: version.version,
      inputRevisionId: "", // set below once the revision is built
      createdBy: args.principal.principalId,
    })
    // Build the durable input revision (runId is known), then persist the run
    // carrying the revision id so the run record is honest from the start.
    const revision = buildInputRevision({ runId: run.runId, values: valuesMap })
    const runWithRevision: AutomationRun = { ...run, inputRevisionId: revision.inputRevisionId }
    await this.deps.store.createRun(runWithRevision)
    this.idempotencyKeys.set(this.idemKey(args.principal.tenantId, args.idempotencyKey), run.runId)

    // created → validating_input → admitted
    const validating = await this.deps.store.transitionRun(args.principal.tenantId, run.runId, runWithRevision.runVersion, "validating_input")
    await this.deps.store.saveInputRevision(revision)
    const admitted = await this.deps.store.transitionRun(args.principal.tenantId, run.runId, validating.runVersion, "admitted")
    await this.appendAutomationEvent(args.principal.tenantId, admitted, "automation.run.created", { runId: run.runId, templateId: args.templateId, versionId: args.versionId })
    await this.appendAutomationEvent(args.principal.tenantId, admitted, "automation.run.admitted", { runId: run.runId, inputRevisionId: revision.inputRevisionId })
    await this.audit(args.principal, scopeOf(admitted), "automation_run_created", { runId: run.runId, templateId: args.templateId, versionId: args.versionId, inputRevisionId: revision.inputRevisionId })
    return admitted
  }

  private readonly idempotencyKeys = new Map<string, string>()
  private idemKey(tenantId: string, key: string): string {
    return `${tenantId}|${key}`
  }
  private async findRunByIdempotency(tenantId: string, key: string): Promise<AutomationRun | null> {
    const runId = this.idempotencyKeys.get(this.idemKey(tenantId, key))
    if (!runId) return null
    return this.deps.store.getRun(tenantId, runId)
  }

  async getRun(principal: ResolvedPrincipal, runId: string): Promise<AutomationRun | null> {
    const run = await this.deps.store.getRun(principal.tenantId, runId)
    if (!run) return null
    // Authorization failure returns null (no existence leak), mirroring the
    // cross-tenant path: a caller without project scope sees "not found".
    if (!await this.canAccess(principal, run.orgId, run.projectId)) return null
    return run
  }

  async listRuns(principal: ResolvedPrincipal, orgId?: string, projectId?: string): Promise<AutomationRun[]> {
    return this.deps.store.listRuns(principal.tenantId, orgId, projectId)
  }

  async cancelRun(principal: ResolvedPrincipal, runId: string): Promise<AutomationRun> {
    const run = await this.getRun(principal, runId)
    if (!run) throw new AutomationError("RUN_NOT_FOUND", `Run ${runId} not found`, 404)
    if (run.status === "completed" || run.status === "failed" || run.status === "rejected" || run.status === "cancelled") {
      return run
    }
    const updated = await this.deps.store.transitionRun(principal.tenantId, runId, run.runVersion, "cancelled")
    await this.appendAutomationEvent(principal.tenantId, run, "automation.run.failed", { reason: "cancelled" })
    await this.audit(principal, scopeOf(run), "automation_run_cancelled", { runId })
    return updated
  }

  async listRunEvents(principal: ResolvedPrincipal, runId: string, afterSeq?: number): Promise<AutomationEvent[]> {
    const run = await this.getRun(principal, runId)
    if (!run) return []
    return this.deps.store.listEvents(principal.tenantId, runId, afterSeq)
  }

  async listRunArtifacts(principal: ResolvedPrincipal, runId: string): Promise<AutomationArtifact[]> {
    const run = await this.getRun(principal, runId)
    if (!run) return []
    return this.deps.store.listArtifacts(principal.tenantId, runId)
  }

  /** List delivery attempts for a run (tenant-scoped; empty for cross-tenant). */
  async listRunDeliveries(principal: ResolvedPrincipal, runId: string): Promise<DeliveryAttempt[]> {
    const run = await this.getRun(principal, runId)
    if (!run) return []
    return this.deps.store.listDeliveryAttempts(principal.tenantId, runId)
  }

  // -- orchestration -------------------------------------------------------

  /** Advance a run: dispatch each pending step in dependency order, project
   *  state, collect artifacts, pause for approval, deliver. Idempotent + crash-
   *  safe: re-running on an already-advanced run re-projects from durable
   *  mappings without duplicating work. */
  async advanceRun(principal: ResolvedPrincipal, runId: string): Promise<AutomationRun> {
    let run = await this.getRun(principal, runId)
    if (!run) throw new AutomationError("RUN_NOT_FOUND", `Run ${runId} not found`, 404)
    const version = await this.deps.store.getVersion(principal.tenantId, run.versionId)
    if (!version) throw new AutomationError("VERSION_NOT_FOUND", `Version ${run.versionId} not found`, 500)
    const revision = await this.deps.store.getInputRevision(principal.tenantId, runId, run.inputRevisionId)
    if (!revision) throw new AutomationError("INPUT_NOT_FOUND", `Input revision ${run.inputRevisionId} not found`, 500)

    // admitted → running
    if (run.status === "admitted") {
      run = await this.deps.store.transitionRun(principal.tenantId, runId, run.runVersion, "running")
    }
    if (run.status !== "running" && run.status !== "collecting") {
      return run
    }

    const order = executionOrder(version.definition.steps)
    const stepOutputs = new Map<string, Readonly<Record<string, unknown>>>()
    for (const stepId of order) {
      const step = version.definition.steps.find((s) => s.stepId === stepId)!
      const existingState = await this.deps.store.getStepState(principal.tenantId, runId, stepId)
      if (existingState?.status === "completed") {
        stepOutputs.set(stepId, existingState.outputs)
        continue
      }
      if (existingState?.status === "failed") {
        // A failed step fails the run deterministically.
        run = await this.deps.store.transitionRun(principal.tenantId, runId, run.runVersion, "failed", { error: existingState.error ?? "step failed" })
        await this.appendAutomationEvent(principal.tenantId, run, "automation.run.failed", { stepId, reason: "step_failed" })
        return run
      }
      // Dispatch the step's job (idempotent on (runId, stepId)).
      const prompt = resolvePrompt(step.execution.prompt, revision.values, stepOutputs)
      const mapping = await this.dispatchStep(principal, run, version, step, prompt, revision.inputRevisionId)
      // Project the job's events into automation events + step state.
      const jobState = mapping.jobState
      const events = await this.deps.dispatcher.listJobEvents(mapping.jobId, 0)
      const projected = projectStepEvents({ runId: runId, stepId, jobId: mapping.jobId, events, startSeq: await this.nextSeq(principal.tenantId, runId) })
      for (const ev of projected.events) await this.deps.store.appendEvent(principal.tenantId, ev)
      const status = stepStatusFromJobStatus(jobState.status)
      // Extract outputs from the job's terminal assistant text (the last
      // assistant message in the committed events), per the step's output map.
      const terminalText = lastAssistantText(events)
      const outputs = status === "completed" ? extractOutputs(terminalText, step.outputMappings) : {}
      const stepState: RunStepState = {
        runId: runId,
        stepId,
        status,
        jobId: mapping.jobId,
        outputs,
        startedAt: null,
        completedAt: status === "completed" ? Date.now() : null,
        error: jobState.error,
      }
      await this.deps.store.upsertStepState(stepState)
      if (status === "failed") {
        run = await this.deps.store.transitionRun(principal.tenantId, runId, run.runVersion, "failed", { error: jobState.error ?? "step failed" })
        await this.appendAutomationEvent(principal.tenantId, run, "automation.run.failed", { stepId, reason: "step_failed", jobId: mapping.jobId })
        await this.audit(principal, scopeOf(run), "automation_run_failed", { runId, stepId, jobId: mapping.jobId })
        return run
      }
      if (status !== "completed") {
        // Job not terminal yet (shouldn't happen after dispatchAndRun, but be
        // safe): leave the run running and return for a later advance.
        return run
      }
      stepOutputs.set(stepId, outputs)
    }

    // running → collecting
    run = await this.deps.store.transitionRun(principal.tenantId, runId, run.runVersion, "collecting")
    // Collect artifacts.
    for (const spec of version.definition.artifacts) {
      const outs = stepOutputs.get(spec.stepId) ?? {}
      const content = this.deriveArtifactContent(outs, spec.path)
      const stored = await this.deps.artifacts.put(content, spec.name)
      const artifact = buildArtifact({
        runId: runId,
        versionId: run.versionId,
        stepId: spec.stepId,
        type: spec.type,
        name: spec.name,
        contentRef: stored.contentRef,
        checksum: stored.checksum,
        size: stored.size,
        metadata: { artifactSpecId: spec.artifactId },
      })
      await this.deps.store.saveArtifact(artifact)
      await this.appendAutomationEvent(principal.tenantId, run, "automation.artifact.created", { artifactId: artifact.artifactId, stepId: spec.stepId, type: spec.type })
    }

    // collecting → awaiting_approval (if required) → delivering / completed
    if (version.definition.approval.required) {
      const req = await this.createApprovalRequest(principal, run, version)
      run = await this.deps.store.transitionRun(principal.tenantId, runId, run.runVersion, "awaiting_approval")
      await this.appendAutomationEvent(principal.tenantId, run, "automation.approval.requested", { approvalId: req.approvalId, gateId: req.gateId })
      return run
    }
    return this.deliverRun(principal, run, version)
  }

  /** Derive artifact content bytes from a step's resolved outputs + path. */
  private deriveArtifactContent(outputs: Readonly<Record<string, unknown>>, path: string): Uint8Array {
    const value = readPath(outputs, path)
    const text = value === undefined ? JSON.stringify(outputs) : typeof value === "string" ? value : JSON.stringify(value)
    return new TextEncoder().encode(text)
  }

  /** Dispatch a single step's job, recording the durable mapping. Crash-safe:
   *  if a mapping already exists, reuse it (no duplicate job). */
  private async dispatchStep(
    principal: ResolvedPrincipal,
    run: AutomationRun,
    version: AutomationVersion,
    step: AutomationVersion["definition"]["steps"][number],
    prompt: string,
    inputRevisionId: string,
  ): Promise<{ jobId: string; jobState: JobState; mapping: JobMapping }> {
    const existing = await this.deps.store.getJobMapping(principal.tenantId, run.runId, step.stepId)
    const idemKey = stepIdempotencyKey(run.runId, step.stepId)
    if (existing) {
      const state = await this.deps.dispatcher.getJobState(existing.jobId)
      if (!state) throw new AutomationError("JOB_STATE_LOST", `Job state lost for step ${step.stepId}`, 500)
      return { jobId: existing.jobId, jobState: state, mapping: existing }
    }
    const result = await this.deps.dispatcher.dispatchAndRun({
      identity: scopeOf(run),
      engine: step.execution.engine,
      model: step.execution.model,
      input: prompt,
      ...(step.execution.engineOptions ? { engineOptions: step.execution.engineOptions } : {}),
      ...(step.execution.maxSteps !== null && step.execution.maxSteps !== undefined ? { maxSteps: step.execution.maxSteps } : {}),
      ...(step.execution.maxTokens !== null && step.execution.maxTokens !== undefined ? { maxTokens: step.execution.maxTokens } : {}),
      ...(step.execution.maxDurationMs !== null && step.execution.maxDurationMs !== undefined ? { maxDurationMs: step.execution.maxDurationMs } : {}),
      ...(step.execution.allowedTools ? { allowedTools: step.execution.allowedTools } : {}),
      idempotencyKey: idemKey,
    })
    const mapping: JobMapping = {
      mappingId: newMappingId(),
      runId: run.runId,
      versionId: version.versionId,
      stepId: step.stepId,
      jobId: result.jobId,
      idempotencyKey: idemKey,
      inputRevisionId,
      createdAt: Date.now(),
    }
    try {
      await this.deps.store.saveJobMapping(mapping)
    } catch (error) {
      // A concurrent saver won the mapping race: reload the existing mapping
      // (the dispatcher already deduplicated the job by idempotency key).
      if (error instanceof AutomationError && error.code === "JOB_MAPPING_EXISTS") {
        const reloaded = await this.deps.store.getJobMapping(principal.tenantId, run.runId, step.stepId)
        if (reloaded) return { jobId: reloaded.jobId, jobState: result.state, mapping: reloaded }
      }
      throw error
    }
    return { jobId: result.jobId, jobState: result.state, mapping }
  }

  // -- approvals ----------------------------------------------------------

  async createApprovalRequest(principal: ResolvedPrincipal, run: AutomationRun, version: AutomationVersion): Promise<ApprovalRequest> {
    const existing = await this.deps.store.getApprovalRequestByGate(principal.tenantId, run.runId, version.definition.approval.gateId)
    if (existing) return existing
    const req = buildApprovalRequest({
      runId: run.runId,
      versionId: run.versionId,
      gateId: version.definition.approval.gateId,
      minApproverRole: version.definition.approval.minApproverRole,
      contextArtifacts: version.definition.approval.contextArtifacts,
      ...(version.definition.approval.expiresAfterMs !== null && version.definition.approval.expiresAfterMs !== undefined ? { expiresAfterMs: version.definition.approval.expiresAfterMs } : {}),
    })
    await this.deps.store.saveApprovalRequest(req)
    await this.audit(principal, scopeOf(run), "automation_approval_requested", { runId: run.runId, approvalId: req.approvalId, gateId: req.gateId })
    return req
  }

  async getApprovalRequest(principal: ResolvedPrincipal, approvalId: string): Promise<ApprovalRequest | null> {
    const req = await this.deps.store.getApprovalRequest(principal.tenantId, approvalId)
    if (!req) return null
    const run = await this.deps.store.getRun(principal.tenantId, req.runId)
    if (!run) return null
    if (!await this.canAccess(principal, run.orgId, run.projectId)) return null
    return req
  }

  async listRunApprovalRequests(principal: ResolvedPrincipal, runId: string): Promise<ApprovalRequest[]> {
    const run = await this.getRun(principal, runId)
    if (!run) return []
    return this.deps.store.listApprovalRequests(principal.tenantId, runId)
  }

  /** Record an approval decision. Idempotent: a replay returns the existing
   *  terminal decision without side effects. Concurrent decisions serialize to
   *  one terminal outcome. An approved decision permits delivery. */
  async decideApproval(args: {
    readonly principal: ResolvedPrincipal
    readonly approvalId: string
    readonly decision: ApprovalDecision
    readonly metadata?: Record<string, unknown>
  }): Promise<{ approval: ApprovalRequest; run: AutomationRun | null }> {
    const req = await this.getApprovalRequest(args.principal, args.approvalId)
    if (!req) throw new AutomationError("APPROVAL_NOT_FOUND", `Approval ${args.approvalId} not found`, 404)
    authorizeApprover(req, args.principal.role)
    const decided = await this.deps.store.decideApproval(args.principal.tenantId, args.approvalId, req.approvalVersion, args.decision, { principalId: args.principal.principalId, kind: args.principal.kind }, args.metadata)
    const run = await this.deps.store.getRun(args.principal.tenantId, req.runId)
    if (run) {
      await this.appendAutomationEvent(args.principal.tenantId, run, decided.status === "approved" ? "automation.approval.approved" : "automation.approval.rejected", { approvalId: req.approvalId, decision: decided.status })
    }
    await this.audit(args.principal, { tenantId: args.principal.tenantId, orgId: "", projectId: "" }, decided.status === "approved" ? "automation_approval_approved" : "automation_approval_rejected", { runId: req.runId, approvalId: req.approvalId, decision: decided.status, actor: args.principal.principalId })

    // If approved, continue the run toward delivery; if rejected, terminate.
    if (!run) return { approval: decided, run: null }
    if (decided.status === "approved" && run.status === "awaiting_approval") {
      const version = await this.deps.store.getVersion(args.principal.tenantId, run.versionId)
      if (version) return { approval: decided, run: await this.deliverRun(args.principal, run, version) }
    } else if (decided.status === "rejected" && run.status === "awaiting_approval") {
      const updated = await this.deps.store.transitionRun(args.principal.tenantId, run.runId, run.runVersion, "rejected")
      await this.appendAutomationEvent(args.principal.tenantId, run, "automation.run.failed", { reason: "rejected" })
      return { approval: decided, run: updated }
    } else if (decided.status === "changes_requested" && run.status === "awaiting_approval") {
      // Changes requested: park the run back at collecting for rework (Phase 2A:
      // surface as suspended awaiting operator action).
      const updated = await this.deps.store.transitionRun(args.principal.tenantId, run.runId, run.runVersion, "suspended")
      return { approval: decided, run: updated }
    }
    return { approval: decided, run }
  }

  // -- delivery -----------------------------------------------------------

  /** Deliver a run's artifacts through the delivery provider. At-least-once with
   *  idempotent settlement: a crash never falsely marks undelivered as delivered;
   *  a retry reuses the same delivery identity. */
  async deliverRun(principal: ResolvedPrincipal, run: AutomationRun, version: AutomationVersion): Promise<AutomationRun> {
    if (run.status === "awaiting_approval") {
      run = await this.deps.store.transitionRun(principal.tenantId, run.runId, run.runVersion, "delivering")
    } else if (run.status !== "delivering" && run.status !== "collecting") {
      return run
    }
    if (run.status === "collecting") {
      run = await this.deps.store.transitionRun(principal.tenantId, run.runId, run.runVersion, "delivering")
    }
    const idemKey = `delivery:${run.runId}:${version.definition.delivery.destination}`
    let attempt = await this.deps.store.getDeliveryAttemptByKey(principal.tenantId, run.runId, idemKey)
    if (!attempt) {
      attempt = buildDeliveryAttempt({ runId: run.runId, versionId: run.versionId, idempotencyKey: idemKey, destination: version.definition.delivery.destination })
      await this.deps.store.saveDeliveryAttempt(attempt)
    }
    if (attempt.status === "delivered") {
      // Idempotent: already delivered.
      return this.completeRun(principal, run, attempt)
    }
    // Load artifacts + their content.
    const artifacts = await this.deps.store.listArtifacts(principal.tenantId, run.runId)
    const deliverArtifacts = artifacts.filter((a) => version.definition.delivery.artifactIds.includes(a.artifactId) || version.definition.delivery.artifactIds.length === 0)
    const contents = new Map<string, Uint8Array>()
    for (const a of deliverArtifacts) {
      // Verify checksum before delivery (detect corruption).
      await verifyArtifact(a, this.deps.artifacts)
      contents.set(a.artifactId, await this.deps.artifacts.get(a.contentRef))
    }
    // Mark in-progress (fenced) then call the provider.
    let inProgress = await this.deps.store.transitionDelivery(principal.tenantId, attempt.deliveryId, attempt.deliveryVersion, "in_progress")
    await this.appendAutomationEvent(principal.tenantId, run, "automation.delivery.started", { deliveryId: inProgress.deliveryId, destination: inProgress.destination })
    try {
      const result = await this.deps.delivery.deliver({ idempotencyKey: idemKey, destination: version.definition.delivery.destination, artifacts: deliverArtifacts, contents })
      const delivered = await this.deps.store.transitionDelivery(principal.tenantId, inProgress.deliveryId, inProgress.deliveryVersion, "delivered", { resultRef: result.resultRef })
      await this.appendAutomationEvent(principal.tenantId, run, "automation.delivery.completed", { deliveryId: delivered.deliveryId, resultRef: delivered.resultRef })
      await this.audit(principal, scopeOf(run), "automation_delivery_completed", { runId: run.runId, deliveryId: delivered.deliveryId, destination: delivered.destination })
      return this.completeRun(principal, run, delivered)
    } catch (error) {
      const message = error instanceof Error ? error.message : "delivery failed"
      const failed = await this.deps.store.transitionDelivery(principal.tenantId, inProgress.deliveryId, inProgress.deliveryVersion, "failed", { error: message })
      // A failed delivery fails the run (operator retries by re-running delivery).
      const failedRun = await this.deps.store.transitionRun(principal.tenantId, run.runId, run.runVersion, "failed", { error: message })
      await this.appendAutomationEvent(principal.tenantId, run, "automation.run.failed", { reason: "delivery_failed", deliveryId: failed.deliveryId })
      void failed
      return failedRun
    }
  }

  private async completeRun(principal: ResolvedPrincipal, run: AutomationRun, delivery: DeliveryAttempt): Promise<AutomationRun> {
    if (run.status === "completed") return run
    const completed = await this.deps.store.transitionRun(principal.tenantId, run.runId, run.runVersion, "completed")
    await this.appendAutomationEvent(principal.tenantId, run, "automation.run.completed", { runId: run.runId, deliveryId: delivery.deliveryId, resultRef: delivery.resultRef })
    await this.audit(principal, scopeOf(run), "automation_run_completed", { runId: run.runId, deliveryId: delivery.deliveryId })
    return completed
  }

  // -- reconciliation -----------------------------------------------------

  /** Reconcile a run's state from durable evidence. Re-projects existing job
   *  mappings from committed events (read-only), then — if the run is stuck in
   *  a non-terminal execution state (e.g. a crash left it at "running" before a
   *  mapping was saved) — re-drives it forward via {@link advanceRun}. Re-drive
   *  is idempotent: the dispatcher deduplicates on (runId, stepId), so it never
   *  creates duplicate execution work — it only completes the projection the
   *  crash interrupted. Repairs missing safe projections (step state, automation
   *  events, artifacts). Restart-safe + idempotent. */
  async reconcileRun(principal: ResolvedPrincipal, runId: string): Promise<AutomationRun> {
    let run = await this.getRun(principal, runId)
    if (!run) throw new AutomationError("RUN_NOT_FOUND", `Run ${runId} not found`, 404)
    const version = await this.deps.store.getVersion(principal.tenantId, run.versionId)
    if (!version) throw new AutomationError("VERSION_NOT_FOUND", `Version ${run.versionId} not found`, 500)

    // First, re-project any existing mappings from committed job events (safe:
    // reads only, never re-executes). This repairs missing step-state projections.
    const mappings = await this.deps.store.listJobMappings(principal.tenantId, runId)
    for (const mapping of mappings) {
      const state = await this.deps.dispatcher.getJobState(mapping.jobId)
      if (!state) continue
      const events = await this.deps.dispatcher.listJobEvents(mapping.jobId, 0)
      const projected = projectStepEvents({ runId, stepId: mapping.stepId, jobId: mapping.jobId, events, startSeq: await this.nextSeq(principal.tenantId, runId) })
      for (const ev of projected.events) await this.deps.store.appendEvent(principal.tenantId, ev)
      const status = stepStatusFromJobStatus(state.status)
      const existing = await this.deps.store.getStepState(principal.tenantId, runId, mapping.stepId)
      const terminalText = lastAssistantText(events)
      const step = version.definition.steps.find((s) => s.stepId === mapping.stepId)
      const outputs = status === "completed" && step ? extractOutputs(terminalText, step.outputMappings) : (existing?.outputs ?? {})
      if (existing?.status !== status || JSON.stringify(existing?.outputs ?? {}) !== JSON.stringify(outputs)) {
        await this.deps.store.upsertStepState({
          runId,
          stepId: mapping.stepId,
          status,
          jobId: mapping.jobId,
          outputs,
          startedAt: existing?.startedAt ?? null,
          completedAt: status === "completed" ? Date.now() : null,
          error: state.error,
        })
      }
      if (status === "failed" && !isTerminalRunStatus(run.status)) {
        run = await this.deps.store.transitionRun(principal.tenantId, runId, run.runVersion, "failed", { error: state.error ?? "step failed" })
        await this.appendAutomationEvent(principal.tenantId, run, "automation.run.failed", { stepId: mapping.stepId, reason: "step_failed", jobId: mapping.jobId })
        return run
      }
    }

    // If the run is still in a non-terminal execution state (e.g. it crashed
    // after transitioning to "running" but before a mapping was saved), re-drive
    // it forward. advanceRun re-dispatches idempotently (the dispatcher
    // deduplicates on (runId, stepId)) so this never creates duplicate execution
    // work — it only completes the projection that the crash interrupted.
    if (run.status === "admitted" || run.status === "running" || run.status === "collecting") {
      run = await this.advanceRun(principal, runId)
    }
    return run
  }

  // -- internal helpers ---------------------------------------------------

  private async authorize(principal: ResolvedPrincipal, orgId: string, projectId: string): Promise<void> {
    // Reuse the identity layer's authorization semantics. The service itself
    // does not hold the identity store; the control plane authorizes before
    // calling the service. Here we enforce the projectScope rule defensively.
    if (principal.admin) return
    if (principal.orgId !== orgId) {
      throw new AutomationError("FORBIDDEN_ORG", `Principal not a member of organization ${orgId}`, 403)
    }
    if (projectId !== "*" && !(principal.projectScope.includes("*") || principal.projectScope.includes(projectId))) {
      throw new AutomationError("FORBIDDEN_PROJECT", `Principal not granted access to project ${projectId}`, 403)
    }
  }

  /** Non-throwing access check for read paths: returns false instead of throwing
   *  so a cross-scope read returns null (404) without leaking existence. */
  private async canAccess(principal: ResolvedPrincipal, orgId: string, projectId: string): Promise<boolean> {
    if (principal.admin) return true
    if (principal.orgId !== orgId) return false
    if (projectId !== "*" && !(principal.projectScope.includes("*") || principal.projectScope.includes(projectId))) return false
    return true
  }

  private async audit(principal: ResolvedPrincipal, scope: JobIdentity, type: AuditInput["type"], metadata: Record<string, unknown>): Promise<void> {
    await this.deps.audit.append({ actor: auditActor(principal), scope, type, metadata: sanitizeMetadata(metadata) })
  }

  private async appendAutomationEvent(tenantId: string, run: AutomationRun, type: AutomationEvent["type"], data: unknown): Promise<void> {
    const seq = await this.nextSeq(tenantId, run.runId)
    await this.deps.store.appendEvent(tenantId, automationEvent({ runId: run.runId, seq, type, data }))
  }

  private async nextSeq(tenantId: string, runId: string): Promise<number> {
    const events = await this.deps.store.listEvents(tenantId, runId)
    return events.reduce((max, e) => Math.max(max, e.seq), 0) + 1
  }
}

function isTerminalRunStatus(status: AutomationRun["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "rejected"
}

/** Convenience: the minimum role required to approve, as a rank number. */
export function approverRoleRank(role: string): number {
  return ROLE_RANK[role as keyof typeof ROLE_RANK] ?? 0
}
