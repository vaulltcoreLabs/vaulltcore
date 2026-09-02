/**
 * Control-plane integration for the Automation Product Layer (Phase 2A).
 *
 * Implements the narrow {@link AutomationJobDispatcher} seam over the existing
 * admission pipeline + runner, and provides the product-facing HTTP operations.
 * This extends the existing control plane — it does NOT create another server.
 *
 * Routes (registered by {@link ControlPlane} when the automation layer is wired):
 *   POST   /automation/templates
 *   GET    /automation/templates
 *   POST   /automation/templates/:id/versions
 *   GET    /automation/templates/:id/versions
 *   POST   /automation/runs
 *   GET    /automation/runs/:id
 *   GET    /automation/runs/:id/events
 *   GET    /automation/runs/:id/artifacts
 *   POST   /automation/runs/:id/advance
 *   POST   /automation/runs/:id/cancel
 *   POST   /automation/approvals/:id/approve
 *   POST   /automation/approvals/:id/reject
 *   POST   /automation/approvals/:id/changes
 *
 * Preserves: authentication, tenant/project authorization, request idempotency,
 * audit, safe error semantics. Cross-tenant resources return 404 (no existence
 * leak). Tenant identity comes from the authenticated principal, never the body.
 */

import type { IncomingMessage, ServerResponse } from "node:http"
import type { AgentRunner, JobEvent, JobState } from "@vaulltcore/runner"
import type { ResolvedPrincipal, SqlIdentityStore } from "@vaulltcore/identity"
import type { SqlAuditStore } from "@vaulltcore/audit"
import {
  AutomationService,
  type AutomationJobDispatcher,
  type DispatchStepRequest,
  type DispatchStepResult,
  type AutomationServiceDeps,
  InMemoryArtifactStore,
  FakeDeliveryProvider,
  AutomationError,
  type AutomationDefinition,
  type InputContract,
} from "@vaulltcore/automation"
import { AdmissionPipeline, type AdmissionDeps, type AdmissionRequest, AdmissionError } from "./admission"
import { VaulltcoreError } from "@vaulltcore/runner"

// ---------------------------------------------------------------------------
// Dispatcher: drives Phase 1 jobs through admission + runner
// ---------------------------------------------------------------------------

/**
 * Implements {@link AutomationJobDispatcher} over the {@link AdmissionPipeline}
 * + {@link AgentRunner}. Each step becomes an admitted Phase 1 job keyed by the
 * automation-derived idempotency key (so a replay returns the original job), then
 * runs to a terminal state. Observation uses the runner's listEvents/getJobState.
 */
export class AdmissionJobDispatcher implements AutomationJobDispatcher {
  constructor(
    private readonly admission: AdmissionPipeline,
    private readonly runner: AgentRunner,
  ) {}

  async dispatchAndRun(request: DispatchStepRequest): Promise<DispatchStepResult> {
    // The admission pipeline authenticates→authorizes→policy→quota→create with
    // durable idempotency on (tenant, idempotencyKey). A replay returns the
    // original job without creating duplicate work. We synthesize a principal
    // from the step's identity (the control plane has already authenticated the
    // caller; the dispatcher operates within that tenant scope).
    const principal: ResolvedPrincipal = {
      principalId: `automation:${request.identity.tenantId}`,
      kind: "service_account",
      tenantId: request.identity.tenantId,
      orgId: request.identity.orgId,
      role: "operator",
      projectScope: ["*"],
    }
    const admissionReq: AdmissionRequest = {
      principal,
      idempotencyKey: request.idempotencyKey,
      orgId: request.identity.orgId,
      projectId: request.identity.projectId,
      spec: {
        engine: request.engine,
        model: request.model,
        input: request.input,
        ...(request.engineOptions ? { engineOptions: request.engineOptions } : {}),
      },
      requestedTools: request.allowedTools ?? [],
      ...(request.maxSteps !== null && request.maxSteps !== undefined ? { requestedMaxSteps: request.maxSteps } : {}),
      ...(request.maxDurationMs !== null && request.maxDurationMs !== undefined ? { leaseMs: request.maxDurationMs } : {}),
    }
    const result = await this.admission.admit(admissionReq)
    // Run the job to a terminal state. In a distributed deployment this would
    // dispatch to a worker; the dispatcher contract only requires the terminal
    // state, so an inline run is correct for the product-layer contract.
    const state = await this.runner.runJob(result.jobId)
    return { jobId: result.jobId, replayed: result.replayed, state }
  }

  async listJobEvents(jobId: string, afterSeq = 0): Promise<readonly JobEvent[]> {
    return this.runner.listEvents(jobId, afterSeq)
  }

