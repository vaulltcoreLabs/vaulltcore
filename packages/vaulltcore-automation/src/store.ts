/**
 * Durable automation store contract + SQL implementation (Phase 2A).
 *
 * Reuses the {@link SqlStoreBase} transaction/dialect seam so every mutation is
 * race-free and rollback-safe, identical to the Phase 1 business stores. The
 * schema covers the nine required tables with database constraints enforcing
 * the identity invariants:
 *
 * - `automation_templates` — template ownership boundaries (tenant/org/project)
 * - `automation_versions` — UNIQUE (template_id, version); checksum column
 * - `automation_runs` — fenced `run_version`; pinned version_id
 * - `automation_run_inputs` — durable input revisions with checksum
 * - `automation_run_steps` — UNIQUE (run_id, step_id) projected step state
 * - `automation_job_mappings` — UNIQUE (run_id, step_id); UNIQUE (run_id, job_id)
 * - `automation_artifacts` — unique artifact identity; checksum column
 * - `approval_requests` — UNIQUE (run_id, gate_id); fenced `approval_version`
 * - `delivery_attempts` — UNIQUE (run_id, idempotency_key); fenced `delivery_version`
 *
 * All reads are tenant-scoped: there is no list path that returns another
 * tenant's templates/versions/runs/artifacts/approvals/deliveries. Cross-tenant
 * access returns null (the control plane surfaces 404 — no existence leak).
 *
 * The {@link AutomationStore} interface is what the service depends on; both
 * {@link SqlAutomationStore} and {@link InMemoryAutomationStore} implement it.
 */

import { type SqlDatabase, type SqlDialect, type Migration, SqlStoreBase, isUniqueViolation, sqliteDialect } from "@vaulltcore/store-sql"
import {
  type ApprovalRequest,
  type ApprovalStatus,
  type ArtifactStore,
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
  type StepStatus,
  type TemplateStatus,
  AutomationError,
} from "./contracts"
import { applyDecision, applyExpiry, type ApprovalDecision } from "./approval"
import { applyTransition } from "./run"
import { verifyVersionChecksum } from "./version"
import { newMappingId } from "./ids"

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

export const AUTOMATION_MIGRATIONS: readonly Migration[] = [
  {
    // Phase 2A automation product layer. Name is globally unique so the shared
    // schema_migrations ledger (deduped by name) applies it once across all
    // stores sharing the database. Version orders within this package only.
    version: 2,
    name: "automation_core",
    statements: [
      `CREATE TABLE automation_templates (
        template_id   TEXT PRIMARY KEY,
        tenant_id     TEXT NOT NULL,
        org_id        TEXT NOT NULL,
        project_id    TEXT NOT NULL,
        name          TEXT NOT NULL,
        description   TEXT,
        status        TEXT NOT NULL,
        created_at    BIGINT NOT NULL,
        created_by    TEXT NOT NULL,
        archived_at   BIGINT,
        UNIQUE (tenant_id, org_id, project_id, name)
      )`,
      `CREATE INDEX automation_templates_tenant_idx ON automation_templates (tenant_id, org_id, project_id)`,
      `CREATE TABLE automation_versions (
        version_id    TEXT PRIMARY KEY,
        template_id   TEXT NOT NULL REFERENCES automation_templates (template_id) ON DELETE CASCADE,
        tenant_id     TEXT NOT NULL,
        org_id        TEXT NOT NULL,
        project_id    TEXT NOT NULL,
        version       INTEGER NOT NULL,
        definition    TEXT NOT NULL,
        input_contract TEXT NOT NULL,
        checksum      TEXT NOT NULL,
        created_at    BIGINT NOT NULL,
        created_by    TEXT NOT NULL,
        UNIQUE (template_id, version)
      )`,
      `CREATE INDEX automation_versions_tenant_idx ON automation_versions (tenant_id, org_id, project_id)`,
      `CREATE INDEX automation_versions_template_idx ON automation_versions (template_id, version)`,
      `CREATE TABLE automation_runs (
        run_id           TEXT PRIMARY KEY,
        tenant_id        TEXT NOT NULL,
        org_id           TEXT NOT NULL,
        project_id       TEXT NOT NULL,
        template_id      TEXT NOT NULL,
        version_id       TEXT NOT NULL,
        version          INTEGER NOT NULL,
        status           TEXT NOT NULL,
        input_revision_id TEXT NOT NULL,
        run_version      INTEGER NOT NULL,
        created_by       TEXT NOT NULL,
        error            TEXT,
        created_at       BIGINT NOT NULL,
        updated_at       BIGINT NOT NULL,
        suspended_at     BIGINT,
        completed_at     BIGINT
      )`,
      `CREATE INDEX automation_runs_tenant_idx ON automation_runs (tenant_id, org_id, project_id)`,
      `CREATE INDEX automation_runs_template_idx ON automation_runs (template_id)`,
      `CREATE TABLE automation_run_inputs (
        input_revision_id TEXT PRIMARY KEY,
        run_id            TEXT NOT NULL REFERENCES automation_runs (run_id) ON DELETE CASCADE,
        checksum          TEXT NOT NULL,
        values            TEXT NOT NULL,
        created_at        BIGINT NOT NULL
      )`,
      `CREATE INDEX automation_run_inputs_run_idx ON automation_run_inputs (run_id)`,
      `CREATE TABLE automation_run_steps (
        run_id      TEXT NOT NULL REFERENCES automation_runs (run_id) ON DELETE CASCADE,
        step_id     TEXT NOT NULL,
        status      TEXT NOT NULL,
        job_id      TEXT,
        outputs     TEXT NOT NULL,
        started_at  BIGINT,
        completed_at BIGINT,
        error       TEXT,
        PRIMARY KEY (run_id, step_id)
      )`,
      `CREATE TABLE automation_job_mappings (
        mapping_id        TEXT PRIMARY KEY,
        run_id            TEXT NOT NULL REFERENCES automation_runs (run_id) ON DELETE CASCADE,
        version_id        TEXT NOT NULL,
        step_id           TEXT NOT NULL,
        job_id            TEXT NOT NULL,
        idempotency_key   TEXT NOT NULL,
        input_revision_id TEXT NOT NULL,
        created_at        BIGINT NOT NULL,
        UNIQUE (run_id, step_id),
        UNIQUE (run_id, job_id)
      )`,
      `CREATE INDEX automation_job_mappings_job_idx ON automation_job_mappings (job_id)`,
      `CREATE TABLE automation_artifacts (
        artifact_id  TEXT PRIMARY KEY,
        run_id       TEXT NOT NULL REFERENCES automation_runs (run_id) ON DELETE CASCADE,
        version_id   TEXT NOT NULL,
        step_id      TEXT,
        type         TEXT NOT NULL,
        name         TEXT NOT NULL,
        content_ref  TEXT NOT NULL,
        checksum     TEXT NOT NULL,
        size         BIGINT,
        created_at   BIGINT NOT NULL,
        metadata     TEXT NOT NULL
      )`,
      `CREATE INDEX automation_artifacts_run_idx ON automation_artifacts (run_id)`,
      `CREATE TABLE approval_requests (
        approval_id        TEXT PRIMARY KEY,
        run_id             TEXT NOT NULL REFERENCES automation_runs (run_id) ON DELETE CASCADE,
        version_id         TEXT NOT NULL,
        gate_id            TEXT NOT NULL,
        status             TEXT NOT NULL,
        min_approver_role  TEXT NOT NULL,
        context_artifacts  TEXT NOT NULL,
        created_at         BIGINT NOT NULL,
        expires_at         BIGINT,
        decision_actor     TEXT,
        decision_time      BIGINT,
        decision_metadata  TEXT,
        approval_version   INTEGER NOT NULL,
        UNIQUE (run_id, gate_id)
      )`,
      `CREATE INDEX approval_requests_run_idx ON approval_requests (run_id)`,
      `CREATE TABLE delivery_attempts (
        delivery_id       TEXT PRIMARY KEY,
        run_id            TEXT NOT NULL REFERENCES automation_runs (run_id) ON DELETE CASCADE,
        version_id        TEXT NOT NULL,
        idempotency_key   TEXT NOT NULL,
        destination       TEXT NOT NULL,
        status            TEXT NOT NULL,
        attempts          INTEGER NOT NULL,
        result_ref        TEXT,
        created_at        BIGINT NOT NULL,
        updated_at        BIGINT NOT NULL,
        last_error        TEXT,
        delivery_version  INTEGER NOT NULL,
        UNIQUE (run_id, idempotency_key)
      )`,
      `CREATE INDEX delivery_attempts_run_idx ON delivery_attempts (run_id)`,
      `CREATE TABLE automation_events (
        run_id     TEXT NOT NULL REFERENCES automation_runs (run_id) ON DELETE CASCADE,
        seq        BIGINT NOT NULL,
        timestamp  BIGINT NOT NULL,
        type       TEXT NOT NULL,
        data       TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
      )`,
    ],
  },
]

