// ============================================================================
// Vaulltcore Frontend Types
// Matches backend API contracts from vaulltcore-api-audit.md
// All timestamps are epoch-ms numbers. All IDs are opaque strings.
// ============================================================================

// --- Status Unions (backend enums as literal types) ---

export type JobStatus =
  | "queued"
  | "leased"
  | "preparing"
  | "running"
  | "checkpointing"
  | "suspended"
  | "resuming"
  | "completed"
  | "failed"
  | "cancelled";

export type RunStatus =
  | "created"
  | "validating_input"
  | "admitted"
  | "running"
  | "collecting"
  | "awaiting_approval"
  | "delivering"
  | "completed"
  | "failed"
  | "cancelled"
  | "rejected"
  | "suspended";

export type TemplateStatus = "active" | "archived";

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "changes_requested"
  | "expired";

export type ConnectionState =
  | "disconnected"
  | "authorization_pending"
  | "authorization_verified"
  | "active"
  | "degraded"
  | "expired"
  | "revoked";

export type TriggerClass =
  | "webhook_event"
  | "schedule"
  | "manual"
  | "integration_event";

export type TriggerState = "enabled" | "disabled";

export type ScheduleState = "active" | "paused" | "cancelled";
export type ScheduleKind = "one_time" | "recurring";

export type DeliveryStatus =
  | "pending"
  | "in_progress"
  | "delivered"
  | "failed_retriable"
  | "failed_terminal";

export type OpsWorkState = "pending" | "claimed" | "in_progress" | "succeeded" | "failed_terminal" | "failed_retriable" | "dead_letter";

export type InputFieldType = "string" | "number" | "boolean" | "enum" | "json";

// --- Core Entity Types ---

export interface JobUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  steps: number;
  toolCalls: number;
}

export interface JobView {
  id: string;
  tenantId: string;
  orgId: string | null;
  projectId: string | null;
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
  usage: JobUsage;
  pendingInput: string[];
}

export interface JobEvent {
  jobId: string;
  seq: number;
  timestamp: number;
  type: JobEventType;
  data: unknown;
}

export type JobEventType =
  | "queued"
  | "started"
  | "resumed"
  | "checkpoint"
  | "message"
  | "tool_request"
  | "tool_response"
  | "usage"
  | "warning"
  | "error"
  | "budget_exhausted"
  | "completed"
  | "cancelled";

// --- Automation Types ---

export interface AutomationTemplate {
  templateId: string;
  name: string;
  description: string | null;
  status: TemplateStatus;
  createdAt: number;
  createdBy: string;
  archivedAt: number | null;
  tenantId: string;
  orgId: string | null;
  projectId: string | null;
}

export interface AutomationStep {
  stepId: string;
  type: string;
  dependsOn?: string[];
  config?: Record<string, unknown>;
}

export interface ArtifactSpec {
  type: string;
  name: string;
  stepId?: string;
}

export interface ApprovalSpec {
  required: boolean;
  minApproverRole?: string;
  expiresAt?: number;
}

export interface DeliverySpec {
  type: string;
  config?: Record<string, unknown>;
}

export interface AutomationDefinition {
  steps: AutomationStep[];
  artifacts: ArtifactSpec[];
  approval: ApprovalSpec;
  delivery: DeliverySpec;
}

export interface InputField {
  fieldId: string;
  type: InputFieldType;
  required: boolean;
  description: string | null;
  min?: number;
  max?: number;
  enum?: string[];
}

export interface InputContract {
  fields: InputField[];
}

export interface AutomationVersion {
  versionId: string;
  templateId: string;
  version: number;
  status: TemplateStatus;
  definition: AutomationDefinition;
  inputContract: InputContract;
  checksum: string;
  createdAt: number;
  createdBy: string;
  tenantId: string;
  orgId: string | null;
  projectId: string | null;
}

export interface AutomationRun {
  runId: string;
  templateId: string;
  versionId: string;
  version: number;
  status: RunStatus;
  inputRevisionId: string;
  runVersion: number;
  createdBy: string;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  suspendedAt: number | null;
  completedAt: number | null;
  tenantId: string;
  orgId: string | null;
  projectId: string | null;
}

export interface AutomationArtifact {
  artifactId: string;
  runId: string;
  versionId: string;
  stepId: string | null;
  type: string;
  name: string;
  contentRef: string;
  checksum: string;
  size: number | null;
  createdAt: number;
  metadata: Record<string, unknown>;
}

export interface ApprovalRequest {
  approvalId: string;
  runId: string;
  versionId: string;
  gateId: string;
  status: ApprovalStatus;
  minApproverRole: string;
  contextArtifacts: string[];
  createdAt: number;
  expiresAt: number | null;
  decisionActor: { principalId: string; kind: string } | null;
  decisionTime: number | null;
  decisionMetadata: Record<string, unknown> | null;
  approvalVersion: number;
}

export interface SanitizedDelivery {
  deliveryId: string;
  runId: string;
  status: DeliveryStatus;
  attempts: number;
  resultRef: string | null;
  updatedAt: number;
  lastError: string | null;
  destination: string;
}

// --- Schedule Types ---

export interface ScheduleView {
  scheduleId: string;
  tenantId: string;
  orgId: string | null;
  projectId: string | null;
  name: string;
  state: ScheduleState;
  version: number;
  lastAdmittedAt: number | null;
  createdAt: number;
  updatedAt: number;
  currentVersion: {
    kind: ScheduleKind;
    cron: string | null;
    scheduledAt: number | null;
    timezone: string;
    automationVersionId: string;
    missedRunPolicy: string;
    maxCatchUp: number;
    input: Record<string, unknown>;
    checksum: string;
  } | null;
}