  async getJobState(jobId: string): Promise<JobState | null> {
    try {
      return await this.runner.getJobState(jobId)
    } catch {
      return null
    }
  }
}

// ---------------------------------------------------------------------------
// Automation layer wiring
// ---------------------------------------------------------------------------

export interface AutomationLayerDeps {
  /** Durable automation store (SQL or memory). */
  readonly store: AutomationServiceDeps["store"]
  /** Artifact content store (defaults to in-memory). */
  readonly artifacts?: AutomationServiceDeps["artifacts"]
  /** Delivery provider (defaults to the deterministic fake). */
  readonly delivery?: AutomationServiceDeps["delivery"]
  /** Admission pipeline + runner used to drive Phase 1 jobs. */
  readonly admission: AdmissionPipeline
  readonly runner: AgentRunner
  readonly audit: SqlAuditStore
}

export interface AutomationLayer {
  readonly service: AutomationService
  readonly dispatcher: AutomationJobDispatcher
}

/** Build the automation layer from control-plane deps. */
export function buildAutomationLayer(deps: AutomationLayerDeps): AutomationLayer {
  const dispatcher = new AdmissionJobDispatcher(deps.admission, deps.runner)
  const service = new AutomationService({
    store: deps.store,
    artifacts: deps.artifacts ?? new InMemoryArtifactStore(),
    delivery: deps.delivery ?? new FakeDeliveryProvider(),
    dispatcher,
    audit: deps.audit,
  })
  return { service, dispatcher }
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

export interface AutomationRouteContext {
  readonly service: AutomationService
  /** Resolve the authenticated principal for a request. */
  resolvePrincipal(req: IncomingMessage, authn: { tenantId: string; orgId: string; projectId: string; admin?: boolean }): Promise<ResolvedPrincipal | null>
  /** JSON helper shared with the control plane. */
  json(res: ServerResponse, status: number, body: unknown): void
  /** Body reader shared with the control plane. */
  readBody(req: IncomingMessage): Promise<Record<string, unknown>>
}

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  authn: { tenantId: string; orgId: string; projectId: string; admin?: boolean },
  query: URLSearchParams,
  ctx: AutomationRouteContext,
) => Promise<void>

export interface AutomationRoute {
  readonly method: string
  readonly pattern: RegExp
  readonly keys: string[]
  readonly handler: RouteHandler
}

function route(method: string, path: string, handler: RouteHandler): AutomationRoute {
  const keys = path.split("/").filter((s) => s.startsWith(":")).map((s) => s.slice(1))
  const pattern = new RegExp(`^${path.replace(/:(\w+)/g, () => "([^/]+)")}$`)
  return { method, pattern, keys, handler }
}

async function resolveOrFail(ctx: AutomationRouteContext, req: IncomingMessage, res: ServerResponse, authn: { tenantId: string; orgId: string; projectId: string; admin?: boolean }): Promise<ResolvedPrincipal | null> {
  const principal = await ctx.resolvePrincipal(req, authn)
  if (!principal) {
    ctx.json(res, 401, { error: { code: "UNAUTHENTICATED", message: "principal could not be resolved" } })
    return null
  }
  return principal
}

