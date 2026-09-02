/**
 * In-memory automation store (Phase 2A).
 *
 * Implements the same {@link AutomationStore} contract as {@link SqlAutomationStore}
 * so the service behaves identically in tests/local without a database. It is
 * NOT durable across process restarts — production wires the SQL store. The
 * fencing/transition/decision semantics mirror the SQL store exactly so tests
 * prove the real invariants.
 *
 * Single-process only: the in-memory maps are not shared across processes.
 * Cross-process correctness is the SQL store's job (UNIQUE constraints + fenced
 * conditional UPDATEs).
 */

import {
  type ApprovalRequest,
  type ApprovalStatus,
  type AutomationArtifact,
  type AutomationEvent,
  type AutomationRun,
  type AutomationTemplate,
  type AutomationVersion,
  type DeliveryAttempt,
  type DeliveryStatus,
  type JobMapping,
  type RunInputRevision,
  type RunStepState,
  type RunStatus,
  type TemplateStatus,
  AutomationError,
} from "./contracts"
import type { AutomationStore } from "./store"
import { applyDecision, type ApprovalDecision } from "./approval"
import { applyTransition } from "./run"
import { verifyVersionChecksum } from "./version"
import { newMappingId } from "./ids"

export class InMemoryAutomationStore implements AutomationStore {
  private readonly templates = new Map<string, AutomationTemplate>()
  private readonly versions = new Map<string, AutomationVersion>()
  private readonly runs = new Map<string, AutomationRun>()
  private readonly inputs = new Map<string, RunInputRevision>()
  private readonly steps = new Map<string, RunStepState>() // key: runId|stepId
  private readonly mappings = new Map<string, JobMapping>() // key: runId|stepId
  private readonly mappingsByJob = new Map<string, JobMapping>()
  private readonly artifacts = new Map<string, AutomationArtifact>()
  private readonly approvals = new Map<string, ApprovalRequest>()
  private readonly approvalsByGate = new Map<string, ApprovalRequest>() // key: runId|gateId
  private readonly deliveries = new Map<string, DeliveryAttempt>()
  private readonly deliveriesByKey = new Map<string, DeliveryAttempt>() // key: runId|idempotencyKey
  private readonly events = new Map<string, AutomationEvent[]>() // key: runId

  // -- templates -----------------------------------------------------------
  async createTemplate(template: AutomationTemplate): Promise<AutomationTemplate> {
    const nameKey = `${template.tenantId}|${template.orgId}|${template.projectId}|${template.name}`
    for (const t of this.templates.values()) {
      if (`${t.tenantId}|${t.orgId}|${t.projectId}|${t.name}` === nameKey) {
        throw new AutomationError("TEMPLATE_EXISTS", `Template name "${template.name}" already exists in this project`, 409)
      }
    }
    this.templates.set(template.templateId, { ...template })
    return template
  }

  async getTemplate(tenantId: string, templateId: string): Promise<AutomationTemplate | null> {
    const t = this.templates.get(templateId)
    if (!t || t.tenantId !== tenantId) return null
    return { ...t }
  }

  async listTemplates(tenantId: string, orgId?: string, projectId?: string): Promise<AutomationTemplate[]> {
    return [...this.templates.values()]
      .filter((t) => t.tenantId === tenantId && (!orgId || t.orgId === orgId) && (!projectId || t.projectId === projectId))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((t) => ({ ...t }))
  }

  async archiveTemplate(tenantId: string, templateId: string, now = Date.now()): Promise<AutomationTemplate | null> {
    const t = this.templates.get(templateId)
    if (!t || t.tenantId !== tenantId) return null
    const updated = { ...t, status: "archived" as TemplateStatus, archivedAt: now }
    this.templates.set(templateId, updated)
    return { ...updated }
  }

  // -- versions ------------------------------------------------------------
  async createVersion(version: AutomationVersion): Promise<AutomationVersion> {
    for (const v of this.versions.values()) {
      if (v.templateId === version.templateId && v.version === version.version) {
        throw new AutomationError("VERSION_EXISTS", `Version ${version.version} already exists for template ${version.templateId}`, 409)
      }
    }
    this.versions.set(version.versionId, { ...version, definition: JSON.parse(JSON.stringify(version.definition)), inputContract: JSON.parse(JSON.stringify(version.inputContract)) })
    return version
  }

