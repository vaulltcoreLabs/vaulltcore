// ============================================================================
// Mock Mode Isolation
// Typed repository interfaces + mock implementations
// Mock and real repositories implement the same interfaces
// ============================================================================

import type {
  JobView,
  JobEvent,
  AutomationTemplate,
  AutomationVersion,
  AutomationRun,
  AutomationEvent,
  AutomationArtifact,
  ApprovalRequest,
  SanitizedDelivery,
  ScheduleView,
  OccurrenceView,
  ConnectionView,
  TriggerView,
  UsageEventLite,
  UsagePage,
  UsageSummary,
  UsageAggregate,
  RetryStatusItem,
  DeadLetterItem,
  ReliabilityHealthReport,
  ReadinessReport,
  ReconciliationResult,
  TimeoutScanResult,
  AutomationMetrics,
  TriggerDispatch,
} from "@/types";

// --- Repository Interfaces ---

export interface JobRepository {
  list(): Promise<JobView[]>;
  get(jobId: string): Promise<JobView>;
  events(jobId: string, opts?: { after?: number; follow?: boolean }): Promise<JobEvent[]>;
  cancel(jobId: string): Promise<{ status: string }>;
  input(jobId: string, text: string): Promise<{ status: string }>;
  usage(jobId: string): Promise<{ jobId: string; usage: Record<string, number> }>;
}

export interface AutomationRepository {
  templates: {
    list(): Promise<{ templates: AutomationTemplate[] }>;
    create(body: { name: string; description?: string }): Promise<AutomationTemplate>;
    versions(templateId: string): Promise<{ versions: AutomationVersion[] }>;
    createVersion(
      templateId: string,
      body: { definition: AutomationVersion["definition"]; inputContract: AutomationVersion["inputContract"] }
    ): Promise<AutomationVersion>;
  };
  runs: {
    list(): Promise<AutomationRun[]>;
    get(runId: string): Promise<AutomationRun>;
    events(runId: string, opts?: { after?: number }): Promise<{ events: AutomationEvent[] }>;
    artifacts(runId: string): Promise<{ artifacts: AutomationArtifact[] }>;
    deliveries(runId: string): Promise<{ deliveries: SanitizedDelivery[] }>;
    advance(runId: string): Promise<AutomationRun>;
    cancel(runId: string): Promise<AutomationRun>;
  };
  approvals: {
    approve(id: string, metadata?: Record<string, unknown>): Promise<{ approval: ApprovalRequest; run: AutomationRun }>;
    reject(id: string, metadata?: Record<string, unknown>): Promise<{ approval: ApprovalRequest; run: AutomationRun }>;
    requestChanges(id: string, metadata?: Record<string, unknown>): Promise<{ approval: ApprovalRequest; run: AutomationRun }>;
  };
}

export interface ScheduleRepository {
  list(): Promise<{ schedules: ScheduleView[] }>;
  get(scheduleId: string): Promise<ScheduleView>;
  create(body: Record<string, unknown>): Promise<ScheduleView>;
  pause(scheduleId: string): Promise<ScheduleView>;
  resume(scheduleId: string): Promise<ScheduleView>;
  cancel(scheduleId: string): Promise<ScheduleView>;
  occurrences(scheduleId: string): Promise<{ occurrences: OccurrenceView[] }>;
}

export interface ConnectionRepository {
  capabilities(): Promise<{ capabilities: Array<{ name: string; family: string; description: string | null }> }>;
  list(): Promise<{ connections: ConnectionView[] }>;
  get(connectionId: string): Promise<ConnectionView>;
  create(body: { provider: string; redirectUri: string }): Promise<{ attemptId: string; state: string; authorizeUrl: string; codeChallenge: string }>;
  reconnect(connectionId: string): Promise<{ attemptId: string; state: string; authorizeUrl: string }>;
  refresh(connectionId: string): Promise<ConnectionView>;
  disconnect(connectionId: string): Promise<ConnectionView>;
}

export interface TriggerRepository {
  list(): Promise<{ triggers: TriggerView[] }>;
  get(triggerId: string): Promise<TriggerView>;
  create(body: Record<string, unknown>): Promise<TriggerView>;
  enable(triggerId: string): Promise<TriggerView>;
  disable(triggerId: string): Promise<TriggerView>;
  invoke(triggerId: string): Promise<{ dispatches: TriggerDispatch[]; runIds: string[] }>;
  dispatch(dispatchId: string): Promise<TriggerDispatch>;
}

export interface UsageRepository {
  list(params?: {
    cursor?: string;
    limit?: number;
    from?: number;
    to?: number;
    kind?: string;
    provider?: string;
    model?: string;
    runId?: string;
  }): Promise<UsagePage>;
  summary(params?: { from?: number; to?: number }): Promise<UsageSummary>;
  run(runId: string): Promise<UsageAggregate>;
  ledger(params?: { cursor?: string; limit?: number }): Promise<UsagePage>;
}

export interface OperationsRepository {
  retryStatus(): Promise<{ items: RetryStatusItem[] }>;
  health(): Promise<ReliabilityHealthReport>;
  deadLetter(): Promise<{ items: RetryStatusItem[]; deadLetter: DeadLetterItem[]; dispatchDeadLetter: DeadLetterItem[] }>;
  redrive(id: string): Promise<unknown>;
  dispatchRedrive(id: string): Promise<unknown>;
  reconcile(): Promise<ReconciliationResult>;
  timeoutScan(): Promise<TimeoutScanResult>;
  readiness(): Promise<ReadinessReport>;
}

export interface MetricsRepository {
  get(): Promise<AutomationMetrics>;
}

export interface AppRepositories {
  jobs: JobRepository;
  automation: AutomationRepository;
  schedules: ScheduleRepository;
  connections: ConnectionRepository;
  triggers: TriggerRepository;
  usage: UsageRepository;
  operations: OperationsRepository;
  metrics: MetricsRepository;
}