export const AUTOMATION_ROUTES: AutomationRoute[] = [
  route("POST", "/automation/templates", async (req, res, _params, authn, _query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    const body = await ctx.readBody(req)
    const name = body.name
    if (typeof name !== "string" || name === "") return ctx.json(res, 400, { error: { code: "BAD_REQUEST", message: "name required" } })
    const orgId = typeof body.orgId === "string" ? body.orgId : principal.orgId
    const projectId = typeof body.projectId === "string" ? body.projectId : principal.projectScope[0] ?? "*"
    try {
      const template = await ctx.service.createTemplate({ principal, orgId, projectId, name, description: typeof body.description === "string" ? body.description : null })
      ctx.json(res, 201, template)
    } catch (error) {
      handleAutomationError(error, ctx, res)
    }
  }),
  route("GET", "/automation/templates", async (req, res, _params, authn, query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    const orgId = query.get("orgId") ?? undefined
    const projectId = query.get("projectId") ?? undefined
    const templates = await ctx.service.listTemplates(principal, orgId ?? undefined, projectId ?? undefined)
    ctx.json(res, 200, { templates })
  }),
  route("POST", "/automation/templates/:templateId/versions", async (req, res, params, authn, _query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    const body = await ctx.readBody(req)
    try {
      const version = await ctx.service.publishVersion({
        principal,
        templateId: params.templateId!,
        definition: body.definition as AutomationDefinition,
        inputContract: body.inputContract as InputContract,
      })
      ctx.json(res, 201, version)
    } catch (error) {
      handleAutomationError(error, ctx, res)
    }
  }),
  route("GET", "/automation/templates/:templateId/versions", async (req, res, params, authn, _query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    const versions = await ctx.service.listVersions(principal, params.templateId!)
    ctx.json(res, 200, { versions })
  }),
  route("POST", "/automation/runs", async (req, res, _params, authn, _query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    const key = req.headers["idempotency-key"]
    if (typeof key !== "string" || key === "") return ctx.json(res, 400, { error: { code: "BAD_REQUEST", message: "Idempotency-Key header required" } })
    const body = await ctx.readBody(req)
    const orgId = typeof body.orgId === "string" ? body.orgId : principal.orgId
    const projectId = typeof body.projectId === "string" ? body.projectId : principal.projectScope[0] ?? "*"
    try {
      const run = await ctx.service.createRun({
        principal,
        orgId,
        projectId,
        templateId: String(body.templateId ?? ""),
        versionId: String(body.versionId ?? ""),
        input: Array.isArray(body.input) ? (body.input as ReadonlyArray<{ fieldId: string; value: unknown }>) : [],
        idempotencyKey: key,
      })
      ctx.json(res, 201, run)
    } catch (error) {
      handleAutomationError(error, ctx, res)
    }
  }),
  route("GET", "/automation/runs/:runId", async (req, res, params, authn, _query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    const run = await ctx.service.getRun(principal, params.runId!)
    if (!run) return ctx.json(res, 404, { error: { code: "RUN_NOT_FOUND", message: "run not found" } })
    ctx.json(res, 200, run)
  }),
  route("GET", "/automation/runs/:runId/events", async (req, res, params, authn, query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    const after = Number(query.get("after") ?? 0)
    const events = await ctx.service.listRunEvents(principal, params.runId!, after)
    ctx.json(res, 200, { events })
  }),
  route("GET", "/automation/runs/:runId/artifacts", async (req, res, params, authn, _query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    const artifacts = await ctx.service.listRunArtifacts(principal, params.runId!)
    ctx.json(res, 200, { artifacts })
  }),
  route("POST", "/automation/runs/:runId/advance", async (req, res, params, authn, _query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    try {
      const run = await ctx.service.advanceRun(principal, params.runId!)
      ctx.json(res, 200, run)
    } catch (error) {
      handleAutomationError(error, ctx, res)
    }
  }),
  route("POST", "/automation/runs/:runId/cancel", async (req, res, params, authn, _query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    try {
      const run = await ctx.service.cancelRun(principal, params.runId!)
      ctx.json(res, 200, run)
    } catch (error) {
      handleAutomationError(error, ctx, res)
    }
  }),
  route("POST", "/automation/approvals/:approvalId/approve", async (req, res, params, authn, _query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    const body = await ctx.readBody(req)
    try {
      const result = await ctx.service.decideApproval({ principal, approvalId: params.approvalId!, decision: "approved", ...(body.metadata ? { metadata: body.metadata as Record<string, unknown> } : {}) })
      ctx.json(res, 200, result)
    } catch (error) {
      handleAutomationError(error, ctx, res)
    }
  }),
  route("POST", "/automation/approvals/:approvalId/reject", async (req, res, params, authn, _query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    const body = await ctx.readBody(req)
    try {
      const result = await ctx.service.decideApproval({ principal, approvalId: params.approvalId!, decision: "rejected", ...(body.metadata ? { metadata: body.metadata as Record<string, unknown> } : {}) })
      ctx.json(res, 200, result)
    } catch (error) {
      handleAutomationError(error, ctx, res)
    }
  }),
  route("POST", "/automation/approvals/:approvalId/changes", async (req, res, params, authn, _query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    const body = await ctx.readBody(req)
    try {
      const result = await ctx.service.decideApproval({ principal, approvalId: params.approvalId!, decision: "changes_requested", ...(body.metadata ? { metadata: body.metadata as Record<string, unknown> } : {}) })
      ctx.json(res, 200, result)
    } catch (error) {
      handleAutomationError(error, ctx, res)
    }
  }),
]

function handleAutomationError(error: unknown, ctx: AutomationRouteContext, res: ServerResponse): void {
  if (error instanceof AutomationError) {
    ctx.json(res, error.status, { error: { code: error.code, message: error.message } })
    return
  }
  if (error instanceof AdmissionError) {
    ctx.json(res, error.status, { error: { code: error.code, message: error.message } })
    return
  }
  if (error instanceof VaulltcoreError) {
    ctx.json(res, 400, { error: { code: error.code, message: error.message } })
    return
  }
  ctx.json(res, 500, { error: { code: "INTERNAL", message: error instanceof Error ? error.message : "unknown" } })
}
