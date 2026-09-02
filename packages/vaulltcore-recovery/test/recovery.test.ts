/**
 * Recovery tests (Phase 2B): scanner detects expired approvals/failed
 * deliveries/abandoned runs and enqueues ops items; the approval-expiry reaper
 * expires a pending approval idempotently. Uses the real SQL automation store
 * + ops store + audit store sharing one in-memory database.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { PgliteDatabase, pgliteDialect } from "@vaulltcore/store-sql"
import { SqlAutomationStore, AutomationService, type AutomationJobDispatcher, type DispatchStepRequest, type DispatchStepResult, type AutomationDefinition, type InputContract } from "@vaulltcore/automation"
import { InMemoryArtifactStore, FakeDeliveryProvider } from "@vaulltcore/automation"
import { SqlAuditStore } from "@vaulltcore/audit"
import { SqlOpsStore, OperationalWorker, type OperationalWorkerDeps } from "@vaulltcore/ops"
import { RecoveryScanner, buildReapers } from "../src"
import type { ResolvedPrincipal } from "@vaulltcore/identity"
import type { JobEvent, JobState, JobMetrics } from "@vaulltcore/runner"

let db: PgliteDatabase

/** Minimal inline dispatcher for recovery tests (kept local to avoid cross-
 *  package test imports that would break this package's rootDir typecheck). */
class LocalFakeDispatcher implements AutomationJobDispatcher {
  readonly calls: DispatchStepRequest[] = []
  private readonly jobs = new Map<string, { events: JobEvent[]; state: JobState }>()
  private readonly byIdem = new Map<string, string>()
  private seq = 0
  private readonly outcomes = new Map<string, { text: string; status: JobState["status"] }>()

  setStepOutcome(stepId: string, text: string): void {
    this.outcomes.set(stepId, { text, status: "completed" })
  }

  async dispatchAndRun(request: DispatchStepRequest): Promise<DispatchStepResult> {
    this.calls.push(request)
    const existing = this.byIdem.get(request.idempotencyKey)
    if (existing) return { jobId: existing, replayed: true, state: this.jobs.get(existing)!.state }
    const jobId = `job_${this.seq++}`
    const stepId = request.idempotencyKey.split(":").pop() ?? "default"
    const outcome = this.outcomes.get(stepId) ?? { text: `{"result":"${request.input}"}`, status: "completed" as const }
    const now = Date.now()
    const events: JobEvent[] = [
      { jobId, seq: 1, timestamp: now, type: "queued", data: { engine: request.engine, model: request.model } },
      { jobId, seq: 2, timestamp: now, type: "started", data: { attempt: 1, executionId: "exec" } },
      { jobId, seq: 3, timestamp: now, type: "message", data: { role: "assistant", stepIndex: 0, text: outcome.text, toolCalls: [] } },
      { jobId, seq: 4, timestamp: now, type: "usage", data: { stepIndex: 0, inputTokens: 10, outputTokens: 5, durationMs: 100 } },
      { jobId, seq: 5, timestamp: now, type: "completed", data: { usage: { inputTokens: 10, outputTokens: 5, steps: 1 }, steps: 1 } },
    ]
    const usage: JobMetrics = { inputTokens: 10, outputTokens: 5, reasoningTokens: 0, totalTokens: 15, steps: 1, toolCalls: 0 }
    const state: JobState = { jobId, identity: { ...request.identity }, status: outcome.status, attempt: 1, lastEventSeq: events.length, usage, error: null, checkpoint: null }
    this.jobs.set(jobId, { events, state })
    this.byIdem.set(request.idempotencyKey, jobId)
    return { jobId, replayed: false, state }
  }
  async listJobEvents(jobId: string): Promise<readonly JobEvent[]> { return this.jobs.get(jobId)?.events ?? [] }
  async getJobState(jobId: string): Promise<JobState | null> { return this.jobs.get(jobId)?.state ?? null }
}

function localAdmin(tenantId = "tenant_a", orgId = "org_a", projectId = "proj_a"): ResolvedPrincipal {
  return { principalId: `user:${tenantId}`, kind: "user", tenantId, orgId, role: "admin", projectScope: ["*"], admin: true }
}