  async getVersion(tenantId: string, versionId: string): Promise<AutomationVersion | null> {
    const v = this.versions.get(versionId)
    if (!v || v.tenantId !== tenantId) return null
    verifyVersionChecksum(v)
    return { ...v, definition: JSON.parse(JSON.stringify(v.definition)), inputContract: JSON.parse(JSON.stringify(v.inputContract)) }
  }

  async getVersionByNumber(tenantId: string, templateId: string, version: number): Promise<AutomationVersion | null> {
    for (const v of this.versions.values()) {
      if (v.tenantId === tenantId && v.templateId === templateId && v.version === version) {
        verifyVersionChecksum(v)
        return { ...v, definition: JSON.parse(JSON.stringify(v.definition)), inputContract: JSON.parse(JSON.stringify(v.inputContract)) }
      }
    }
    return null
  }

  async nextVersionNumber(tenantId: string, templateId: string): Promise<number> {
    let max = 0
    for (const v of this.versions.values()) {
      if (v.tenantId === tenantId && v.templateId === templateId) max = Math.max(max, v.version)
    }
    return max + 1
  }

  async listVersions(tenantId: string, templateId: string): Promise<AutomationVersion[]> {
    return [...this.versions.values()]
      .filter((v) => v.tenantId === tenantId && v.templateId === templateId)
      .sort((a, b) => a.version - b.version)
      .map((v) => ({ ...v, definition: JSON.parse(JSON.stringify(v.definition)), inputContract: JSON.parse(JSON.stringify(v.inputContract)) }))
  }

  // -- inputs --------------------------------------------------------------
  async saveInputRevision(revision: RunInputRevision): Promise<void> {
    this.inputs.set(revision.inputRevisionId, { ...revision, values: JSON.parse(JSON.stringify(revision.values)) })
  }

  async getInputRevision(tenantId: string, runId: string, revisionId: string): Promise<RunInputRevision | null> {
    const rev = this.inputs.get(revisionId)
    if (!rev || rev.runId !== runId) return null
    const run = this.runs.get(runId)
    if (!run || run.tenantId !== tenantId) return null
    return { ...rev, values: JSON.parse(JSON.stringify(rev.values)) }
  }

  // -- runs ----------------------------------------------------------------
  async createRun(run: AutomationRun): Promise<AutomationRun> {
    if (this.runs.has(run.runId)) throw new AutomationError("RUN_EXISTS", `Run ${run.runId} already exists`, 409)
    this.runs.set(run.runId, { ...run })
    return run
  }

  async getRun(tenantId: string, runId: string): Promise<AutomationRun | null> {
    const r = this.runs.get(runId)
    if (!r || r.tenantId !== tenantId) return null
    return { ...r }
  }

  async transitionRun(tenantId: string, runId: string, expectedVersion: number, to: RunStatus, extra?: { error?: string | null; now?: number }): Promise<AutomationRun> {
    const r = this.runs.get(runId)
    if (!r || r.tenantId !== tenantId) throw new AutomationError("RUN_NOT_FOUND", `Run ${runId} not found`, 404)
    if (r.runVersion !== expectedVersion) throw new AutomationError("RUN_FENCED", `Run ${runId} is owned by a newer version`, 409)
    const updated = applyTransition(r, to, extra)
    this.runs.set(runId, updated)
    return { ...updated }
  }

  async listRuns(tenantId: string, orgId?: string, projectId?: string): Promise<AutomationRun[]> {
    return [...this.runs.values()]
      .filter((r) => r.tenantId === tenantId && (!orgId || r.orgId === orgId) && (!projectId || r.projectId === projectId))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((r) => ({ ...r }))
  }

  // -- steps ---------------------------------------------------------------
  private stepKey(runId: string, stepId: string): string {
    return `${runId}|${stepId}`
  }

  async upsertStepState(step: RunStepState): Promise<void> {
    this.steps.set(this.stepKey(step.runId, step.stepId), { ...step, outputs: JSON.parse(JSON.stringify(step.outputs)) })
  }

