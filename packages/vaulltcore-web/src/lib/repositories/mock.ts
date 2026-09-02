// Mock repository implementations for visual development
// These implement the same interfaces as real API repositories

import type {
  JobView, JobEvent, AutomationTemplate, AutomationVersion, AutomationRun,
  AutomationEvent, AutomationArtifact, ApprovalRequest, SanitizedDelivery,
  ScheduleView, OccurrenceView, ConnectionView, TriggerView,
  UsageEventLite, UsagePage, UsageSummary, UsageAggregate,
  RetryStatusItem, DeadLetterItem, ReliabilityHealthReport,
  ReadinessReport, ReconciliationResult, TimeoutScanResult,
  AutomationMetrics, TriggerDispatch,
} from "@/types";
import type { AppRepositories } from "./interfaces";

const now = Date.now();

// --- Mock Data ---

const mockJobs: JobView[] = [
  {
    id: "job_01HXYZ123456", tenantId: "t_1", orgId: "org_1", projectId: "proj_abc",
    status: "running", createdAt: now - 3600000, updatedAt: now - 120000,
    usage: { inputTokens: 15200, outputTokens: 8400, reasoningTokens: 2100, totalTokens: 25700, steps: 5, toolCalls: 12 },
    pendingInput: [],
  },
  {
    id: "job_01HXYZ123457", tenantId: "t_1", orgId: "org_1", projectId: "proj_abc",
    status: "completed", createdAt: now - 7200000, updatedAt: now - 6800000,
    usage: { inputTokens: 42100, outputTokens: 21300, reasoningTokens: 5400, totalTokens: 68800, steps: 12, toolCalls: 34 },
    pendingInput: [],
  },
  {
    id: "job_01HXYZ123458", tenantId: "t_1", orgId: "org_1", projectId: "proj_def",
    status: "failed", createdAt: now - 86400000, updatedAt: now - 86000000,
    usage: { inputTokens: 5200, outputTokens: 1100, reasoningTokens: 300, totalTokens: 6600, steps: 2, toolCalls: 4 },
    pendingInput: [],
  },
  {
    id: "job_01HXYZ123459", tenantId: "t_1", orgId: "org_1", projectId: "proj_abc",
    status: "queued", createdAt: now - 300000, updatedAt: now - 300000,
    usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, steps: 0, toolCalls: 0 },
    pendingInput: [],
  },
  {
    id: "job_01HXYZ123460", tenantId: "t_1", orgId: "org_1", projectId: "proj_ghi",
    status: "cancelled", createdAt: now - 172800000, updatedAt: now - 172700000,
    usage: { inputTokens: 1200, outputTokens: 400, reasoningTokens: 100, totalTokens: 1700, steps: 1, toolCalls: 2 },
    pendingInput: [],
  },
];

const mockJobEvents: JobEvent[] = [
  { jobId: "job_01HXYZ123456", seq: 1, timestamp: now - 3600000, type: "queued", data: {} },
  { jobId: "job_01HXYZ123456", seq: 2, timestamp: now - 3500000, type: "started", data: { model: "claude-sonnet-4-20250514" } },
  { jobId: "job_01HXYZ123456", seq: 3, timestamp: now - 3400000, type: "message", data: { role: "assistant", content: "Analyzing repository structure..." } },
  { jobId: "job_01HXYZ123456", seq: 4, timestamp: now - 3300000, type: "tool_request", data: { tool: "read_file", args: { path: "src/main.ts" } } },
  { jobId: "job_01HXYZ123456", seq: 5, timestamp: now - 3250000, type: "tool_response", data: { tool: "read_file", result: "..." } },
  { jobId: "job_01HXYZ123456", seq: 6, timestamp: now - 3200000, type: "message", data: { role: "assistant", content: "Found the issue in the configuration." } },
  { jobId: "job_01HXYZ123456", seq: 7, timestamp: now - 3100000, type: "tool_request", data: { tool: "edit_file", args: { path: "src/config.ts" } } },
  { jobId: "job_01HXYZ123456", seq: 8, timestamp: now - 3000000, type: "tool_response", data: { tool: "edit_file", result: "File edited successfully" } },
  { jobId: "job_01HXYZ123456", seq: 9, timestamp: now - 2000000, type: "usage", data: { inputTokens: 15200, outputTokens: 8400 } },
];