// ---------------------------------------------------------------------------
// Store contract
// ---------------------------------------------------------------------------

/** Durable automation store. The service depends on this interface; both the SQL
 *  and in-memory implementations satisfy it. Tenant scoping is mandatory on
 *  every read — a missing tenantId returns null (cross-tenant = not found). */
export interface AutomationStore {
  // templates
  createTemplate(template: AutomationTemplate): Promise<AutomationTemplate>
  getTemplate(tenantId: string, templateId: string): Promise<AutomationTemplate | null>
  listTemplates(tenantId: string, orgId?: string, projectId?: string): Promise<AutomationTemplate[]>
  archiveTemplate(tenantId: string, templateId: string, now?: number): Promise<AutomationTemplate | null>
  // versions
  createVersion(version: AutomationVersion): Promise<AutomationVersion>
  getVersion(tenantId: string, versionId: string): Promise<AutomationVersion | null>
  getVersionByNumber(tenantId: string, templateId: string, version: number): Promise<AutomationVersion | null>
  nextVersionNumber(tenantId: string, templateId: string): Promise<number>
  listVersions(tenantId: string, templateId: string): Promise<AutomationVersion[]>
  // inputs
  saveInputRevision(revision: RunInputRevision): Promise<void>
  getInputRevision(tenantId: string, runId: string, revisionId: string): Promise<RunInputRevision | null>
  // runs
  createRun(run: AutomationRun): Promise<AutomationRun>
  getRun(tenantId: string, runId: string): Promise<AutomationRun | null>
  /** Fenced transition: only commits if runVersion matches expected; returns the
   *  updated run or throws RunFencedError. Validates the transition first. */
  transitionRun(tenantId: string, runId: string, expectedVersion: number, to: AutomationRun["status"], extra?: { error?: string | null; now?: number }): Promise<AutomationRun>
  listRuns(tenantId: string, orgId?: string, projectId?: string): Promise<AutomationRun[]>
  // steps
  upsertStepState(step: RunStepState): Promise<void>
  getStepStates(tenantId: string, runId: string): Promise<RunStepState[]>
  /** Read a single step state (used by the orchestrator to resume). */
  getStepState(tenantId: string, runId: string, stepId: string): Promise<RunStepState | null>
  // job mappings
  saveJobMapping(mapping: JobMapping): Promise<void>
  /** Look up a mapping by (runId, stepId). Returns null when none exists — the
   *  orchestrator uses this to decide whether to create a job or reuse one. */
  getJobMapping(tenantId: string, runId: string, stepId: string): Promise<JobMapping | null>
  listJobMappings(tenantId: string, runId: string): Promise<JobMapping[]>
  /** Reverse lookup: which (run, step) owns a job? Used by projection. */
  getJobMappingByJob(tenantId: string, jobId: string): Promise<JobMapping | null>
  // artifacts
  saveArtifact(artifact: AutomationArtifact): Promise<void>
  listArtifacts(tenantId: string, runId: string): Promise<AutomationArtifact[]>
  // approvals
  saveApprovalRequest(req: ApprovalRequest): Promise<void>
  getApprovalRequest(tenantId: string, approvalId: string): Promise<ApprovalRequest | null>
  getApprovalRequestByGate(tenantId: string, runId: string, gateId: string): Promise<ApprovalRequest | null>
  listApprovalRequests(tenantId: string, runId: string): Promise<ApprovalRequest[]>
  /** Fenced terminal decision: only commits if approvalVersion matches expected
   *  and status is pending. Concurrent decisions serialize to one outcome. */
  decideApproval(tenantId: string, approvalId: string, expectedVersion: number, decision: ApprovalDecision, actor: { principalId: string; kind: string }, metadata?: Record<string, unknown>, now?: number): Promise<ApprovalRequest>
  /** Atomically expire a pending request past its expiresAt. Idempotent. */
  expireApproval(tenantId: string, approvalId: string, now?: number): Promise<ApprovalRequest | null>
  // delivery
  saveDeliveryAttempt(d: DeliveryAttempt): Promise<void>
  getDeliveryAttempt(tenantId: string, deliveryId: string): Promise<DeliveryAttempt | null>
  getDeliveryAttemptByKey(tenantId: string, runId: string, idempotencyKey: string): Promise<DeliveryAttempt | null>
  listDeliveryAttempts(tenantId: string, runId: string): Promise<DeliveryAttempt[]>
  /** Fenced delivery transition (in_progress/delivered/failed). */
  transitionDelivery(tenantId: string, deliveryId: string, expectedVersion: number, to: DeliveryStatus, extra?: { resultRef?: string; error?: string | null; now?: number }): Promise<DeliveryAttempt>
  // events
  appendEvent(tenantId: string, event: AutomationEvent): Promise<void>
  listEvents(tenantId: string, runId: string, afterSeq?: number): Promise<AutomationEvent[]>
  // -- Phase 2B: tenant-wide operational listings (read-only, recovery/ops) --
  /** Pending approvals past their expiresAt (tenant-scoped). */
  listExpiredApprovals(tenantId: string, now?: number): Promise<ApprovalRequest[]>
  /** Failed delivery attempts whose run is still in a delivery-capable state. */
  listFailedDeliveriesForRetry(tenantId: string): Promise<DeliveryAttempt[]>
  /** Non-terminal runs whose updated_at is older than the staleness threshold. */
  listStaleRuns(tenantId: string, staleBefore: number, limit?: number): Promise<AutomationRun[]>
}

