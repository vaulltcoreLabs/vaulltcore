/**
 * Vaulltcore Automation Product Layer contracts (Phase 2A).
 *
 * The product hierarchy above the Phase 1 execution kernel:
 *
 *   Tenant → Organization → Project → AutomationTemplate
 *        → AutomationVersion (immutable executable definition)
 *             → AutomationRun (product-level aggregate)
 *                  ├── Inputs (durable input revisions)
 *                  ├── Execution Job(s) (Phase 1 jobs, orchestrated, not owned)
 *                  ├── Artifacts (durable product outputs)
 *                  ├── Approval Gates (human-in-the-loop)
 *                  └── Delivery (provider-neutral output delivery)
 *
 * These types are persistence- and engine-agnostic. The product layer CONSUMES
 * the Phase 1 runner/control contracts; it never embeds product logic into the
 * runner. The {@link AgentRunner} remains the execution-level aggregate; the
 * {@link AutomationRun} is the product-level aggregate — the two are NOT merged.
 *
 * No runtime dependencies on a specific engine, Docker, PostgreSQL, or cloud
 * vendor. Plain types + hand-rolled validation only (mirrors the runner style).
 */

import type { JobIdentity, JobStatus } from "@vaulltcore/runner"

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Base error for the automation product layer. */
export class AutomationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = "AutomationError"
  }
}

// ---------------------------------------------------------------------------
// Automation templates
// ---------------------------------------------------------------------------

export const TEMPLATE_STATUSES = ["draft", "active", "archived"] as const
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number]

/**
 * A stable product identity owned by a tenant/org/project. Its executable
 * definition lives in an immutable {@link AutomationVersion}; the template is
 * the named container customers configure. Archiving a template never destroys
 * historical versions or runs.
 */
export interface AutomationTemplate extends JobIdentity {
  readonly templateId: string
  readonly name: string
  readonly description: string | null
  status: TemplateStatus
  readonly createdAt: number
  readonly createdBy: string
  archivedAt: number | null
}

// ---------------------------------------------------------------------------
// Input contract
// ---------------------------------------------------------------------------

export const INPUT_FIELD_TYPES = ["string", "number", "boolean", "json", "artifact_ref"] as const
export type InputFieldType = (typeof INPUT_FIELD_TYPES)[number]

/** A single declared input field. */
export interface InputField {
  readonly fieldId: string
  readonly type: InputFieldType
  readonly required: boolean
  readonly description: string | null
  /** For `string`/`number`: a minimum value/length (optional). */
  readonly min?: number | null
  /** For `string`/`number`: a maximum value/length (optional). */
  readonly max?: number | null
  /** For `string`: an enum of allowed literal values (optional). */
  readonly enum?: readonly string[] | null
}

/** The typed input contract published on a version. Field IDs are unique. */
export interface InputContract {
  readonly fields: readonly InputField[]
}

/** A value submitted for a field. */
export interface InputValue {
  readonly fieldId: string
  readonly value: unknown
}

/**
 * A durable snapshot of the exact accepted input for a run. The accepted input
 * is frozen at run creation and never silently replaced — if changes are
 * required, a new revision is recorded. Every execution job is traceable to the
 * exact version + input revision that produced it.
 */
export interface RunInputRevision {
  readonly inputRevisionId: string
  readonly runId: string
  /** SHA-256 over the canonical accepted input; detects tampering/corruption. */
  readonly checksum: string
  /** Canonical accepted input (fieldId → value). */
  readonly values: Readonly<Record<string, unknown>>
  readonly createdAt: number
}

// ---------------------------------------------------------------------------
// Automation definition (constrained, NOT a general workflow engine)
// ---------------------------------------------------------------------------

/**
 * Engine/runner specification for a step. `engine`/`model` identify the Phase 1
 * agent engine; `prompt` is templated from the run input + step outputs. Phase
 * 2A deliberately supports only bounded linear/DAG execution — no loops, no
 * unbounded recursion.
 */