const mockTemplates: AutomationTemplate[] = [
  { templateId: "tmpl_01HXYZAAAA", name: "Deploy to Staging", description: "Automated deployment pipeline for staging environment with approval gate", status: "active", createdAt: now - 604800000, createdBy: "user_admin", archivedAt: null, tenantId: "t_1", orgId: "org_1", projectId: "proj_abc" },
  { templateId: "tmpl_01HXYZBBBB", name: "PR Review Automation", description: "Automated code review with AI-powered suggestions and approval workflow", status: "active", createdAt: now - 2592000000, createdBy: "user_admin", archivedAt: null, tenantId: "t_1", orgId: "org_1", projectId: "proj_abc" },
  { templateId: "tmpl_01HXYZCCCC", name: "E2E Test Suite", description: "End-to-end integration testing with artifact collection and delivery", status: "active", createdAt: now - 1296000000, createdBy: "user_dev", archivedAt: null, tenantId: "t_1", orgId: "org_1", projectId: "proj_abc" },
];

const mockVersions: AutomationVersion[] = [
  {
    versionId: "ver_01", templateId: "tmpl_01HXYZAAAA", version: 3, status: "active",
    definition: {
      steps: [
        { stepId: "step_1", type: "validate", config: { checks: ["lint", "typecheck"] } },
        { stepId: "step_2", type: "build", dependsOn: ["step_1"], config: { command: "npm run build" } },
        { stepId: "step_3", type: "deploy", dependsOn: ["step_2"], config: { target: "staging" } },
      ],
      artifacts: [{ type: "build_output", name: "dist", stepId: "step_2" }],
      approval: { required: true, minApproverRole: "developer" },
      delivery: { type: "webhook", config: { url: "https://hooks.slack.com/deploy" } },
    },
    inputContract: {
      fields: [
        { fieldId: "branch", type: "string", required: true, description: "Git branch to deploy" },
        { fieldId: "skip_tests", type: "boolean", required: false, description: "Skip test suite" },
        { fieldId: "environment", type: "enum", required: true, description: "Target environment", enum: ["staging", "preview"] },
      ],
    },
    checksum: "sha256:abc123def456", createdAt: now - 86400000, createdBy: "user_admin", tenantId: "t_1", orgId: "org_1", projectId: "proj_abc",
  },
  {
    versionId: "ver_02", templateId: "tmpl_01HXYZAAAA", version: 2, status: "archived",
    definition: {
      steps: [{ stepId: "step_1", type: "deploy", config: { target: "staging" } }],
      artifacts: [], approval: { required: false }, delivery: { type: "none" },
    },
    inputContract: { fields: [{ fieldId: "branch", type: "string", required: true, description: "Git branch" }] },
    checksum: "sha256:old123", createdAt: now - 604800000, createdBy: "user_admin", tenantId: "t_1", orgId: "org_1", projectId: "proj_abc",
  },
];