// ---------------------------------------------------------------------------
// Row types + mappers
// ---------------------------------------------------------------------------

interface TemplateRow {
  template_id: string
  tenant_id: string
  org_id: string
  project_id: string
  name: string
  description: string | null
  status: string
  created_at: number
  created_by: string
  archived_at: number | null
}
function toTemplate(row: TemplateRow): AutomationTemplate {
  return {
    templateId: row.template_id,
    tenantId: row.tenant_id,
    orgId: row.org_id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    status: row.status as AutomationTemplate["status"],
    createdAt: row.created_at,
    createdBy: row.created_by,
    archivedAt: row.archived_at,
  }
}

interface VersionRow {
  version_id: string
  template_id: string
  tenant_id: string
  org_id: string
  project_id: string
  version: number
  definition: string
  input_contract: string
  checksum: string
  created_at: number
  created_by: string
}
function toVersion(row: VersionRow): AutomationVersion {
  const version: AutomationVersion = {
    versionId: row.version_id,
    tenantId: row.tenant_id,
    orgId: row.org_id,
    projectId: row.project_id,
    templateId: row.template_id,
    version: row.version,
    definition: JSON.parse(row.definition),
    inputContract: JSON.parse(row.input_contract),
    checksum: row.checksum,
    createdAt: row.created_at,
    createdBy: row.created_by,
  }
  // Detect corruption on load.
  verifyVersionChecksum(version)
  return version
}

interface RunRow {
  run_id: string
  tenant_id: string
  org_id: string
  project_id: string
  template_id: string
  version_id: string
  version: number
  status: string
  input_revision_id: string
  run_version: number
  created_by: string
  error: string | null
  created_at: number
  updated_at: number
  suspended_at: number | null
  completed_at: number | null
}
function toRun(row: RunRow): AutomationRun {
  return {
    runId: row.run_id,
    tenantId: row.tenant_id,
    orgId: row.org_id,
    projectId: row.project_id,
    templateId: row.template_id,
    versionId: row.version_id,
    version: row.version,
    status: row.status as AutomationRun["status"],
    inputRevisionId: row.input_revision_id,
    runVersion: row.run_version,
    createdBy: row.created_by,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    suspendedAt: row.suspended_at,
    completedAt: row.completed_at,
  }
}

interface StepRow {
  run_id: string
  step_id: string
  status: string
  job_id: string | null
  outputs: string
  started_at: number | null
  completed_at: number | null
  error: string | null
}
function toStep(row: StepRow): RunStepState {
  return {
    runId: row.run_id,
    stepId: row.step_id,
    status: row.status as StepStatus,
    jobId: row.job_id,
    outputs: JSON.parse(row.outputs) as Record<string, unknown>,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    error: row.error,
  }
}

interface MappingRow {
  mapping_id: string
  run_id: string
  version_id: string
  step_id: string
  job_id: string
  idempotency_key: string
  input_revision_id: string
  created_at: number
}
function toMapping(row: MappingRow): JobMapping {
  return {
    mappingId: row.mapping_id,
    runId: row.run_id,
    versionId: row.version_id,
    stepId: row.step_id,
    jobId: row.job_id,
    idempotencyKey: row.idempotency_key,
    inputRevisionId: row.input_revision_id,
    createdAt: row.created_at,
  }
}