export interface StepExecutionSpec {
  readonly engine: string
  readonly model: string
  /** Prompt template; `${input.<fieldId>}` and `${steps.<stepId>.output.<key>}`
   *  placeholders are substituted from the durable input revision and completed
   *  step outputs. */
  readonly prompt: string
  /** Engine options forwarded to the runner JobSpec (opaque to the product). */
  readonly engineOptions?: Record<string, unknown>
  /** Execution limits projected into the runner ExecutionPolicy. */
  readonly maxSteps?: number | null
  readonly maxTokens?: number | null
  readonly maxDurationMs?: number | null
  /** Tools the step is allowed to call (forwarded to admission). */
  readonly allowedTools?: readonly string[]
}

/** Maps durable run input into a step's prompt, and a step's output back out. */
export interface InputMapping {
  readonly fieldId: string
  readonly placeholder: string
}

export interface OutputMapping {
  readonly key: string
  /** A JSON-pointer-ish path into the step's terminal assistant text/output. */
  readonly path: string
}

/** One named, bounded execution step in the definition graph. */
export interface AutomationStep {
  readonly stepId: string
  readonly execution: StepExecutionSpec
  readonly inputMappings: readonly InputMapping[]
  readonly outputMappings: readonly OutputMapping[]
  /** Step IDs that must complete before this step may start. */
  readonly dependsOn: readonly string[]
}

/** Where a produced artifact comes from. */
export interface ArtifactSpec {
  readonly artifactId: string
  readonly type: string
  readonly name: string
  /** Step that produces this artifact. */
  readonly stepId: string
  /** Path into the step's output used to derive the artifact content. */
  readonly path: string
}

/** When (if ever) a run pauses for human approval. */
export interface ApprovalSpec {
  /** Whether an approval gate is required before delivery. */
  readonly required: boolean
  /** Stable gate id within the version. */
  readonly gateId: string
  /** Minimum role an approver must hold (authorization, reuse identity). */
  readonly minApproverRole: "viewer" | "operator" | "developer" | "admin" | "owner"
  /** Optional approval expiry in milliseconds from request creation. */
  readonly expiresAfterMs?: number | null
  /** Artifact ids whose context is surfaced to the approver. */
  readonly contextArtifacts: readonly string[]
}

/** How a completed run's artifacts are delivered. */
export interface DeliverySpec {
  readonly destination: string
  /** Artifact ids to deliver. */
  readonly artifactIds: readonly string[]
}

/** The immutable executable definition of an automation version. */
export interface AutomationDefinition {
  readonly steps: readonly AutomationStep[]
  readonly artifacts: readonly ArtifactSpec[]
  readonly approval: ApprovalSpec
  readonly delivery: DeliverySpec
}

// ---------------------------------------------------------------------------
// Automation versions (immutable)
// ---------------------------------------------------------------------------

/**
 * An immutable, published executable definition of a template. Once published it
 * is never mutated; any change creates a new version. The checksum detects
 * corruption/mutation of the durable definition. `(templateId, version)` is
 * unique; cross-tenant references are rejected.
 */
export interface AutomationVersion extends JobIdentity {
  readonly versionId: string
  readonly templateId: string
  /** Monotonic per-template version number, starting at 1. */
  readonly version: number
  readonly definition: AutomationDefinition
  readonly inputContract: InputContract
  /** SHA-256 over the canonical definition + input contract. */
  readonly checksum: string
  readonly createdAt: number
  readonly createdBy: string
}

// ---------------------------------------------------------------------------
// Automation run (product-level aggregate)
// ---------------------------------------------------------------------------

export const RUN_STATUSES = [
  "created",
  "validating_input",
  "admitted",
  "running",
  "collecting",
  "awaiting_approval",
  "delivering",
  "completed",
  "failed",
  "cancelled",
  "rejected",
  "suspended",
] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "rejected",
])

export function isTerminalRun(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status)
}

/** Per-step projected state inside a run. */
export const STEP_STATUSES = ["pending", "running", "completed", "failed", "skipped"] as const
export type StepStatus = (typeof STEP_STATUSES)[number]