const mockRuns: AutomationRun[] = [
  { runId: "run_01HXYZ111", templateId: "tmpl_01HXYZAAAA", versionId: "ver_01", version: 3, status: "running", inputRevisionId: "inp_1", runVersion: 2, createdBy: "user_admin", error: null, createdAt: now - 1200000, updatedAt: now - 60000, suspendedAt: null, completedAt: null, tenantId: "t_1", orgId: "org_1", projectId: "proj_abc" },
  { runId: "run_01HXYZ222", templateId: "tmpl_01HXYZBBBB", versionId: "ver_03", version: 7, status: "awaiting_approval", inputRevisionId: "inp_2", runVersion: 1, createdBy: "user_dev", error: null, createdAt: now - 3600000, updatedAt: now - 1800000, suspendedAt: null, completedAt: null, tenantId: "t_1", orgId: "org_1", projectId: "proj_abc" },
  { runId: "run_01HXYZ333", templateId: "tmpl_01HXYZAAAA", versionId: "ver_01", version: 3, status: "completed", inputRevisionId: "inp_3", runVersion: 5, createdBy: "user_admin", error: null, createdAt: now - 86400000, updatedAt: now - 86000000, suspendedAt: null, completedAt: now - 86000000, tenantId: "t_1", orgId: "org_1", projectId: "proj_abc" },
  { runId: "run_01HXYZ444", templateId: "tmpl_01HXYZCCCC", versionId: "ver_04", version: 5, status: "failed", inputRevisionId: "inp_4", runVersion: 3, createdBy: "user_dev", error: "Step 'run_tests' failed: connection timeout", createdAt: now - 172800000, updatedAt: now - 172700000, suspendedAt: null, completedAt: null, tenantId: "t_1", orgId: "org_1", projectId: "proj_abc" },
];

const mockRunEvents: AutomationEvent[] = [
  { runId: "run_01HXYZ111", seq: 1, timestamp: now - 1200000, type: "created", data: { templateId: "tmpl_01HXYZAAAA" } },
  { runId: "run_01HXYZ111", seq: 2, timestamp: now - 1190000, type: "validating_input", data: { fields: ["branch", "environment"] } },
  { runId: "run_01HXYZ111", seq: 3, timestamp: now - 1180000, type: "admitted", data: { reservationId: "res_1" } },
  { runId: "run_01HXYZ111", seq: 4, timestamp: now - 1100000, type: "step_started", data: { stepId: "step_1", name: "validate" } },
  { runId: "run_01HXYZ111", seq: 5, timestamp: now - 1000000, type: "step_completed", data: { stepId: "step_1", duration: 100000 } },
  { runId: "run_01HXYZ111", seq: 6, timestamp: now - 900000, type: "step_started", data: { stepId: "step_2", name: "build" } },
  { runId: "run_01HXYZ111", seq: 7, timestamp: now - 600000, type: "step_completed", data: { stepId: "step_2", duration: 300000 } },
  { runId: "run_01HXYZ111", seq: 8, timestamp: now - 300000, type: "step_started", data: { stepId: "step_3", name: "deploy" } },
];

const mockArtifacts: AutomationArtifact[] = [
  { artifactId: "art_001", runId: "run_01HXYZ111", versionId: "ver_01", stepId: "step_2", type: "build_output", name: "dist.zip", contentRef: "opaque_ref_1", checksum: "sha256:art1", size: 2048000, createdAt: now - 600000, metadata: {} },
  { artifactId: "art_002", runId: "run_01HXYZ111", versionId: "ver_01", stepId: "step_1", type: "lint_report", name: "lint.json", contentRef: "opaque_ref_2", checksum: "sha256:art2", size: 12400, createdAt: now - 1000000, metadata: {} },
];

const mockApprovals: ApprovalRequest[] = [
  { approvalId: "apr_01HXYZ111", runId: "run_01HXYZ222", versionId: "ver_03", gateId: "gate_1", status: "pending", minApproverRole: "developer", contextArtifacts: ["art_001", "art_002"], createdAt: now - 1800000, expiresAt: now + 14400000, decisionActor: null, decisionTime: null, decisionMetadata: null, approvalVersion: 1 },
];

const mockDeliveries: SanitizedDelivery[] = [
  { deliveryId: "dlv_001", runId: "run_01HXYZ333", status: "delivered", attempts: 1, resultRef: "ref_delivered", updatedAt: now - 85000000, lastError: null, destination: "https://hooks.sla.../DEP" },
];