interface ArtifactRow {
  artifact_id: string
  run_id: string
  version_id: string
  step_id: string | null
  type: string
  name: string
  content_ref: string
  checksum: string
  size: number | null
  created_at: number
  metadata: string
}
function toArtifact(row: ArtifactRow): AutomationArtifact {
  return {
    artifactId: row.artifact_id,
    runId: row.run_id,
    versionId: row.version_id,
    stepId: row.step_id,
    type: row.type,
    name: row.name,
    contentRef: row.content_ref,
    checksum: row.checksum,
    size: row.size,
    createdAt: row.created_at,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
  }
}

interface ApprovalRow {
  approval_id: string
  run_id: string
  version_id: string
  gate_id: string
  status: string
  min_approver_role: string
  context_artifacts: string
  created_at: number
  expires_at: number | null
  decision_actor: string | null
  decision_time: number | null
  decision_metadata: string | null
  approval_version: number
}
function toApproval(row: ApprovalRow): ApprovalRequest {
  return {
    approvalId: row.approval_id,
    runId: row.run_id,
    versionId: row.version_id,
    gateId: row.gate_id,
    status: row.status as ApprovalStatus,
    minApproverRole: row.min_approver_role as ApprovalRequest["minApproverRole"],
    contextArtifacts: JSON.parse(row.context_artifacts) as string[],
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    decisionActor: row.decision_actor ? (JSON.parse(row.decision_actor) as { principalId: string; kind: string }) : null,
    decisionTime: row.decision_time,
    decisionMetadata: row.decision_metadata ? (JSON.parse(row.decision_metadata) as Record<string, unknown>) : null,
    approvalVersion: row.approval_version,
  }
}

interface DeliveryRow {
  delivery_id: string
  run_id: string
  version_id: string
  idempotency_key: string
  destination: string
  status: string
  attempts: number
  result_ref: string | null
  created_at: number
  updated_at: number
  last_error: string | null
  delivery_version: number
}
function toDelivery(row: DeliveryRow): DeliveryAttempt {
  return {
    deliveryId: row.delivery_id,
    runId: row.run_id,
    versionId: row.version_id,
    idempotencyKey: row.idempotency_key,
    destination: row.destination,
    status: row.status as DeliveryStatus,
    attempts: row.attempts,
    resultRef: row.result_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastError: row.last_error,
    deliveryVersion: row.delivery_version,
  }
}

function toEvent(row: { run_id: string; seq: number; timestamp: number; type: string; data: string }): AutomationEvent {
  return { runId: row.run_id, seq: row.seq, timestamp: row.timestamp, type: row.type as AutomationEvent["type"], data: JSON.parse(row.data) }
}

// ---------------------------------------------------------------------------
// SQL store
// ---------------------------------------------------------------------------

export interface AutomationStoreOptions {
  readonly dialect?: SqlDialect
  readonly beforeCommit?: (op: string) => void
}

export class SqlAutomationStore extends SqlStoreBase implements AutomationStore {
  constructor(db: SqlDatabase, options: AutomationStoreOptions = {}) {
    super(db, AUTOMATION_MIGRATIONS, { ...(options.dialect ? { dialect: options.dialect } : {}), beforeCommit: options.beforeCommit })
  }

  // -- templates -----------------------------------------------------------
  async createTemplate(template: AutomationTemplate): Promise<AutomationTemplate> {
    try {
      this.atomic("createTemplate", () => {
        this.prepare(
          "INSERT INTO automation_templates (template_id, tenant_id, org_id, project_id, name, description, status, created_at, created_by, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          template.templateId,
          template.tenantId,
          template.orgId,
          template.projectId,
          template.name,
          template.description,
          template.status,
          template.createdAt,
          template.createdBy,
          template.archivedAt,
        )
      })
    } catch (error) {
      if (isUniqueViolation(error)) throw new AutomationError("TEMPLATE_EXISTS", `Template name "${template.name}" already exists in this project`, 409)
      throw error
    }
    return template
  }

  async getTemplate(tenantId: string, templateId: string): Promise<AutomationTemplate | null> {
    const row = this.prepare("SELECT * FROM automation_templates WHERE tenant_id = ? AND template_id = ?").get(tenantId, templateId) as unknown as TemplateRow | undefined
    return row ? toTemplate(row) : null
  }

  async listTemplates(tenantId: string, orgId?: string, projectId?: string): Promise<AutomationTemplate[]> {
    const where = ["tenant_id = ?"]
    const params: (string | number)[] = [tenantId]
    if (orgId) {
      where.push("org_id = ?")
      params.push(orgId)
    }
    if (projectId) {
      where.push("project_id = ?")
      params.push(projectId)
    }
    const rows = this.prepare(`SELECT * FROM automation_templates WHERE ${where.join(" AND ")} ORDER BY created_at ASC`).all(...params) as unknown as TemplateRow[]
    return rows.map(toTemplate)
  }

  async archiveTemplate(tenantId: string, templateId: string, now = Date.now()): Promise<AutomationTemplate | null> {
    const result = this.atomic("archiveTemplate", () =>
      this.prepare("UPDATE automation_templates SET status = 'archived', archived_at = ? WHERE tenant_id = ? AND template_id = ?").run(now, tenantId, templateId),
    )
    if (result.changes === 0) return null
    return this.getTemplate(tenantId, templateId)
  }

  // -- versions ------------------------------------------------------------
  async createVersion(version: AutomationVersion): Promise<AutomationVersion> {
    try {
      this.atomic("createVersion", () => {
        this.prepare(
          "INSERT INTO automation_versions (version_id, template_id, tenant_id, org_id, project_id, version, definition, input_contract, checksum, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          version.versionId,
          version.templateId,
          version.tenantId,
          version.orgId,
          version.projectId,
          version.version,
          JSON.stringify(version.definition),
          JSON.stringify(version.inputContract),
          version.checksum,
          version.createdAt,
          version.createdBy,
        )
      })
    } catch (error) {
      if (isUniqueViolation(error)) throw new AutomationError("VERSION_EXISTS", `Version ${version.version} already exists for template ${version.templateId}`, 409)
      throw error
    }
    return version
  }