export interface RunStepState {
  readonly runId: string
  readonly stepId: string
  status: StepStatus
  /** Phase 1 job id executing this step (null until dispatched). */
  jobId: string | null
  /** Output keys resolved from the job's terminal state. */
  outputs: Readonly<Record<string, unknown>>
  readonly startedAt: number | null
  readonly completedAt: number | null
  error: string | null
}

/**
 * The product-level aggregate. Its transitions are validated; illegal
 * transitions fail without partially advancing the run. `version` is the fencing
 * token — a stale writer (version mismatch) cannot mutate the run. The
 * underlying Phase 1 {@link JobRecord} remains the execution-level aggregate.
 */
export interface AutomationRun extends JobIdentity {
  readonly runId: string
  readonly templateId: string
  readonly versionId: string
  /** Pinned at creation; the run executes exactly this immutable version. */
  readonly version: number
  status: RunStatus
  /** Input revision frozen at run creation. */
  readonly inputRevisionId: string
  /** Fencing token; bumped on every state-changing write. */
  runVersion: number
  readonly createdBy: string
  error: string | null
  readonly createdAt: number
  updatedAt: number
  /** Set when the run is explicitly suspended (non-terminal, resumable). */
  suspendedAt: number | null
  completedAt: number | null
}

// ---------------------------------------------------------------------------
// Job orchestration mapping
// ---------------------------------------------------------------------------

/**
 * Durable mapping from a run+step to the Phase 1 job that executes it. The
 * mapping identity `(runId, stepId)` is unique, so a restart never creates a
 * duplicate job for the same step. Every job is traceable to the exact
 * automation version + input revision.
 */
export interface JobMapping {
  readonly mappingId: string
  readonly runId: string
  readonly versionId: string
  readonly stepId: string
  readonly jobId: string
  /** Idempotency key derived from (runId, stepId); guards job creation. */
  readonly idempotencyKey: string
  readonly inputRevisionId: string
  readonly createdAt: number
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

/**
 * A durable product output, not an arbitrary temp file. Records remain valid
 * historical references even after delivery. Content lives behind an
 * {@link ArtifactStore} abstraction (vendor-neutral); the record carries a
 * content reference + checksum + size.
 */
export interface AutomationArtifact {
  readonly artifactId: string
  readonly runId: string
  readonly versionId: string
  /** Step that produced the artifact (null for run-level synthetic artifacts). */
  readonly stepId: string | null
  readonly type: string
  readonly name: string
  /** Opaque pointer into the ArtifactStore (e.g. a key/digest). */
  readonly contentRef: string
  /** SHA-256 over the artifact content; detects corruption. */
  readonly checksum: string
  readonly size: number | null
  readonly createdAt: number
  /** Immutable metadata (sanitized before persistence). */
  readonly metadata: Readonly<Record<string, unknown>>
}

// ---------------------------------------------------------------------------
// Approval gates
// ---------------------------------------------------------------------------

export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "changes_requested", "expired"] as const
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number]

export const TERMINAL_APPROVAL_STATUSES: ReadonlySet<ApprovalStatus> = new Set([
  "approved",
  "rejected",
  "changes_requested",
  "expired",
])

/**
 * A first-class human approval gate. Immutable run/version identity; approver
 * scope authorized through the existing identity layer (no second auth model).
 * Decisions are idempotent: two concurrent approvers cannot produce
 * contradictory terminal decisions; once terminally decided the request cannot
 * change. A run awaiting approval cannot continue execution or delivery until a
 * valid decision permits it.
 */
export interface ApprovalRequest {
  readonly approvalId: string
  readonly runId: string
  readonly versionId: string
  readonly gateId: string
  status: ApprovalStatus
  readonly minApproverRole: "viewer" | "operator" | "developer" | "admin" | "owner"
  readonly contextArtifacts: readonly string[]
  readonly createdAt: number
  readonly expiresAt: number | null
  /** Actor who made the terminal decision (null while pending). */
  decisionActor: { readonly principalId: string; readonly kind: string } | null
  decisionTime: number | null
  /** Sanitized decision metadata. */
  decisionMetadata: Readonly<Record<string, unknown>> | null
  /** Fencing token for idempotent terminal decisions. */
  approvalVersion: number
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export const DELIVERY_STATUSES = ["pending", "in_progress", "delivered", "failed"] as const
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number]