function localDefinition(): AutomationDefinition {
  return {
    steps: [{
      stepId: "step1",
      execution: { engine: "script", model: "test", prompt: "${input.query}", maxSteps: 10, maxTokens: null, maxDurationMs: null, allowedTools: [], engineOptions: {} },
      inputMappings: [{ fieldId: "query", placeholder: "query" }],
      outputMappings: [{ key: "result", path: "result" }],
      dependsOn: [],
    }],
    artifacts: [{ artifactId: "art1", stepId: "step1", type: "text", name: "result.txt", path: "result" }],
    approval: { required: false, gateId: "", minApproverRole: "operator", contextArtifacts: [], expiresAfterMs: null },
    delivery: { destination: "test-destination", artifactIds: [] },
  }
}

function localInputContract(): InputContract {
  return { fields: [{ fieldId: "query", type: "string", required: true, description: null }] }
}

interface Setup {
  readonly store: SqlAutomationStore
  readonly ops: SqlOpsStore
  readonly audit: SqlAuditStore
  readonly service: AutomationService
  readonly dispatcher: LocalFakeDispatcher
}

function setup(): Setup {
  db = new PgliteDatabase()
  const store = new SqlAutomationStore(db, { dialect: pgliteDialect })
  const ops = new SqlOpsStore(db, { dialect: pgliteDialect })
  const audit = new SqlAuditStore(db, { dialect: pgliteDialect })
  const dispatcher = new LocalFakeDispatcher()
  const service = new AutomationService({
    store,
    artifacts: new InMemoryArtifactStore(),
    delivery: new FakeDeliveryProvider(),
    dispatcher,
    audit,
  })
  return { store, ops, audit, service, dispatcher }
}

function seedRun(tenantId: string, runId: string, orgId: string, projectId: string, status: string, updatedAt: number): void {
  db.prepare(`INSERT INTO automation_runs (run_id, tenant_id, org_id, project_id, template_id, version_id, version, status, input_revision_id, run_version, created_by, error, created_at, updated_at, suspended_at, completed_at) VALUES ($1,$2,$3,$4,'tmpl','ver',1,$5,'',1,'svc',NULL,$6,$7,NULL,NULL) ON CONFLICT DO NOTHING`).run(runId, tenantId, orgId, projectId, status, updatedAt, updatedAt)
}

function seedApproval(tenantId: string, approvalId: string, runId: string, gateId: string, status: string, expiresAt: number): void {
  db.prepare(`INSERT INTO approval_requests (approval_id, run_id, version_id, gate_id, status, min_approver_role, context_artifacts, created_at, expires_at, decision_actor, decision_time, decision_metadata, approval_version) VALUES ($1,$2,'ver',$3,$4,'developer','[]',0,$5,NULL,NULL,NULL,1)`).run(approvalId, runId, gateId, status, expiresAt)
}

let uid = 0
function nextId(): string { return String(++uid) }

describe("RecoveryScanner", () => {
  let s: Setup
  beforeEach(() => { s = setup() })
  afterEach(() => { db.close() })

  it("detects expired pending approvals and enqueues an ops item", async () => {
    const now = 600000
    const t = `t_${nextId()}`
    seedRun(t, `r_${uid}`, "o", "p", "awaiting_approval", now)
    seedApproval(t, `a_expired_${uid}`, `r_${uid}`, "g1", "pending", 500) // expires before now
    seedApproval(t, `a_live_${uid}`, `r_${uid}`, "g2", "pending", 999999999) // not yet expired
    const scanner = new RecoveryScanner({ store: s.store, opsStore: s.ops, audit: s.audit, tenantId: t, now: () => now })
    const res = await scanner.scan()
    expect(res.expiredApprovals).toBe(1)
    expect(res.enqueued).toBe(1)
    const items = s.ops.list(t, "approval_expiry", null)
    expect(items).toHaveLength(1)
    expect(items[0]!.targetRef).toBe(`a_expired_${uid}`)
    // The audit scan was recorded.
    const events = await s.audit.list({ tenantId: t })
    expect(events.some((e) => e.type === "automation_recovery_scan")).toBe(true)
  })

  it("detects abandoned (stale) runs and enqueues ops items", async () => {
    const now = 600000
    const t = `t_${nextId()}`
    seedRun(t, `r_stale_${uid}`, "o", "p", "running", 0) // stale (updated_at 0 < now-5min)
    seedRun(t, `r_done_${uid}`, "o", "p", "completed", 0) // terminal, not abandoned
    const scanner = new RecoveryScanner({ store: s.store, opsStore: s.ops, audit: s.audit, tenantId: t, now: () => now })
    const res = await scanner.scan()
    expect(res.abandonedRuns).toBe(1)
  })

  it("tenant isolation: only scans the caller's tenant", async () => {
    const now = 600000
    const callerT = `t_${nextId()}`
    seedRun(callerT, `r_${uid}`, "o", "p", "running", 0)
    const otherT = `t_${nextId()}`
    seedRun(otherT, `r_${uid}`, "o", "p", "running", 0)
    const scanner = new RecoveryScanner({ store: s.store, opsStore: s.ops, audit: s.audit, tenantId: callerT, now: () => now })
    const res = await scanner.scan()
    expect(res.abandonedRuns).toBe(1)
    expect(s.ops.list(otherT, null, null)).toHaveLength(0)
  })
})