  async getStepStates(tenantId: string, runId: string): Promise<RunStepState[]> {
    const run = this.runs.get(runId)
    if (!run || run.tenantId !== tenantId) return []
    return [...this.steps.values()]
      .filter((s) => s.runId === runId)
      .sort((a, b) => a.stepId.localeCompare(b.stepId))
      .map((s) => ({ ...s, outputs: JSON.parse(JSON.stringify(s.outputs)) }))
  }

  async getStepState(tenantId: string, runId: string, stepId: string): Promise<RunStepState | null> {
    const run = this.runs.get(runId)
    if (!run || run.tenantId !== tenantId) return null
    const s = this.steps.get(this.stepKey(runId, stepId))
    return s ? { ...s, outputs: JSON.parse(JSON.stringify(s.outputs)) } : null
  }

  // -- job mappings --------------------------------------------------------
  async saveJobMapping(mapping: JobMapping): Promise<void> {
    const key = this.stepKey(mapping.runId, mapping.stepId)
    if (this.mappings.has(key)) {
      throw new AutomationError("JOB_MAPPING_EXISTS", `Step ${mapping.stepId} is already mapped for run ${mapping.runId}`, 409)
    }
    const m = { ...mapping, mappingId: mapping.mappingId || newMappingId() }
    this.mappings.set(key, m)
    this.mappingsByJob.set(m.jobId, m)
  }

  async getJobMapping(tenantId: string, runId: string, stepId: string): Promise<JobMapping | null> {
    const run = this.runs.get(runId)
    if (!run || run.tenantId !== tenantId) return null
    const m = this.mappings.get(this.stepKey(runId, stepId))
    return m ? { ...m } : null
  }