  async getVersion(tenantId: string, versionId: string): Promise<AutomationVersion | null> {
    const row = this.prepare("SELECT * FROM automation_versions WHERE tenant_id = ? AND version_id = ?").get(tenantId, versionId) as unknown as VersionRow | undefined
    return row ? toVersion(row) : null
  }

  async getVersionByNumber(tenantId: string, templateId: string, version: number): Promise<AutomationVersion | null> {
    const row = this.prepare("SELECT * FROM automation_versions WHERE tenant_id = ? AND template_id = ? AND version = ?").get(tenantId, templateId, version) as unknown as VersionRow | undefined
    return row ? toVersion(row) : null
  }

  async nextVersionNumber(tenantId: string, templateId: string): Promise<number> {
    const row = this.prepare("SELECT COALESCE(MAX(version), 0) AS max FROM automation_versions WHERE tenant_id = ? AND template_id = ?").get(tenantId, templateId) as { max: number }
    return Number(row.max) + 1
  }

  async listVersions(tenantId: string, templateId: string): Promise<AutomationVersion[]> {
    const rows = this.prepare("SELECT * FROM automation_versions WHERE tenant_id = ? AND template_id = ? ORDER BY version ASC").all(tenantId, templateId) as unknown as VersionRow[]
    return rows.map(toVersion)
  }

  // -- inputs --------------------------------------------------------------
  async saveInputRevision(revision: RunInputRevision): Promise<void> {
    this.atomic("saveInputRevision", () => {
      this.prepare("INSERT INTO automation_run_inputs (input_revision_id, run_id, checksum, values, created_at) VALUES (?, ?, ?, ?, ?)").run(
        revision.inputRevisionId,
        revision.runId,
        revision.checksum,
        JSON.stringify(revision.values),
        revision.createdAt,
      )
    })
  }

  async getInputRevision(tenantId: string, runId: string, revisionId: string): Promise<RunInputRevision | null> {
    const row = this.prepare(
      `SELECT i.* FROM automation_run_inputs i JOIN automation_runs r ON r.run_id = i.run_id
       WHERE r.tenant_id = ? AND i.run_id = ? AND i.input_revision_id = ?`,
    ).get(tenantId, runId, revisionId) as unknown as { input_revision_id: string; run_id: string; checksum: string; values: string; created_at: number } | undefined
    if (!row) return null
    return { inputRevisionId: row.input_revision_id, runId: row.run_id, checksum: row.checksum, values: JSON.parse(row.values), createdAt: row.created_at }
  }