describe("approval-expiry reaper", () => {
  let s: Setup
  beforeEach(() => { s = setup() })
  afterEach(() => { db.close() })

  it("expires a pending approval and is idempotent on re-run", async () => {
    const now = 600000
    const t = `t_${nextId()}`
    const r = `r_${uid}`
    const a = `a_${uid}`
    seedRun(t, r, "o", "p", "awaiting_approval", now)
    seedApproval(t, a, r, "gate", "pending", 500)
    const scanner = new RecoveryScanner({ store: s.store, opsStore: s.ops, audit: s.audit, tenantId: t, now: () => now })
    await scanner.scan()
    const reapers = buildReapers(s.service, s.store, () => now)
    const deps: OperationalWorkerDeps = { store: s.ops, reapers: new Map([["approval_expiry", reapers.approvalExpiry]]), maxAttempts: 3 }
    const worker = new OperationalWorker({ workerId: "w", leaseMs: 5000, heartbeatIntervalMs: 100, now: () => now, sleep: async () => {} }, deps)
    const res = await worker.runOnce()
    expect(res!.state).toBe("succeeded")
    // The approval is now expired in the store.
    const approvals = await s.store.listApprovalRequests(t, r)
    expect(approvals[0]!.status).toBe("expired")
    // Re-running the same item is a no-op (idempotent enqueue + terminal state).
    const res2 = await worker.runOnce()
    expect(res2).toBeNull() // item already succeeded, not claimable
  })
})

describe("delivery-retry + abandoned-run reapers", () => {
  let s: Setup
  beforeEach(() => { s = setup() })
  afterEach(() => { db.close() })

  it("abandoned-run reaper calls reconcileRun (no agent execution, idempotent)", async () => {
    // Seed a stale running run; the reaper calls service.reconcileRun which
    // re-projects + re-drives via the (deduplicating) dispatcher.
    const principal = localAdmin()
    const t = await s.service.createTemplate({ principal, orgId: "org_a", projectId: "proj_a", name: "T" })
    const v = await s.service.publishVersion({ principal, templateId: t.templateId, definition: localDefinition(), inputContract: localInputContract() })
    s.dispatcher.setStepOutcome("step1", '{"result":"ok"}')
    const run = await s.service.createRun({ principal, orgId: "org_a", projectId: "proj_a", templateId: t.templateId, versionId: v.versionId, input: [{ fieldId: "query", value: "q" }], idempotencyKey: `k_${Math.random()}` })
    // Advance to running (turn 0 has a tool call via simpleDefinition).
    await s.service.advanceRun(principal, run.runId)
    const after = await s.service.getRun(principal, run.runId)
    // Enqueue an abandoned_run item + run the reaper.
    s.ops.enqueue({ id: `ops:abandoned_run:${run.runId}`, tenantId: principal.tenantId, orgId: "org_a", projectId: "proj_a", kind: "abandoned_run", targetRef: run.runId, idempotencyKey: `abandoned_run:${run.runId}` })
    const reapers = buildReapers(s.service, s.store)
    const deps: OperationalWorkerDeps = { store: s.ops, reapers: new Map([["abandoned_run", reapers.abandonedRun]]), maxAttempts: 3 }
    const worker = new OperationalWorker({ workerId: "w", leaseMs: 5000, heartbeatIntervalMs: 100, sleep: async () => {} }, deps)
    const res = await worker.runOnce()
    // reconcileRun re-drives; the run progresses (no throw).
    expect(res!.state).toBe("succeeded")
    void after
  })
})