  async listJobMappings(tenantId: string, runId: string): Promise<JobMapping[]> {
    const run = this.runs.get(runId)
    if (!run || run.tenantId !== tenantId) return []
    return [...this.mappings.values()]
      .filter((m) => m.runId === runId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((m) => ({ ...m }))
  }

  async getJobMappingByJob(tenantId: string, jobId: string): Promise<JobMapping | null> {
    const m = this.mappingsByJob.get(jobId)
    if (!m) return null
    const run = this.runs.get(m.runId)
    if (!run || run.tenantId !== tenantId) return null
    return { ...m }
  }

  // -- artifacts -----------------------------------------------------------
  async saveArtifact(artifact: AutomationArtifact): Promise<void> {
    if (this.artifacts.has(artifact.artifactId)) throw new AutomationError("ARTIFACT_EXISTS", `Artifact ${artifact.artifactId} already exists`, 409)
    this.artifacts.set(artifact.artifactId, { ...artifact, metadata: JSON.parse(JSON.stringify(artifact.metadata)) })
  }

  async listArtifacts(tenantId: string, runId: string): Promise<AutomationArtifact[]> {
    const run = this.runs.get(runId)
    if (!run || run.tenantId !== tenantId) return []
    return [...this.artifacts.values()]
      .filter((a) => a.runId === runId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((a) => ({ ...a, metadata: JSON.parse(JSON.stringify(a.metadata)) }))
  }

  // -- approvals -----------------------------------------------------------
  private gateKey(runId: string, gateId: string): string {
    return `${runId}|${gateId}`
  }

  async saveApprovalRequest(req: ApprovalRequest): Promise<void> {
    if (this.approvals.has(req.approvalId)) throw new AutomationError("APPROVAL_EXISTS", `Approval ${req.approvalId} already exists`, 409)
    if (this.approvalsByGate.has(this.gateKey(req.runId, req.gateId))) {
      throw new AutomationError("APPROVAL_EXISTS", `Approval gate ${req.gateId} already exists for run ${req.runId}`, 409)
    }
    const saved = { ...req, contextArtifacts: [...req.contextArtifacts] }
    this.approvals.set(req.approvalId, saved)
    this.approvalsByGate.set(this.gateKey(req.runId, req.gateId), saved)
  }

  async getApprovalRequest(tenantId: string, approvalId: string): Promise<ApprovalRequest | null> {
    const a = this.approvals.get(approvalId)
    if (!a) return null
    const run = this.runs.get(a.runId)
    if (!run || run.tenantId !== tenantId) return null
    return { ...a, contextArtifacts: [...a.contextArtifacts] }
  }

  async getApprovalRequestByGate(tenantId: string, runId: string, gateId: string): Promise<ApprovalRequest | null> {
    const run = this.runs.get(runId)
    if (!run || run.tenantId !== tenantId) return null
    const a = this.approvalsByGate.get(this.gateKey(runId, gateId))
    return a ? { ...a, contextArtifacts: [...a.contextArtifacts] } : null
  }

  async listApprovalRequests(tenantId: string, runId: string): Promise<ApprovalRequest[]> {
    const run = this.runs.get(runId)
    if (!run || run.tenantId !== tenantId) return []
    return [...this.approvals.values()]
      .filter((a) => a.runId === runId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((a) => ({ ...a, contextArtifacts: [...a.contextArtifacts] }))
  }

  async decideApproval(
    tenantId: string,
    approvalId: string,
    expectedVersion: number,
    decision: ApprovalDecision,
    actor: { principalId: string; kind: string },
    metadata?: Record<string, unknown>,
    now = Date.now(),
  ): Promise<ApprovalRequest> {
    const a = this.approvals.get(approvalId)
    if (!a) throw new AutomationError("APPROVAL_NOT_FOUND", `Approval ${approvalId} not found`, 404)
    const run = this.runs.get(a.runId)
    if (!run || run.tenantId !== tenantId) throw new AutomationError("APPROVAL_NOT_FOUND", `Approval ${approvalId} not found`, 404)
    if (a.approvalVersion !== expectedVersion) throw new AutomationError("APPROVAL_FENCED", `Approval ${approvalId} is owned by a newer version`, 409)
    if (a.status !== "pending") return { ...a, contextArtifacts: [...a.contextArtifacts] }
    const updated = applyDecision(a, decision, actor, metadata, now)
    this.approvals.set(approvalId, updated)
    this.approvalsByGate.set(this.gateKey(updated.runId, updated.gateId), updated)
    return { ...updated, contextArtifacts: [...updated.contextArtifacts] }
  }

  async expireApproval(tenantId: string, approvalId: string, now = Date.now()): Promise<ApprovalRequest | null> {
    const a = this.approvals.get(approvalId)
    if (!a) return null
    const run = this.runs.get(a.runId)
    if (!run || run.tenantId !== tenantId) return null
    if (a.status !== "pending") return { ...a, contextArtifacts: [...a.contextArtifacts] }
    if (a.expiresAt === null || a.expiresAt > now) return { ...a, contextArtifacts: [...a.contextArtifacts] }
    const updated = { ...a, status: "expired" as ApprovalStatus, decisionTime: now, approvalVersion: a.approvalVersion + 1 }
    this.approvals.set(approvalId, updated)
    this.approvalsByGate.set(this.gateKey(updated.runId, updated.gateId), updated)
    return { ...updated, contextArtifacts: [...updated.contextArtifacts] }
  }

  // -- delivery ------------------------------------------------------------
  private deliveryKey(runId: string, idempotencyKey: string): string {
    return `${runId}|${idempotencyKey}`
  }

  async saveDeliveryAttempt(d: DeliveryAttempt): Promise<void> {
    if (this.deliveries.has(d.deliveryId)) throw new AutomationError("DELIVERY_EXISTS", `Delivery ${d.deliveryId} already exists`, 409)
    if (this.deliveriesByKey.has(this.deliveryKey(d.runId, d.idempotencyKey))) {
      throw new AutomationError("DELIVERY_EXISTS", `Delivery key ${d.idempotencyKey} already exists for run ${d.runId}`, 409)
    }
    const saved = { ...d }
    this.deliveries.set(d.deliveryId, saved)
    this.deliveriesByKey.set(this.deliveryKey(d.runId, d.idempotencyKey), saved)
  }

  async getDeliveryAttempt(tenantId: string, deliveryId: string): Promise<DeliveryAttempt | null> {
    const d = this.deliveries.get(deliveryId)
    if (!d) return null
    const run = this.runs.get(d.runId)
    if (!run || run.tenantId !== tenantId) return null
    return { ...d }
  }

  async getDeliveryAttemptByKey(tenantId: string, runId: string, idempotencyKey: string): Promise<DeliveryAttempt | null> {
    const run = this.runs.get(runId)
    if (!run || run.tenantId !== tenantId) return null
    const d = this.deliveriesByKey.get(this.deliveryKey(runId, idempotencyKey))
    return d ? { ...d } : null
  }

  async listDeliveryAttempts(tenantId: string, runId: string): Promise<DeliveryAttempt[]> {
    const run = this.runs.get(runId)
    if (!run || run.tenantId !== tenantId) return []
    return [...this.deliveries.values()]
      .filter((d) => d.runId === runId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((d) => ({ ...d }))
  }

  async transitionDelivery(tenantId: string, deliveryId: string, expectedVersion: number, to: DeliveryStatus, extra?: { resultRef?: string; error?: string | null; now?: number }): Promise<DeliveryAttempt> {
    const now = extra?.now ?? Date.now()
    const d = this.deliveries.get(deliveryId)
    if (!d) throw new AutomationError("DELIVERY_NOT_FOUND", `Delivery ${deliveryId} not found`, 404)
    const run = this.runs.get(d.runId)
    if (!run || run.tenantId !== tenantId) throw new AutomationError("DELIVERY_NOT_FOUND", `Delivery ${deliveryId} not found`, 404)
    if (d.deliveryVersion !== expectedVersion) throw new AutomationError("DELIVERY_FENCED", `Delivery ${deliveryId} is owned by a newer version`, 409)
    const from = d.status
    if (from === to || from === "delivered" || from === "failed") {
      throw new AutomationError("ILLEGAL_DELIVERY_TRANSITION", `Delivery ${deliveryId} cannot transition ${from} → ${to}`, 409)
    }
    let updated: DeliveryAttempt
    if (to === "delivered") {
      updated = { ...d, status: "delivered", resultRef: extra?.resultRef ?? d.resultRef, updatedAt: now, lastError: null, deliveryVersion: d.deliveryVersion + 1 }
    } else if (to === "failed") {
      updated = { ...d, status: "failed", lastError: extra?.error ?? d.lastError, updatedAt: now, deliveryVersion: d.deliveryVersion + 1 }
    } else {
      updated = { ...d, status: "in_progress", attempts: d.attempts + 1, updatedAt: now, deliveryVersion: d.deliveryVersion + 1 }
    }
    this.deliveries.set(deliveryId, updated)
    this.deliveriesByKey.set(this.deliveryKey(updated.runId, updated.idempotencyKey), updated)
    return { ...updated }
  }

  // -- events --------------------------------------------------------------
  async appendEvent(tenantId: string, event: AutomationEvent): Promise<void> {
    void tenantId
    const list = this.events.get(event.runId) ?? []
    if (list.some((e) => e.seq === event.seq)) return // idempotent replay
    list.push(event)
    this.events.set(event.runId, list)
  }

  async listEvents(tenantId: string, runId: string, afterSeq = 0): Promise<AutomationEvent[]> {
    const run = this.runs.get(runId)
    if (!run || run.tenantId !== tenantId) return []
    return (this.events.get(runId) ?? []).filter((e) => e.seq > afterSeq).map((e) => ({ ...e }))
  }

  // -- Phase 2B: tenant-wide operational listings --------------------------

  async listExpiredApprovals(tenantId: string, now = Date.now()): Promise<ApprovalRequest[]> {
    const out: ApprovalRequest[] = []
    for (const a of this.approvals.values()) {
      const run = this.runs.get(a.runId)
      if (!run || run.tenantId !== tenantId) continue
      if (a.status === "pending" && a.expiresAt !== null && a.expiresAt <= now) out.push({ ...a })
    }
    return out
  }

  async listFailedDeliveriesForRetry(tenantId: string): Promise<DeliveryAttempt[]> {
    const out: DeliveryAttempt[] = []
    for (const d of this.deliveries.values()) {
      const run = this.runs.get(d.runId)
      if (!run || run.tenantId !== tenantId) continue
      if (d.status !== "failed") continue
      if (run.status === "delivering" || run.status === "failed") out.push({ ...d })
    }
    return out
  }

  async listStaleRuns(tenantId: string, staleBefore: number, limit = 100): Promise<AutomationRun[]> {
    const stale = new Set(["admitted", "running", "collecting", "awaiting_approval", "delivering"] as const)
    return [...this.runs.values()]
      .filter((r) => r.tenantId === tenantId && stale.has(r.status as never) && r.updatedAt < staleBefore)
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, limit)
      .map((r) => ({ ...r }))
  }
}