const mockSchedules: ScheduleView[] = [
  { scheduleId: "sch_01HXYZ111", tenantId: "t_1", orgId: "org_1", projectId: "proj_abc", name: "Nightly Build", state: "active", version: 5, lastAdmittedAt: now - 86400000, createdAt: now - 604800000, updatedAt: now - 86400000, currentVersion: { kind: "recurring", cron: "0 2 * * *", scheduledAt: null, timezone: "UTC", automationVersionId: "ver_01", missedRunPolicy: "skip", maxCatchUp: 1, input: {}, checksum: "sc_1" } },
  { scheduleId: "sch_01HXYZ222", tenantId: "t_1", orgId: "org_1", projectId: "proj_abc", name: "Weekly Security Scan", state: "active", version: 3, lastAdmittedAt: now - 2592000000, createdAt: now - 1209600000, updatedAt: now - 1209600000, currentVersion: { kind: "recurring", cron: "0 6 * * 1", scheduledAt: null, timezone: "America/New_York", automationVersionId: "ver_04", missedRunPolicy: "catch_up", maxCatchUp: 3, input: {}, checksum: "sc_2" } },
  { scheduleId: "sch_01HXYZ333", tenantId: "t_1", orgId: "org_1", projectId: "proj_abc", name: "Data Sync", state: "paused", version: 2, lastAdmittedAt: now - 86400000, createdAt: now - 2592000000, updatedAt: now - 604800000, currentVersion: { kind: "recurring", cron: "*/30 * * * *", scheduledAt: null, timezone: "UTC", automationVersionId: "ver_03", missedRunPolicy: "skip", maxCatchUp: 1, input: {}, checksum: "sc_3" } },
];

const mockConnections: ConnectionView[] = [
  { connectionId: "conn_01HXYZ111", tenantId: "t_1", orgId: "org_1", projectId: "proj_abc", family: "git", provider: "github", account: { externalId: "gh_123", displayName: "Vaulltcore Org" }, capabilities: [{ name: "repos", description: "Repository access" }, { name: "prs", description: "Pull requests" }], state: "active", version: 2, lastUsedAt: now - 3600000, expiresAt: now + 2592000000, createdAt: now - 604800000, updatedAt: now - 3600000 },
  { connectionId: "conn_01HXYZ222", tenantId: "t_1", orgId: "org_1", projectId: "proj_abc", family: "messaging", provider: "slack", account: { externalId: "sl_456", displayName: "#deploys" }, capabilities: [{ name: "webhooks", description: "Send messages" }], state: "active", version: 1, lastUsedAt: now - 86400000, expiresAt: null, createdAt: now - 1296000000, updatedAt: now - 86400000 },
  { connectionId: "conn_01HXYZ333", tenantId: "t_1", orgId: "org_1", projectId: "proj_abc", family: "model", provider: "openai", account: { externalId: "oai_789", displayName: "OpenAI BYOK" }, capabilities: [{ name: "completions", description: "Chat completions" }], state: "active", version: 3, lastUsedAt: now - 120000, expiresAt: null, createdAt: now - 2592000000, updatedAt: now - 120000 },
  { connectionId: "conn_01HXYZ444", tenantId: "t_1", orgId: "org_1", projectId: "proj_abc", family: "pm", provider: "linear", account: { externalId: "ln_abc", displayName: "Linear Workspace" }, capabilities: [{ name: "issues", description: "Issue tracking" }], state: "expired", version: 1, lastUsedAt: now - 604800000, expiresAt: now - 86400000, createdAt: now - 3888000000, updatedAt: now - 604800000 },
];