export interface OccurrenceView {
  occurrenceId: string;
  scheduleId: string;
  version: number;
  scheduledTime: number;
  admittedRunId: string | null;
  admittedAt: number | null;
}

// --- Connection Types ---

export type ProviderFamily = "git" | "pm" | "model" | "messaging" | "storage" | "other";

export interface ConnectionCapability {
  name: string;
  description: string | null;
}

export interface ConnectionView {
  connectionId: string;
  tenantId: string;
  orgId: string | null;
  projectId: string | null;
  family: ProviderFamily;
  provider: string;
  account: {
    externalId: string;
    displayName: string | null;
  };
  capabilities: ConnectionCapability[];
  state: ConnectionState;
  version: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

// --- Trigger Types ---

export interface TriggerMatchCriteria {
  eventKinds?: string[];
  resourcePattern?: string;
  action?: string;
  connectionId?: string;
}

export interface TriggerView {
  triggerId: string;
  templateId: string;
  versionId: string;
  triggerClass: TriggerClass;
  name: string;
  criteria: TriggerMatchCriteria | null;
  scheduleId: string | null;
  inputMapping: Record<string, unknown>;
  state: TriggerState;
  revision: number;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
}

// --- Usage Types ---

export interface UsageEventLite {
  eventId: string;
  kind: string;
  quantity: number;
  unit: string | null;
  provider: string | null;
  model: string | null;
  jobId: string;
  recordedAt: number;
}

export interface UsageAggregate {
  jobId: string | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  steps: number;
  toolCalls: number;
  durationMs: number;
}

export interface UsageSummary {
  totalTokens: number;
  totalRequests: number;
  totalDurationMs: number;
  byProvider: Record<string, { tokens: number; requests: number }>;
  byModel: Record<string, { tokens: number; requests: number }>;
  byKind: Record<string, { quantity: number; unit: string | null }>;
  period: { from: number; to: number };
}

export interface UsagePage {
  items: UsageEventLite[];
  nextCursor: string | null;
  hasMore: boolean;
}

// --- Operations Types ---

export interface RetryStatusItem {
  workId: string;
  kind: string;
  state: OpsWorkState;
  attempts: number;
  nextRetryAt: number | null;
  lastError: string | null;
}

export interface DeadLetterItem {
  workId: string;
  kind: string;
  state: string;
  attempts: number;
  lastError: string | null;
}

export interface HealthReport {
  unresolvedUsage: number;
  unresolvedPricing: number;
  orphanedReservations: number;
  settlementBacklog: number;
  snapshotGcBacklog: number;
  lastWatermark: number | null;
}

export interface ReliabilityHealthReport {
  health: HealthReport;
  tenantId: string;
}

export interface ReadinessReport {
  ready: boolean;
  checks: Record<string, boolean>;
}

export interface ReconciliationResult {
  scanned: number;
  repaired: number;
  gaps: string[];
}

export interface TimeoutScanResult {
  scanned: number;
  timedOut: number;
}

// --- Metrics ---

export interface AutomationMetrics {
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  activeRuns: number;
  successRate: number;
  totalTemplates: number;
  totalSchedules: number;
  activeSchedules: number;
}

// --- Identity Types ---

export interface ResolvedPrincipal {
  actorClass: string;
  principalId: string;
  tenantId: string;
  orgId: string | null;
  role: string;
  projectScope: string[];
  permissions: string[];
  attribution: Record<string, unknown>;
}

export interface OrganizationMembership {
  tenantId: string;
  orgId: string;
  role: string;
}

export interface OrgMember {
  principalId: string;
  role: string;
  createdAt: number;
}

export interface ServiceIdentity {
  serviceIdentityId: string;
  name: string;
  status: string;
  permissions: string[];
  createdAt: number;
  disabledAt: number | null;
  revokedAt: number | null;
}

export interface MachineCredential {
  credentialId: string;
  serviceIdentityId: string;
  prefix: string;
  createdAt: number;
  revokedAt: number | null;
  expiresAt: number | null;
  lastUsedAt: number | null;
}

export interface CredentialIssuance {
  credentialId: string;
  serviceIdentityId: string;
  prefix: string;
  fingerprint: string;
  secret: string;
  expiresAt: number;
}

export interface Session {
  sessionId: string;
  fingerprint: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

// --- Auth Types ---

export interface AuthUser {
  principalId: string;
  email?: string;
  name?: string;
  tenantId: string;
  orgId?: string;
}

export interface AuthState {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  permissions: string[];
}

// --- API Error Types ---

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

export type ApiErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INVALID_INPUT"
  | "PAYLOAD_TOO_LARGE"
  | "IDEMPOTENCY_CONFLICT"
  | "IDEMPOTENCY_INFLIGHT"
  | "QUOTA_EXCEEDED"
  | "INTERNAL"
  | "NOT_CONFIGURED";

// --- Pagination ---

export interface CursorPagination {
  cursor?: string;
  limit?: number;
  from?: number;
  to?: number;
}

// --- Automation Events ---

export interface AutomationEvent {
  runId: string;
  seq: number;
  timestamp: number;
  type: string;
  data: unknown;
}

// --- SSE Types ---

export interface SSEEvent {
  event: string;
  data: unknown;
  lastEventId?: string;
}

export interface SSEConnectionState {
  status: "connecting" | "connected" | "disconnected" | "error";
  lastSeq: number | null;
  error: string | null;
}

// --- Dispatch Types ---

export interface TriggerDispatch {
  dispatchId: string;
  triggerId: string;
  triggerRevision: number;
  sourceEventId: string;
  state: string;
  attempts: number;
  lastError: string | null;
  createdAt: number;
}