export const TERMINAL_DELIVERY_STATUSES: ReadonlySet<DeliveryStatus> = new Set(["delivered", "failed"])

/**
 * A single delivery attempt record. At-least-once attempts with idempotent
 * settlement: a process crash never falsely marks an undelivered result as
 * delivered. `(runId, idempotencyKey)` is unique so a retry reuses the same
 * delivery identity; the attempt count tracks retries within that identity.
 */
export interface DeliveryAttempt {
  readonly deliveryId: string
  readonly runId: string
  readonly versionId: string
  readonly idempotencyKey: string
  readonly destination: string
  status: DeliveryStatus
  attempts: number
  /** Provider-returned result reference (null until delivered). */
  resultRef: string | null
  readonly createdAt: number
  updatedAt: number
  lastError: string | null
  /** Fencing token for idempotent settlement. */
  deliveryVersion: number
}

/** Provider-neutral delivery seam. Phase 2A ships a deterministic test provider. */
export interface DeliveryProvider {
  readonly id: string
  /**
   * Deliver the artifact batch. Must be idempotent on `idempotencyKey`: a replay
   * returns the original result without side effects. Throws on transient
   * failure so the caller retries within the same delivery identity.
   */
  deliver(args: {
    readonly idempotencyKey: string
    readonly destination: string
    readonly artifacts: readonly AutomationArtifact[]
    readonly contents: ReadonlyMap<string, Uint8Array>
  }): Promise<{ resultRef: string }>
}

// ---------------------------------------------------------------------------
// Artifact storage abstraction
// ---------------------------------------------------------------------------

/** Vendor-neutral artifact content store. Phase 2A ships an in-memory impl. */
export interface ArtifactStore {
  /** Store content under a content reference; returns the ref + checksum. */
  put(content: Uint8Array, name: string): Promise<{ contentRef: string; checksum: string; size: number }>
  /** Retrieve content by ref. Throws if the ref is unknown (never returns null
   *  silently — a missing artifact is an error, not an empty result). */
  get(contentRef: string): Promise<Uint8Array>
  /** Verify stored content matches a checksum (detects corruption). */
  verify(contentRef: string, expectedChecksum: string): Promise<boolean>
}

// ---------------------------------------------------------------------------
// Product event model (stable automation events; runner events stay internal)
// ---------------------------------------------------------------------------

export const AUTOMATION_EVENT_TYPES = [
  "automation.run.created",
  "automation.run.admitted",
  "automation.step.started",
  "automation.step.progress",
  "automation.step.completed",
  "automation.artifact.created",
  "automation.approval.requested",
  "automation.approval.approved",
  "automation.approval.rejected",
  "automation.delivery.started",
  "automation.delivery.completed",
  "automation.run.completed",
  "automation.run.failed",
] as const
export type AutomationEventType = (typeof AUTOMATION_EVENT_TYPES)[number]

/** Stable product-level event projected from runner events + product actions. */
export interface AutomationEvent<T = unknown> {
  readonly runId: string
  /** Monotonic durable sequence within the run, starting at 1. */
  readonly seq: number
  readonly timestamp: number
  readonly type: AutomationEventType
  readonly data: T
}

// ---------------------------------------------------------------------------
// Job observation (safe projection of Phase 1 job state into the product)
// ---------------------------------------------------------------------------

/** Safe, product-facing view of a step's underlying Phase 1 job. The product
 *  layer observes execution through this; it never depends on runner internals. */
export interface StepJobView {
  readonly runId: string
  readonly stepId: string
  readonly jobId: string
  readonly jobStatus: JobStatus
  readonly error: string | null
}