const mockTriggers: TriggerView[] = [
  { triggerId: "trg_01HXYZ111", templateId: "tmpl_01HXYZBBBB", versionId: "ver_03", triggerClass: "webhook_event", name: "GitHub PR Webhook", criteria: { eventKinds: ["pull_request.opened", "pull_request.synchronize"], resourcePattern: "vaulltcore/*" }, scheduleId: null, inputMapping: {}, state: "enabled", revision: 4, createdAt: now - 604800000, createdBy: "user_admin", updatedAt: now - 86400000 },
  { triggerId: "trg_01HXYZ222", templateId: "tmpl_01HXYZAAAA", versionId: "ver_01", triggerClass: "manual", name: "Manual Deploy Trigger", criteria: null, scheduleId: null, inputMapping: {}, state: "enabled", revision: 1, createdAt: now - 2592000000, createdBy: "user_admin", updatedAt: now - 2592000000 },
  { triggerId: "trg_01HXYZ333", templateId: "tmpl_01HXYZCCCC", versionId: "ver_04", triggerClass: "integration_event", name: "Linear Issue Update", criteria: { eventKinds: ["issue.updated"], connectionId: "conn_01HXYZ444" }, scheduleId: null, inputMapping: {}, state: "disabled", revision: 2, createdAt: now - 1296000000, createdBy: "user_dev", updatedAt: now - 604800000 },
];

const mockUsageEvents: UsageEventLite[] = [
  { eventId: "evt_001", kind: "model_tokens", quantity: 15200, unit: "tokens", provider: "anthropic", model: "claude-sonnet-4-20250514", jobId: "job_01HXYZ123", recordedAt: now - 300000 },
  { eventId: "evt_002", kind: "model_tokens", quantity: 8400, unit: "tokens", provider: "anthropic", model: "claude-sonnet-4-20250514", jobId: "job_01HXYZ123", recordedAt: now - 300000 },
  { eventId: "evt_003", kind: "tool_call", quantity: 4, unit: null, provider: "anthropic", model: "claude-sonnet-4-20250514", jobId: "job_01HXYZ123", recordedAt: now - 300000 },
  { eventId: "evt_004", kind: "execution_duration", quantity: 42000, unit: "ms", provider: "anthropic", model: "claude-sonnet-4-20250514", jobId: "job_01HXYZ123", recordedAt: now - 300000 },
  { eventId: "evt_005", kind: "model_tokens", quantity: 42100, unit: "tokens", provider: "openai", model: "gpt-4o", jobId: "job_01HXYZ124", recordedAt: now - 3600000 },
  { eventId: "evt_006", kind: "model_tokens", quantity: 21300, unit: "tokens", provider: "openai", model: "gpt-4o", jobId: "job_01HXYZ124", recordedAt: now - 3600000 },
  { eventId: "evt_007", kind: "tool_call", quantity: 12, unit: null, provider: "openai", model: "gpt-4o", jobId: "job_01HXYZ124", recordedAt: now - 3600000 },
  { eventId: "evt_008", kind: "execution_duration", quantity: 128000, unit: "ms", provider: "openai", model: "gpt-4o", jobId: "job_01HXYZ124", recordedAt: now - 3600000 },
];

// --- Mock Repository Implementations ---