  // -- runs ----------------------------------------------------------------
  async createRun(run: AutomationRun): Promise<AutomationRun> {
    try {
      this.atomic("createRun", () => {
        this.prepare(
          `INSERT INTO automation_runs (run_id, tenant_id, org_id, project_id, template_id, version_id, version, status, input_revision_id, run_version, created_by, error, created_at, updated_at, suspended_at, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          run.runId,
          run.tenantId,
          run.orgId,
          run.projectId,
          run.templateId,
          run.versionId,
          run.version,
          run.status,
          run.inputRevisionId,
          run.runVersion,
          run.createdBy,
          run.error,
          run.createdAt,
          run.updatedAt,
          run.suspendedAt,
          run.completedAt,
        )
      })
    } catch (error) {
      if (isUniqueViolation(error)) throw new AutomationError("RUN_EXISTS", `Run ${run.runId} already exists`, 409)
      throw error
    }
    return run
  }

  async getRun(tenantId: string, runId: string): Promise<AutomationRun | null> {
    const row = this.prepare("SELECT * FROM automation_runs WHERE tenant_id = ? AND run_id = ?").get(tenantId, runId) as unknown as RunRow | undefined
    return row ? toRun(row) : null
  }

  async transitionRun(
    tenantId: string,
    runId: string,
    expectedVersion: number,
    to: AutomationRun["status"],
    extra?: { error?: string | null; now?: number },
  ): Promise<AutomationRun> {
    const now = extra?.now ?? Date.now()
    return this.atomic("transitionRun", () => {
      const row = this.prepare("SELECT * FROM automation_runs WHERE tenant_id = ? AND run_id = ?").get(tenantId, runId) as unknown as RunRow | undefined
      if (!row) throw new AutomationError("RUN_NOT_FOUND", `Run ${runId} not found`, 404)
      const current = toRun(row)
      if (current.runVersion !== expectedVersion) {
        throw new AutomationError("RUN_FENCED", `Run ${runId} is owned by a newer version`, 409)
      }
      // Validate transition BEFORE writing; an illegal transition rolls back.
      const updated = applyTransition(current, to, extra)
      const result = this.prepare(
        "UPDATE automation_runs SET status = ?, error = ?, updated_at = ?, suspended_at = ?, completed_at = ?, run_version = run_version + 1 WHERE tenant_id = ? AND run_id = ? AND run_version = ?",
      ).run(updated.status, updated.error, now, updated.suspendedAt, updated.completedAt, tenantId, runId, expectedVersion)
      if (result.changes === 0) {
        throw new AutomationError("RUN_FENCED", `Run ${runId} is owned by a newer version`, 409)
      }
      return updated
    })
  }

  async listRuns(tenantId: string, orgId?: string, projectId?: string): Promise<AutomationRun[]> {
    const where = ["tenant_id = ?"]
    const params: (string | number)[] = [tenantId]
    if (orgId) {
      where.push("org_id = ?")
      params.push(orgId)
    }
    if (projectId) {
      where.push("project_id = ?")
      params.push(projectId)
    }
    const rows = this.prepare(`SELECT * FROM automation_runs WHERE ${where.join(" AND ")} ORDER BY created_at ASC`).all(...params) as unknown as RunRow[]
    return rows.map(toRun)
  }

  // -- steps ---------------------------------------------------------------
  async upsertStepState(step: RunStepState): Promise<void> {
    this.atomic("upsertStepState", () => {
      this.prepare(
        `INSERT INTO automation_run_steps (run_id, step_id, status, job_id, outputs, started_at, completed_at, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, step_id) DO UPDATE SET status = excluded.status, job_id = excluded.job_id, outputs = excluded.outputs, started_at = excluded.started_at, completed_at = excluded.completed_at, error = excluded.error`,
      ).run(step.runId, step.stepId, step.status, step.jobId, JSON.stringify(step.outputs), step.startedAt, step.completedAt, step.error)
    })
  }

  async getStepStates(tenantId: string, runId: string): Promise<RunStepState[]> {
    const rows = this.prepare(
      `SELECT s.* FROM automation_run_steps s JOIN automation_runs r ON r.run_id = s.run_id WHERE r.tenant_id = ? AND s.run_id = ? ORDER BY s.step_id ASC`,
    ).all(tenantId, runId) as unknown as StepRow[]
    return rows.map(toStep)
  }

  async getStepState(tenantId: string, runId: string, stepId: string): Promise<RunStepState | null> {
    const row = this.prepare(
      `SELECT s.* FROM automation_run_steps s JOIN automation_runs r ON r.run_id = s.run_id WHERE r.tenant_id = ? AND s.run_id = ? AND s.step_id = ?`,
    ).get(tenantId, runId, stepId) as unknown as StepRow | undefined
    return row ? toStep(row) : null
  }

  // -- job mappings --------------------------------------------------------
  async saveJobMapping(mapping: JobMapping): Promise<void> {
    try {
      this.atomic("saveJobMapping", () => {
        this.prepare(
          "INSERT INTO automation_job_mappings (mapping_id, run_id, version_id, step_id, job_id, idempotency_key, input_revision_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(mapping.mappingId, mapping.runId, mapping.versionId, mapping.stepId, mapping.jobId, mapping.idempotencyKey, mapping.inputRevisionId, mapping.createdAt)
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        // (run_id, step_id) already mapped — a restart re-attempt. The caller
        // must read the existing mapping instead of creating a duplicate job.
        throw new AutomationError("JOB_MAPPING_EXISTS", `Step ${mapping.stepId} is already mapped for run ${mapping.runId}`, 409)
      }
      throw error
    }
  }

  async getJobMapping(tenantId: string, runId: string, stepId: string): Promise<JobMapping | null> {
    const row = this.prepare(
      `SELECT m.* FROM automation_job_mappings m JOIN automation_runs r ON r.run_id = m.run_id WHERE r.tenant_id = ? AND m.run_id = ? AND m.step_id = ?`,
    ).get(tenantId, runId, stepId) as unknown as MappingRow | undefined
    return row ? toMapping(row) : null
  }

  async listJobMappings(tenantId: string, runId: string): Promise<JobMapping[]> {
    const rows = this.prepare(
      `SELECT m.* FROM automation_job_mappings m JOIN automation_runs r ON r.run_id = m.run_id WHERE r.tenant_id = ? AND m.run_id = ? ORDER BY m.created_at ASC`,
    ).all(tenantId, runId) as unknown as MappingRow[]
    return rows.map(toMapping)
  }

  async getJobMappingByJob(tenantId: string, jobId: string): Promise<JobMapping | null> {
    const row = this.prepare(
      `SELECT m.* FROM automation_job_mappings m JOIN automation_runs r ON r.run_id = m.run_id WHERE r.tenant_id = ? AND m.job_id = ?`,
    ).get(tenantId, jobId) as unknown as MappingRow | undefined
    return row ? toMapping(row) : null
  }

  // -- artifacts -----------------------------------------------------------
  async saveArtifact(artifact: AutomationArtifact): Promise<void> {
    try {
      this.atomic("saveArtifact", () => {
        this.prepare(
          "INSERT INTO automation_artifacts (artifact_id, run_id, version_id, step_id, type, name, content_ref, checksum, size, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(artifact.artifactId, artifact.runId, artifact.versionId, artifact.stepId, artifact.type, artifact.name, artifact.contentRef, artifact.checksum, artifact.size, artifact.createdAt, JSON.stringify(artifact.metadata))
      })
    } catch (error) {
      if (isUniqueViolation(error)) throw new AutomationError("ARTIFACT_EXISTS", `Artifact ${artifact.artifactId} already exists`, 409)
      throw error
    }
  }

  async listArtifacts(tenantId: string, runId: string): Promise<AutomationArtifact[]> {
    const rows = this.prepare(
      `SELECT a.* FROM automation_artifacts a JOIN automation_runs r ON r.run_id = a.run_id WHERE r.tenant_id = ? AND a.run_id = ? ORDER BY a.created_at ASC`,
    ).all(tenantId, runId) as unknown as ArtifactRow[]
    return rows.map(toArtifact)
  }

  // -- approvals -----------------------------------------------------------
  async saveApprovalRequest(req: ApprovalRequest): Promise<void> {
    try {
      this.atomic("saveApprovalRequest", () => {
        this.prepare(
          `INSERT INTO approval_requests (approval_id, run_id, version_id, gate_id, status, min_approver_role, context_artifacts, created_at, expires_at, decision_actor, decision_time, decision_metadata, approval_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(req.approvalId, req.runId, req.versionId, req.gateId, req.status, req.minApproverRole, JSON.stringify(req.contextArtifacts), req.createdAt, req.expiresAt, req.decisionActor ? JSON.stringify(req.decisionActor) : null, req.decisionTime, req.decisionMetadata ? JSON.stringify(req.decisionMetadata) : null, req.approvalVersion)
      })
    } catch (error) {
      if (isUniqueViolation(error)) throw new AutomationError("APPROVAL_EXISTS", `Approval gate ${req.gateId} already exists for run ${req.runId}`, 409)
      throw error
    }
  }

  async getApprovalRequest(tenantId: string, approvalId: string): Promise<ApprovalRequest | null> {
    const row = this.prepare(
      `SELECT a.* FROM approval_requests a JOIN automation_runs r ON r.run_id = a.run_id WHERE r.tenant_id = ? AND a.approval_id = ?`,
    ).get(tenantId, approvalId) as unknown as ApprovalRow | undefined
    return row ? toApproval(row) : null
  }

  async getApprovalRequestByGate(tenantId: string, runId: string, gateId: string): Promise<ApprovalRequest | null> {
    const row = this.prepare(
      `SELECT a.* FROM approval_requests a JOIN automation_runs r ON r.run_id = a.run_id WHERE r.tenant_id = ? AND a.run_id = ? AND a.gate_id = ?`,
    ).get(tenantId, runId, gateId) as unknown as ApprovalRow | undefined
    return row ? toApproval(row) : null
  }

  async listApprovalRequests(tenantId: string, runId: string): Promise<ApprovalRequest[]> {
    const rows = this.prepare(
      `SELECT a.* FROM approval_requests a JOIN automation_runs r ON r.run_id = a.run_id WHERE r.tenant_id = ? AND a.run_id = ? ORDER BY a.created_at ASC`,
    ).all(tenantId, runId) as unknown as ApprovalRow[]
    return rows.map(toApproval)
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
    return this.atomic("decideApproval", () => {
      const row = this.prepare(
        `SELECT a.* FROM approval_requests a JOIN automation_runs r ON r.run_id = a.run_id WHERE r.tenant_id = ? AND a.approval_id = ?`,
      ).get(tenantId, approvalId) as unknown as ApprovalRow | undefined
      if (!row) throw new AutomationError("APPROVAL_NOT_FOUND", `Approval ${approvalId} not found`, 404)
      const current = toApproval(row)
      if (current.approvalVersion !== expectedVersion) {
        throw new AutomationError("APPROVAL_FENCED", `Approval ${approvalId} is owned by a newer version`, 409)
      }
      if (current.status !== "pending") {
        // Already terminally decided: idempotent return of the existing decision.
        // A concurrent second decision observes the terminal state and returns it
        // unchanged — never a contradictory outcome.
        return current
      }
      const updated = applyDecision(current, decision, actor, metadata, now)
      const result = this.prepare(
        `UPDATE approval_requests SET status = ?, decision_actor = ?, decision_time = ?, decision_metadata = ?, approval_version = approval_version + 1
         WHERE approval_id = ? AND approval_version = ? AND status = 'pending'`,
      ).run(updated.status, JSON.stringify(updated.decisionActor), updated.decisionTime, updated.decisionMetadata ? JSON.stringify(updated.decisionMetadata) : null, approvalId, expectedVersion)
      if (result.changes === 0) {
        // Lost the race to a concurrent decision: return the now-terminal state.
        const after = this.prepare(
          `SELECT a.* FROM approval_requests a JOIN automation_runs r ON r.run_id = a.run_id WHERE r.tenant_id = ? AND a.approval_id = ?`,
        ).get(tenantId, approvalId) as unknown as ApprovalRow | undefined
        return after ? toApproval(after) : updated
      }
      return updated
    })
  }

  async expireApproval(tenantId: string, approvalId: string, now = Date.now()): Promise<ApprovalRequest | null> {
    return this.atomic("expireApproval", () => {
      const row = this.prepare(
        `SELECT a.* FROM approval_requests a JOIN automation_runs r ON r.run_id = a.run_id WHERE r.tenant_id = ? AND a.approval_id = ?`,
      ).get(tenantId, approvalId) as unknown as ApprovalRow | undefined
      if (!row) return null
      const current = toApproval(row)
      if (current.status !== "pending") return current
      if (current.expiresAt === null || current.expiresAt > now) return current
      const updated = applyExpiry(current, now)
      this.prepare(
        `UPDATE approval_requests SET status = 'expired', decision_time = ?, approval_version = approval_version + 1
         WHERE approval_id = ? AND status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?`,
      ).run(now, approvalId, now)
      return updated
    })
  }

  // -- delivery ------------------------------------------------------------
  async saveDeliveryAttempt(d: DeliveryAttempt): Promise<void> {
    try {
      this.atomic("saveDeliveryAttempt", () => {
        this.prepare(
          `INSERT INTO delivery_attempts (delivery_id, run_id, version_id, idempotency_key, destination, status, attempts, result_ref, created_at, updated_at, last_error, delivery_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(d.deliveryId, d.runId, d.versionId, d.idempotencyKey, d.destination, d.status, d.attempts, d.resultRef, d.createdAt, d.updatedAt, d.lastError, d.deliveryVersion)
      })
    } catch (error) {
      if (isUniqueViolation(error)) throw new AutomationError("DELIVERY_EXISTS", `Delivery key ${d.idempotencyKey} already exists for run ${d.runId}`, 409)
      throw error
    }
  }

  async getDeliveryAttempt(tenantId: string, deliveryId: string): Promise<DeliveryAttempt | null> {
    const row = this.prepare(
      `SELECT d.* FROM delivery_attempts d JOIN automation_runs r ON r.run_id = d.run_id WHERE r.tenant_id = ? AND d.delivery_id = ?`,
    ).get(tenantId, deliveryId) as unknown as DeliveryRow | undefined
    return row ? toDelivery(row) : null
  }

  async getDeliveryAttemptByKey(tenantId: string, runId: string, idempotencyKey: string): Promise<DeliveryAttempt | null> {
    const row = this.prepare(
      `SELECT d.* FROM delivery_attempts d JOIN automation_runs r ON r.run_id = d.run_id WHERE r.tenant_id = ? AND d.run_id = ? AND d.idempotency_key = ?`,
    ).get(tenantId, runId, idempotencyKey) as unknown as DeliveryRow | undefined
    return row ? toDelivery(row) : null
  }

  async listDeliveryAttempts(tenantId: string, runId: string): Promise<DeliveryAttempt[]> {
    const rows = this.prepare(
      `SELECT d.* FROM delivery_attempts d JOIN automation_runs r ON r.run_id = d.run_id WHERE r.tenant_id = ? AND d.run_id = ? ORDER BY d.created_at ASC`,
    ).all(tenantId, runId) as unknown as DeliveryRow[]
    return rows.map(toDelivery)
  }

  async transitionDelivery(
    tenantId: string,
    deliveryId: string,
    expectedVersion: number,
    to: DeliveryStatus,
    extra?: { resultRef?: string; error?: string | null; now?: number },
  ): Promise<DeliveryAttempt> {
    const now = extra?.now ?? Date.now()
    return this.atomic("transitionDelivery", () => {
      const row = this.prepare(
        `SELECT d.* FROM delivery_attempts d JOIN automation_runs r ON r.run_id = d.run_id WHERE r.tenant_id = ? AND d.delivery_id = ?`,
      ).get(tenantId, deliveryId) as unknown as DeliveryRow | undefined
      if (!row) throw new AutomationError("DELIVERY_NOT_FOUND", `Delivery ${deliveryId} not found`, 404)
      const current = toDelivery(row)
      if (current.deliveryVersion !== expectedVersion) {
        throw new AutomationError("DELIVERY_FENCED", `Delivery ${deliveryId} is owned by a newer version`, 409)
      }
      // Validate transition before writing; illegal transition rolls back.
      let updated: DeliveryAttempt
      if (to === "delivered") {
        updated = { ...current, status: "delivered", resultRef: extra?.resultRef ?? current.resultRef, updatedAt: now, lastError: null, deliveryVersion: current.deliveryVersion + 1 }
      } else if (to === "failed") {
        updated = { ...current, status: "failed", lastError: extra?.error ?? current.lastError, updatedAt: now, deliveryVersion: current.deliveryVersion + 1 }
      } else if (to === "in_progress") {
        updated = { ...current, status: "in_progress", attempts: current.attempts + 1, updatedAt: now, deliveryVersion: current.deliveryVersion + 1 }
      } else {
        throw new AutomationError("ILLEGAL_DELIVERY_TRANSITION", `Delivery ${deliveryId} cannot transition → ${to}`, 409)
      }
      // canDeliveryTransition guard
      const fromStatus = current.status
      if (fromStatus === to || fromStatus === "delivered" || fromStatus === "failed") {
        throw new AutomationError("ILLEGAL_DELIVERY_TRANSITION", `Delivery ${deliveryId} cannot transition ${fromStatus} → ${to}`, 409)
      }
      const result = this.prepare(
        `UPDATE delivery_attempts SET status = ?, attempts = ?, result_ref = ?, updated_at = ?, last_error = ?, delivery_version = delivery_version + 1
         WHERE delivery_id = ? AND delivery_version = ?`,
      ).run(updated.status, updated.attempts, updated.resultRef, now, updated.lastError, deliveryId, expectedVersion)
      if (result.changes === 0) {
        throw new AutomationError("DELIVERY_FENCED", `Delivery ${deliveryId} is owned by a newer version`, 409)
      }
      return updated
    })
  }

  // -- events --------------------------------------------------------------
  async appendEvent(tenantId: string, event: AutomationEvent): Promise<void> {
    try {
      this.atomic("appendEvent", () => {
        this.prepare("INSERT INTO automation_events (run_id, seq, timestamp, type, data) VALUES (?, ?, ?, ?, ?)").run(event.runId, event.seq, event.timestamp, event.type, JSON.stringify(event.data))
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        // (run_id, seq) duplicate — a replay of the same projected event. Ignore.
        return
      }
      throw error
    }
    // Tenant scoping is enforced by the FK + join at read time; the event row
    // inherits the run's tenant via run_id.
    void tenantId
  }

  async listEvents(tenantId: string, runId: string, afterSeq = 0): Promise<AutomationEvent[]> {
    const rows = this.prepare(
      `SELECT e.* FROM automation_events e JOIN automation_runs r ON r.run_id = e.run_id WHERE r.tenant_id = ? AND e.run_id = ? AND e.seq > ? ORDER BY e.seq ASC`,
    ).all(tenantId, runId, afterSeq) as unknown as Array<{ run_id: string; seq: number; timestamp: number; type: string; data: string }>
    return rows.map(toEvent)
  }

  // -- Phase 2B: tenant-wide operational listings --------------------------

  async listExpiredApprovals(tenantId: string, now = Date.now()): Promise<ApprovalRequest[]> {
    const rows = this.prepare(
      `SELECT a.* FROM approval_requests a JOIN automation_runs r ON r.run_id = a.run_id WHERE r.tenant_id = ? AND a.status = 'pending' AND a.expires_at IS NOT NULL AND a.expires_at <= ? ORDER BY a.created_at ASC`,
    ).all(tenantId, now) as unknown as ApprovalRow[]
    return rows.map(toApproval)
  }

  async listFailedDeliveriesForRetry(tenantId: string): Promise<DeliveryAttempt[]> {
    const rows = this.prepare(
      `SELECT d.* FROM delivery_attempts d JOIN automation_runs r ON r.run_id = d.run_id WHERE r.tenant_id = ? AND d.status = 'failed' AND r.status IN ('delivering','failed') ORDER BY d.updated_at ASC`,
    ).all(tenantId) as unknown as DeliveryRow[]
    return rows.map(toDelivery)
  }

  async listStaleRuns(tenantId: string, staleBefore: number, limit = 100): Promise<AutomationRun[]> {
    const rows = this.prepare(
      `SELECT * FROM automation_runs WHERE tenant_id = ? AND status IN ('admitted','running','collecting','awaiting_approval','delivering') AND updated_at < ? ORDER BY updated_at ASC LIMIT ?`,
    ).all(tenantId, staleBefore, limit) as unknown as RunRow[]
    return rows.map(toRun)
  }
}

/** Default dialect is SQLite; PG uses the same store via the dialect option. */
export { sqliteDialect }

/** Marker export so callers can construct an artifact store independently. */
export type { ArtifactStore }