export const mockRepositories: AppRepositories = {
  jobs: {
    async list() { return mockJobs; },
    async get(jobId) { return mockJobs.find(j => j.id === jobId) || mockJobs[0]; },
    async events(jobId) { return mockJobEvents.filter(e => e.jobId === jobId); },
    async cancel() { return { status: "cancelled" }; },
    async input() { return { status: "accepted" }; },
    async usage(jobId) { return { jobId, usage: { inputTokens: 15200, outputTokens: 8400, reasoningTokens: 2100, totalTokens: 25700 } }; },
  },

  automation: {
    templates: {
      async list() { return { templates: mockTemplates }; },
      async create(body) { return { templateId: `tmpl_${crypto.randomUUID().slice(0, 8)}`, name: body.name, description: body.description || null, status: "active", createdAt: now, createdBy: "dev-user", archivedAt: null, tenantId: "t_1", orgId: "org_1", projectId: "proj_abc" }; },
      async versions(templateId) { return { versions: mockVersions.filter(v => v.templateId === templateId) }; },
      async createVersion(templateId, body) { return { versionId: `ver_${crypto.randomUUID().slice(0, 8)}`, templateId, version: 1, status: "active", definition: body.definition, inputContract: body.inputContract, checksum: `sha256:${crypto.randomUUID().slice(0, 12)}`, createdAt: now, createdBy: "dev-user", tenantId: "t_1", orgId: "org_1", projectId: "proj_abc" }; },
    },
    runs: {
      async list() { return mockRuns; },
      async get(runId) { return mockRuns.find(r => r.runId === runId) || mockRuns[0]; },
      async events(runId) { return { events: mockRunEvents.filter(e => e.runId === runId) }; },
      async artifacts(runId) { return { artifacts: mockArtifacts.filter(a => a.runId === runId) }; },
      async deliveries(runId) { return { deliveries: mockDeliveries.filter(d => d.runId === runId) }; },
      async advance(runId) { return mockRuns.find(r => r.runId === runId) || mockRuns[0]; },
      async cancel(runId) { const run = mockRuns.find(r => r.runId === runId) || mockRuns[0]; return { ...run, status: "cancelled" as const }; },
    },
    approvals: {
      async approve(id) { const approval = mockApprovals.find(a => a.approvalId === id) || mockApprovals[0]; return { approval: { ...approval, status: "approved" as const }, run: mockRuns[0] }; },
      async reject(id) { const approval = mockApprovals.find(a => a.approvalId === id) || mockApprovals[0]; return { approval: { ...approval, status: "rejected" as const }, run: mockRuns[0] }; },
      async requestChanges(id) { const approval = mockApprovals.find(a => a.approvalId === id) || mockApprovals[0]; return { approval: { ...approval, status: "changes_requested" as const }, run: mockRuns[0] }; },
    },
  },

  schedules: {
    async list() { return { schedules: mockSchedules }; },
    async get(scheduleId) { return mockSchedules.find(s => s.scheduleId === scheduleId) || mockSchedules[0]; },
    async create() { return mockSchedules[0]; },
    async pause(scheduleId) { const s = mockSchedules.find(s => s.scheduleId === scheduleId) || mockSchedules[0]; return { ...s, state: "paused" as const }; },
    async resume(scheduleId) { const s = mockSchedules.find(s => s.scheduleId === scheduleId) || mockSchedules[0]; return { ...s, state: "active" as const }; },
    async cancel(scheduleId) { const s = mockSchedules.find(s => s.scheduleId === scheduleId) || mockSchedules[0]; return { ...s, state: "cancelled" as const }; },
    async occurrences(scheduleId) { return { occurrences: [{ occurrenceId: `occ:${scheduleId}:1`, scheduleId, version: 5, scheduledTime: now + 86400000, admittedRunId: null, admittedAt: null }] }; },
  },

  connections: {
    async capabilities() { return { capabilities: [{ name: "github", family: "git", description: "GitHub repositories and pull requests" }, { name: "slack", family: "messaging", description: "Slack notifications and channels" }, { name: "linear", family: "pm", description: "Linear issue tracking" }, { name: "openai", family: "model", description: "OpenAI API access" }, { name: "anthropic", family: "model", description: "Anthropic API access" }] }; },
    async list() { return { connections: mockConnections }; },
    async get(connectionId) { return mockConnections.find(c => c.connectionId === connectionId) || mockConnections[0]; },
    async create() { return { attemptId: "att_1", state: "st_1", authorizeUrl: "https://github.com/login/oauth/authorize?client_id=...", codeChallenge: "cc_1" }; },
    async reconnect() { return { attemptId: "att_2", state: "st_2", authorizeUrl: "https://github.com/login/oauth/authorize?client_id=..." }; },
    async refresh(connectionId) { const c = mockConnections.find(c => c.connectionId === connectionId) || mockConnections[0]; return { ...c, state: "active" as const, version: c.version + 1 }; },
    async disconnect(connectionId) { const c = mockConnections.find(c => c.connectionId === connectionId) || mockConnections[0]; return { ...c, state: "disconnected" as const }; },
  },

  triggers: {
    async list() { return { triggers: mockTriggers }; },
    async get(triggerId) { return mockTriggers.find(t => t.triggerId === triggerId) || mockTriggers[0]; },
    async create(body: Record<string, unknown>) { return { triggerId: `trg_${crypto.randomUUID().slice(0, 8)}`, templateId: String(body.templateId || ""), versionId: String(body.versionId || ""), triggerClass: (body.triggerClass as TriggerView["triggerClass"]) || "manual", name: String(body.name || "New Trigger"), criteria: null, scheduleId: null, inputMapping: {}, state: "enabled" as const, revision: 1, createdAt: now, createdBy: "dev-user", updatedAt: now }; },
    async enable(triggerId) { const t = mockTriggers.find(t => t.triggerId === triggerId) || mockTriggers[0]; return { ...t, state: "enabled" as const }; },
    async disable(triggerId) { const t = mockTriggers.find(t => t.triggerId === triggerId) || mockTriggers[0]; return { ...t, state: "disabled" as const }; },
    async invoke() { return { dispatches: [], runIds: ["run_new_1"] }; },
    async dispatch() { return { dispatchId: "dsp_1", triggerId: "", triggerRevision: 1, sourceEventId: "", state: "completed", attempts: 1, lastError: null, createdAt: now }; },
  },

  usage: {
    async list(params) {
      const items = mockUsageEvents.slice(0, params?.limit ?? 200);
      return { items, nextCursor: null, hasMore: false };
    },
    async summary() {
      return { totalTokens: 2847500, totalRequests: 312, totalDurationMs: 45600000, byProvider: { openai: { tokens: 1420000, requests: 156 }, anthropic: { tokens: 1427500, requests: 156 } }, byModel: { "gpt-4o": { tokens: 1200000, requests: 100 }, "claude-sonnet-4-20250514": { tokens: 1100000, requests: 112 }, "claude-3-haiku": { tokens: 547500, requests: 100 } }, byKind: {}, period: { from: now - 2592000000, to: now } };
    },
    async run() { return { jobId: null, inputTokens: 15200, outputTokens: 8400, reasoningTokens: 2100, totalTokens: 25700, steps: 5, toolCalls: 12, durationMs: 42000 }; },
    async ledger(params) { return this.list(params); },
  },

  operations: {
    async retryStatus() { return { items: [{ workId: "ops_001", kind: "delivery_retry", state: "pending", attempts: 2, nextRetryAt: now + 300000, lastError: "Provider returned 503" }] }; },
    async health() { return { health: { unresolvedUsage: 0, unresolvedPricing: 2, orphanedReservations: 0, settlementBacklog: 1, snapshotGcBacklog: 0, lastWatermark: now - 120000 }, tenantId: "t_1" }; },
    async deadLetter() { return { items: [], deadLetter: [{ workId: "ops_003", kind: "delivery_retry", state: "dead_letter", attempts: 5, lastError: "Endpoint unreachable after 5 attempts" }], dispatchDeadLetter: [] }; },
    async redrive() { return {}; },
    async dispatchRedrive() { return {}; },
    async reconcile() { return { scanned: 150, repaired: 3, gaps: ["usage_event_missing_job"] }; },
    async timeoutScan() { return { scanned: 42, timedOut: 1 }; },
    async readiness() { return { ready: true, checks: { store: true, runner: true, scheduler: true } }; },
  },

  metrics: {
    async get() { return { totalRuns: 127, completedRuns: 98, failedRuns: 12, activeRuns: 3, successRate: 0.891, totalTemplates: 6, totalSchedules: 5, activeSchedules: 4 }; },
  },
};
