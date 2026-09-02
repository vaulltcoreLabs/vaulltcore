/**
 * Thin HTTP façade over {@link AgentRunner} (Phase 1C). Every route derives
 * lifecycle behavior from the runner contract — this file contains no
 * lifecycle logic of its own. Tenant identity comes from the configured
 * {@link ControlAuthenticator}, never from the request body.
 *
 * Routes:
 *   POST /jobs
 *   GET  /jobs/:jobId
 *   GET  /jobs/:jobId/events?after=<seq>&follow=true   (SSE when follow=true)
 *   POST /jobs/:jobId/cancel
 *   POST /jobs/:jobId/input
 *   GET  /jobs/:jobId/usage
 *
 * Cross-tenant access returns 404 for every job-scoped route (no data leak).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { type AgentRunner, type CreateJobInput, type ExecutionPolicy, type JobRecord, JobNotFoundError, VaulltcoreError } from "@vaulltcore/runner"
import { type AuthnPrincipal, type ControlAuthenticator, HeaderAuthenticator } from "./auth"
import { type IdempotencyRegistry, InMemoryIdempotencyRegistry, requestHashFor } from "./idempotency"
import { AdmissionPipeline, type AdmissionDeps, type AdmissionRequest, AdmissionError, InMemoryAdmissionIdempotencyRegistry } from "./admission"
import type { SqlIdentityStore, ResolvedPrincipal } from "@vaulltcore/identity"
import type { SqlPolicyStore } from "@vaulltcore/policy"
import type { SqlQuotaStore } from "@vaulltcore/quota"
import type { SqlMeteringStore } from "@vaulltcore/metering"
import type { SqlBillingStore } from "@vaulltcore/billing"
import type { SqlAuditStore } from "@vaulltcore/audit"
import { ReconciliationService, type JobIndex, type ReconciliationDeps } from "@vaulltcore/reconcile"
import type { SnapshotGcDriver } from "@vaulltcore/store-sql"
import { AUTOMATION_ROUTES, type AutomationLayer, type AutomationRouteContext, buildAutomationLayer } from "./automation-routes"
import { PHASE2B_ROUTES, type Phase2bRouteContext, type Phase2bLayerOptions } from "./phase2b-routes"
import { PHASE2E_ROUTES, type Phase2eRouteContext, type Phase2eLayerOptions } from "./phase2e-routes"
import { PHASE2F_ROUTES, type Phase2fRouteContext, type Phase2fLayerOptions, buildPhase2fContext } from "./phase2f-routes"
import { PHASE2G_ROUTES, type Phase2gRouteContext, type Phase2gLayerOptions } from "./phase2g-routes"
import { AutomationError } from "@vaulltcore/automation"
import { AuthError, AuthorizationError } from "@vaulltcore/auth"

export interface ControlPlaneOptions {
  readonly runner: AgentRunner
  /** Replaceable authentication boundary (defaults to test headers). */
  readonly authenticator?: ControlAuthenticator
  /** Replaceable idempotency registry (defaults to in-memory). Used only when
   *  the legacy (non-business) POST /jobs path is active. */
  readonly idempotency?: IdempotencyRegistry
  /** Optional business layer. When provided, POST /jobs routes through the
   *  {@link AdmissionPipeline} (authenticate → authorize → policy → quota →
   *  create) and read endpoints expose organizations/projects/quotas/usage/
   *  billing/audit. When absent, the legacy thin-façade behavior is preserved. */
  readonly business?: BusinessLayerOptions
  /** Phase 2A: automation product layer. When provided (requires the business
   *  layer for admission), the /automation/* product routes are registered. */
  readonly automation?: AutomationLayerOptions
  /** Phase 2B: production scheduling/delivery-observability/retry-status/
   *  SSE/health/metrics routes. Requires the automation layer. */
  readonly phase2b?: Phase2bLayerOptions
  /** Phase 2E: production reliability/operations/redrive/reconciliation/
   *  cancellation/timeout/health/readiness. Requires the automation layer
   *  (for cancel/reconcile) + ops store. Additive; when absent the legacy
   *  behavior is preserved. */
  readonly phase2e?: Phase2eLayerOptions
  /** Phase 2F: durable metering + immutable usage ledger + cost attribution +
   *  B2B usage governance (/usage/* routes). Additive; when absent the
   *  behavior is preserved. */
  readonly phase2f?: Phase2fLayerOptions
  /** Phase 2G: B2B identity/authz hardening. Registers the public `/auth/*`
   *  Better Auth bridge (when an adapter is provided) and the protected
   *  `/identity/*` actor-resolved routes. Additive. */
  readonly phase2g?: Phase2gLayerOptions
}

/** Business-layer wiring. All stores share one SQL database. */
export interface BusinessLayerOptions {
  readonly identity: SqlIdentityStore
  readonly policy: SqlPolicyStore
  readonly quota: SqlQuotaStore
  readonly metering: SqlMeteringStore
  readonly billing: SqlBillingStore
  readonly audit: SqlAuditStore
  /** Authenticator that resolves a bearer API key into a ResolvedPrincipal.
   *  When set, the control plane authenticates via the identity store. */
  readonly apiKeyAuthenticator?: (secret: string) => Promise<ResolvedPrincipal | null>
  readonly admissionIdempotency?: import("./admission").AdmissionIdempotencyRegistry
  /** Phase 1F: tenant-scoped job index (satisfied by SqlJobStore.listJobsByTenant).
   *  Required for reconciliation/operations endpoints. */
  readonly jobs?: JobIndex
  /** Phase 1F: durable reconciliation store. Required for reconciliation endpoints. */
  readonly reconciliationStore?: ReconciliationDeps["store"]
  /** Phase 1F: snapshot GC driver. Required for snapshot GC operations endpoints. */
  readonly snapshotGc?: SnapshotGcDriver
}

/** Phase 2A: automation product-layer wiring. The store/delivery/artifacts are
 *  provider-neutral; the admission + runner drive Phase 1 jobs through the
 *  {@link AutomationJobDispatcher} seam. */
export interface AutomationLayerOptions {
  readonly store: import("@vaulltcore/automation").AutomationServiceDeps["store"]
  readonly artifacts?: import("@vaulltcore/automation").AutomationServiceDeps["artifacts"]
  readonly delivery?: import("@vaulltcore/automation").AutomationServiceDeps["delivery"]
}

interface CreateJobRequestBody {
  spec?: {
    engine?: string
    model?: string
    input?: string
    engineOptions?: Record<string, unknown>
  }
  policy?: Partial<ExecutionPolicy>
  /** Only honored when the business layer is active and the authn principal's
   *  project scope is the wildcard "*". */
  projectId?: string
}

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  principal: AuthnPrincipal,
  query: URLSearchParams,
) => Promise<void>

const MAX_BODY_BYTES = 64 * 1024

export class ControlPlane {
  private readonly runner: AgentRunner
  private readonly authenticator: ControlAuthenticator
  private readonly idempotency: IdempotencyRegistry
  private readonly routes: Array<{ method: string; pattern: RegExp; keys: string[]; handler: Handler }> = []
  private readonly business: BusinessLayerOptions | null
  private readonly admission: AdmissionPipeline | null
  private readonly automation: AutomationLayer | null
  private readonly automationContext: AutomationRouteContext | null
  private readonly phase2bContext: Phase2bRouteContext | null
  private readonly phase2eContext: Phase2eRouteContext | null
  private readonly phase2fContext: Phase2fRouteContext | null
  private readonly phase2gContext: Phase2gRouteContext | null

  constructor(options: ControlPlaneOptions) {
    this.runner = options.runner
    this.authenticator = options.authenticator ?? new HeaderAuthenticator()
    this.idempotency = options.idempotency ?? new InMemoryIdempotencyRegistry()
    this.business = options.business ?? null
    this.admission = this.business
      ? new AdmissionPipeline({
          runner: this.runner,
          identity: this.business.identity,
          policy: this.business.policy,
          quota: this.business.quota,
          audit: this.business.audit,
          idempotency: this.business.admissionIdempotency ?? new InMemoryAdmissionIdempotencyRegistry(),
        })
      : null
    // Phase 2A: build the automation layer over the admission + runner seam.
    this.automation = options.automation && this.admission && this.business
      ? buildAutomationLayer({
          store: options.automation.store,
          ...(options.automation.artifacts ? { artifacts: options.automation.artifacts } : {}),
          ...(options.automation.delivery ? { delivery: options.automation.delivery } : {}),
          admission: this.admission,
          runner: this.runner,
          audit: this.business.audit,
        })
      : null
    this.automationContext = this.automation
      ? {
          service: this.automation.service,
          resolvePrincipal: (req, authn) => this.resolvePrincipal(req, authn as AuthnPrincipal),
          json: (res, status, body) => this.json(res, status, body),
          readBody: (req) => this.readBody(req),
        }
      : null
    // Phase 2B: schedule/delivery/retry/SSE/health/metrics routes. Requires the
    // automation layer (for the service) + scheduler/ops stores.
    this.phase2bContext = options.phase2b && this.automationContext
      ? {
          service: this.automation!.service,
          schedulerStore: options.phase2b.schedulerStore,
          scheduler: options.phase2b.scheduler ?? null,
          opsStore: options.phase2b.opsStore,
          resolvePrincipal: (req, authn) => this.resolvePrincipal(req, authn as AuthnPrincipal),
          json: (res, status, body) => this.json(res, status, body),
          readBody: (req) => this.readBody(req),
        }
      : null
    // Phase 2E: reliability/operations/redrive/reconcile/cancel/timeout/
    // health/readiness. Requires the automation layer (for cancel/reconcile) +
    // ops store. Additive; when the layer is absent these routes are not
    // registered and the legacy behavior is preserved.
    this.phase2eContext = options.phase2e && this.automationContext
      ? {
          service: this.automation!.service,
          opsStore: options.phase2e.opsStore,
          ...(options.phase2e.triggerStore ? { triggerStore: options.phase2e.triggerStore } : {}),
          ...(options.phase2e.quotaStore ? { quotaStore: options.phase2e.quotaStore } : {}),
          audit: options.phase2e.audit,
          automationStore: options.phase2e.automationStore,
          storage: options.phase2e.storage,
          ...(options.phase2e.dispatchService ? { dispatchService: options.phase2e.dispatchService } : {}),
          resolvePrincipal: (req, authn) => this.resolvePrincipal(req, authn as AuthnPrincipal),
          json: (res, status, body) => this.json(res, status, body),
          readBody: (req) => this.readBody(req),
        }
      : null
    // Phase 2F: durable metering + immutable usage ledger + cost attribution +
    // B2B usage governance (/usage/* routes). Additive; when the layer is
    // absent these routes are not registered and the legacy behavior is
    // preserved.
    this.phase2fContext = options.phase2f
      ? buildPhase2fContext(options.phase2f, {
          resolvePrincipal: (req, authn) => this.resolvePrincipal(req, authn as AuthnPrincipal),
          json: (res, status, body) => this.json(res, status, body),
          readBody: (req) => this.readBody(req),
        })
      : null
    // Phase 2G: B2B identity/authz hardening. Additive; absent → no routes.
    this.phase2gContext = options.phase2g
      ? {
          ...options.phase2g,
          json: (res: ServerResponse, status: number, body: unknown) => this.json(res, status, body),
          readBody: (req: IncomingMessage) => this.readBody(req),
        }
      : null
    this.add("POST", "/jobs", this.createJob)
    this.add("GET", "/jobs/:jobId", this.getJob)
    this.add("POST", "/jobs/:jobId/cancel", this.cancelJob)
    this.add("POST", "/jobs/:jobId/input", this.submitInput)
    this.add("GET", "/jobs/:jobId/usage", this.getUsage)
    this.add("GET", "/jobs/:jobId/events", this.events)
    // Business-layer read endpoints (no-op when business layer absent).
    this.add("GET", "/organizations", this.listOrganizations)
    this.add("GET", "/organizations/:orgId/projects", this.listProjects)
    this.add("GET", "/organizations/:orgId/quotas", this.listQuotas)
    this.add("GET", "/organizations/:orgId/usage", this.getScopeUsage)
    this.add("GET", "/organizations/:orgId/ledger", this.getLedger)
    this.add("GET", "/organizations/:orgId/audit", this.getAudit)
    this.add("GET", "/organizations/:orgId/projects/:projectId/quotas", this.listProjectQuotas)
    this.add("GET", "/organizations/:orgId/projects/:projectId/usage", this.getProjectUsage)
    this.add("GET", "/organizations/:orgId/projects/:projectId/ledger", this.getProjectLedger)
    this.add("GET", "/organizations/:orgId/projects/:projectId/audit", this.getProjectAudit)
    // Phase 1F: operational health + reconciliation (tenant-scoped).
    this.add("POST", "/reconcile", this.triggerReconcile)
    this.add("GET", "/reconcile/health", this.reconcileHealth)
    this.add("GET", "/operations/health", this.operationsHealth)
    this.add("POST", "/operations/snapshot-gc", this.triggerSnapshotGc)
  }

  /** Phase 2A: the automation product service (null when not wired). Tests and
   *  integrations use this to drive the service directly. */
  get automationService(): AutomationLayer["service"] | null {
    return this.automation?.service ?? null
  }

  private add(method: string, path: string, handler: Handler): void {
    const keys = path.split("/").filter((s) => s.startsWith(":")).map((s) => s.slice(1))
    const pattern = new RegExp(`^${path.replace(/:(\w+)/g, () => "([^/]+)")}$`)
    this.routes.push({ method, pattern, keys, handler: handler.bind(this) })
  }

  listen(port = 0, host = "127.0.0.1"): Promise<Server> {
    const server = createServer(this.dispatch.bind(this))
    return new Promise((resolve) => {
      server.listen(port, host, () => resolve(server))
    })
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://internal")
    if (url.pathname === "/health") {
      this.json(res, 200, { ok: true })
      return
    }
    // Phase 2G public trust-boundary exception: `/auth/*` bridges to Better
    // Auth (sign-up/sign-in/sign-out/OAuth). Explicitly public like /health —
    // everything else below requires the authenticated pipeline.
    if (this.phase2gContext?.betterAuth && url.pathname.startsWith("/auth/")) {
      const body = req.method === "POST" || req.method === "PUT" || req.method === "PATCH" ? JSON.stringify(await this.readBody(req)) : undefined
      const bridged = await this.phase2gContext.betterAuth.handleRequest({
        method: req.method ?? "GET",
        path: url.pathname.replace(/^\/auth\//, "/api/auth/") + url.search,
        headers: req.headers as Record<string, string | string[] | undefined>,
        ...(body !== undefined ? { body } : {}),
      })
      const headers = { ...bridged.headers }
      res.writeHead(bridged.status, headers as Record<string, string | string[]>)
      res.end(bridged.body)
      return
    }
    try {
      // Phase 2G protected routes (/identity/*): resolved through the Phase 2G
      // request security pipeline (authenticate → actor → tenant context →
      // authorization), independent of the legacy header authenticator.
      if (this.phase2gContext && url.pathname.startsWith("/identity/")) {
        const actor = await this.phase2gContext.resolver.resolve({
          authorization: req.headers.authorization,
          cookie: req.headers.cookie,
          requestedOrgId: typeof req.headers["x-vc-org"] === "string" ? req.headers["x-vc-org"] : undefined,
        })
        if (!actor) {
          this.json(res, 401, { error: { code: "UNAUTHENTICATED", message: "authentication required" } })
          return
        }
        const matched = PHASE2G_ROUTES.find((r) => r.method === req.method && r.pattern.test(url.pathname))
        if (!matched) {
          this.json(res, 404, { error: { code: "NOT_FOUND", message: "unknown identity route" } })
          return
        }
        const values = matched.pattern.exec(url.pathname)
        const params: Record<string, string> = {}
        matched.keys.forEach((key, i) => { params[key] = values?.[i + 1] ?? "" })
        await matched.handler(req, res, params, actor, url.searchParams, this.phase2gContext)
        return
      }
      const principal = await this.authenticator.authenticate(req)
      if (!principal) {
        this.json(res, 401, { error: { code: "UNAUTHENTICATED", message: "authentication required" } })
        return
      }
      // Phase 2A: automation product routes (when the automation layer is wired).
      if (this.automationContext && url.pathname.startsWith("/automation")) {
        // Phase 2B routes are more specific (schedules, deliveries, stream);
        // try them first so they win over the generic automation routes.
        if (this.phase2bContext) {
          const p2 = PHASE2B_ROUTES.find((r) => r.method === req.method && r.pattern.test(url.pathname))
          if (p2) {
            const values = p2.pattern.exec(url.pathname)
            const params: Record<string, string> = {}
            p2.keys.forEach((key, i) => { params[key] = values?.[i + 1] ?? "" })
            const authn = { tenantId: principal.tenantId, orgId: principal.orgId, projectId: principal.projectId, admin: principal.admin }
            await p2.handler(req, res, params, authn, url.searchParams, this.phase2bContext)
            return
          }
        }
        const ar = AUTOMATION_ROUTES.find((r) => r.method === req.method && r.pattern.test(url.pathname))
        if (!ar) {
          this.json(res, 404, { error: { code: "NOT_FOUND", message: "unknown automation route" } })
          return
        }
        const values = ar.pattern.exec(url.pathname)
        const params: Record<string, string> = {}
        ar.keys.forEach((key, i) => {
          params[key] = values?.[i + 1] ?? ""
        })
        const authn = { tenantId: principal.tenantId, orgId: principal.orgId, projectId: principal.projectId, admin: principal.admin }
        await ar.handler(req, res, params, authn, url.searchParams, this.automationContext)
        return
      }
      // Phase 2B operations routes (retry-status, health) under /operations.
      if (this.phase2bContext && (url.pathname.startsWith("/operations/retry-status") || url.pathname.startsWith("/operations/health/p2b"))) {
        const p2 = PHASE2B_ROUTES.find((r) => r.method === req.method && r.pattern.test(url.pathname))
        if (p2) {
          const values = p2.pattern.exec(url.pathname)
          const params: Record<string, string> = {}
          p2.keys.forEach((key, i) => { params[key] = values?.[i + 1] ?? "" })
          const authn = { tenantId: principal.tenantId, orgId: principal.orgId, projectId: principal.projectId, admin: principal.admin }
          await p2.handler(req, res, params, authn, url.searchParams, this.phase2bContext)
          return
        }
      }
      // Phase 2E reliability/operations/readiness routes. Matched before the
      // generic routes so the specific patterns win. Additive; when the phase2e
      // layer is absent this block is skipped entirely.
      if (this.phase2eContext && (url.pathname.startsWith("/operations") || url.pathname.startsWith("/readiness") || url.pathname.startsWith("/runs/") && url.pathname.endsWith("/cancel"))) {
        const pe = PHASE2E_ROUTES.find((r) => r.method === req.method && r.pattern.test(url.pathname))
        if (pe) {
          const values = pe.pattern.exec(url.pathname)
          const params: Record<string, string> = {}
          pe.keys.forEach((key, i) => { params[key] = values?.[i + 1] ?? "" })
          const authn = { tenantId: principal.tenantId, orgId: principal.orgId, projectId: principal.projectId, admin: principal.admin }
          await pe.handler(req, res, params, authn, url.searchParams, this.phase2eContext)
          return
        }
      }
      // Phase 2F usage governance routes (/usage/*). Matched before the generic
      // routes so the specific patterns win. Additive; when the phase2f layer
      // is absent this block is skipped entirely.
      if (this.phase2fContext && url.pathname.startsWith("/usage")) {
        const pf = PHASE2F_ROUTES.find((r) => r.method === req.method && r.pattern.test(url.pathname))
        if (pf) {
          const values = pf.pattern.exec(url.pathname)
          const params: Record<string, string> = {}
          pf.keys.forEach((key, i) => { params[key] = values?.[i + 1] ?? "" })
          const authn = { tenantId: principal.tenantId, orgId: principal.orgId, projectId: principal.projectId, admin: principal.admin }
          await pf.handler(req, res, params, authn, url.searchParams, this.phase2fContext)
          return
        }
      }
      const route = this.routes.find((r) => r.method === req.method && r.pattern.test(url.pathname))
      if (!route) {
        this.json(res, 404, { error: { code: "NOT_FOUND", message: "unknown route" } })
        return
      }
      const values = route.pattern.exec(url.pathname)
      const params: Record<string, string> = {}
      route.keys.forEach((key, i) => {
        params[key] = values?.[i + 1] ?? ""
      })
      await route.handler(req, res, params, principal!, url.searchParams)
    } catch (error) {
      // Phase 2G: deterministic, non-leaking security error surface.
      if (error instanceof AuthorizationError) {
        this.json(res, 403, { error: { code: "FORBIDDEN", message: error.message } })
        return
      }
      if (error instanceof AuthError) {
        const status =
          error.code === "UNAUTHENTICATED" || error.code === "SESSION_EXPIRED" || error.code === "SESSION_REVOKED" || error.code === "USER_DISABLED" || error.code === "CREDENTIAL_REVOKED" || error.code === "CREDENTIAL_EXPIRED" || error.code === "SERVICE_IDENTITY_INACTIVE"
            ? 401
            : error.code === "ORG_NOT_MEMBER" || error.code === "NOT_FOUND"
              ? 404
              : error.code === "CONFLICT"
                ? 409
                : error.code === "INVALID_INPUT"
                  ? 422
                  : 401
        this.json(res, status, { error: { code: error.code, message: error.message } })
        return
      }
      if (error instanceof AutomationError) {
        this.json(res, error.status, { error: { code: error.code, message: error.message } })
        return
      }
      if (error instanceof AdmissionError) {
        this.json(res, error.status, { error: { code: error.code, message: error.message } })
        return
      }
      if (error instanceof JobNotFoundError) {
        this.json(res, 404, { error: { code: error.code, message: error.message } })
        return
      }
      if (error instanceof VaulltcoreError) {
        const status =
          error.code === "JOB_EXISTS" || error.code.startsWith("INVALID_JOB_STATE")
            ? 409
            : error.code.startsWith("POLICY")
              ? 403
              : error.code === "PAYLOAD_TOO_LARGE"
                ? 413
                : 400
        this.json(res, status, { error: { code: error.code, message: error.message } })
        return
      }
      this.json(res, 500, { error: { code: "INTERNAL", message: error instanceof Error ? error.message : "unknown" } })
    }
  }

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  private async createJob(req: IncomingMessage, res: ServerResponse, _params: Record<string, string>, principal: AuthnPrincipal): Promise<void> {
    const key = req.headers["idempotency-key"]
    if (typeof key !== "string" || key === "") {
      this.json(res, 400, { error: { code: "BAD_REQUEST", message: "Idempotency-Key header required" } })
      return
    }
    const body = (await this.readBody(req)) as CreateJobRequestBody

    // Business-layer admission pipeline (when wired). This replaces the thin
    // idempotency+create path with authenticate→authorize→policy→quota→create,
    // preserving the same idempotency semantics (same tenant + key ⇒ same job).
    if (this.admission && this.business) {
      const resolved = await this.resolvePrincipal(req, principal)
      if (!resolved) {
        this.json(res, 401, { error: { code: "UNAUTHENTICATED", message: "principal could not be resolved" } })
        return
      }
      const spec = body.spec ?? {}
      const requestedTools = (body.policy?.allowedTools as readonly string[] | undefined) ?? []
      const admissionReq: AdmissionRequest = {
        principal: resolved,
        idempotencyKey: key,
        orgId: principal.orgId,
        projectId: principal.projectId === "*" ? body.projectId ?? "default" : principal.projectId,
        spec: {
          engine: spec.engine ?? "script",
          model: spec.model ?? "unknown",
          ...(typeof spec.input === "string" ? { input: spec.input } : { input: "" }),
          ...(spec.engineOptions ? { engineOptions: spec.engineOptions } : {}),
        },
        requestedTools,
        ...(body.policy?.maxSteps !== undefined ? { requestedMaxSteps: body.policy.maxSteps } : {}),
      }
      const result = await this.admission.admit(admissionReq)
      this.json(res, result.replayed ? 200 : 201, { id: result.jobId, reservationId: result.reservationId, status: result.status })
      return
    }

    // Legacy thin-façade path (no business layer).
    // Phase 1D: claim the (tenant, key) slot with a request hash. Same tenant +
    // same key + same request ⇒ return original job; a different request ⇒ 409.
    // Different tenants may use identical keys without collision.
    const requestHash = requestHashFor(body)
    const claimResult = await this.idempotency.claim({ tenantId: principal.tenantId, key, requestHash })
    if (claimResult.kind === "fulfilled") {
      const reused = await this.runner.getJob(claimResult.jobId)
      if (reused) {
        this.json(res, 200, reused)
        return
      }
      // Fulfilled record but job missing (data loss): clear the stale slot and
      // re-claim so the new job is recorded durably.
      await this.idempotency.delete(principal.tenantId, key)
      const reClaim = await this.idempotency.claim({ tenantId: principal.tenantId, key, requestHash })
      if (reClaim.kind === "conflict") {
        this.json(res, 409, { error: { code: "IDEMPOTENCY_CONFLICT", message: reClaim.detail, jobId: reClaim.jobId } })
        return
      }
      if (reClaim.kind !== "new") {
        // Unexpected; treat as a transient conflict.
        this.json(res, 409, { error: { code: "IDEMPOTENCY_CONFLICT", message: "idempotency slot not creatable", jobId: null } })
        return
      }
      await this.createAndFulfill(res, principal, body, reClaim.slotId, key)
      return
    }
    if (claimResult.kind === "conflict") {
      this.json(res, 409, { error: { code: "IDEMPOTENCY_CONFLICT", message: claimResult.detail, jobId: claimResult.jobId } })
      return
    }
    // claimResult.kind is "new" or "pending" (pending = creator crashed mid-
    // create; safe to re-attempt the same request). Create the job and fulfill.
    await this.createAndFulfill(res, principal, body, claimResult.slotId, key)
  }

  private async createAndFulfill(
    res: ServerResponse,
    principal: AuthnPrincipal,
    body: CreateJobRequestBody,
    slotId: string,
    idempotencyKey: string,
  ): Promise<void> {
    const spec = body.spec ?? {}
    const input: CreateJobInput = {
      tenantId: principal.tenantId,
      orgId: principal.orgId,
      projectId: principal.projectId,
      spec: {
        engine: spec.engine ?? "script",
        model: spec.model ?? "unknown",
        input: typeof spec.input === "string" ? spec.input : "",
      },
      policy: body.policy,
    }
    let record: JobRecord
    try {
      record = await this.runner.createJob(input)
    } catch (error) {
      // Job creation failed: release the pending slot so a retry isn't stuck
      // returning "pending" forever. The next identical request re-claims.
      await Promise.resolve(this.idempotency.delete(principal.tenantId, idempotencyKey)).catch(() => {})
      throw error
    }
    // Fulfill the slot with the created job + response status. This is the
    // durability boundary: after this call, a crash+retry returns the original
    // job (kind "fulfilled") instead of creating a duplicate.
    await this.idempotency.fulfill(slotId, record.jobId, 201)
    this.json(res, 201, { id: record.jobId, status: record.status })
  }

  /** Tenant scope check: null on mismatch (cross-tenant access returns 404,
   * no information beyond existence). */
  private async scoped(principal: AuthnPrincipal, jobId: string) {
    const job = await this.runner.getJob(jobId)
    if (!job || (job.tenantId !== principal.tenantId && !principal.admin)) return null
    return job
  }

  private async getJob(req: IncomingMessage, res: ServerResponse, params: Record<string, string>, principal: AuthnPrincipal): Promise<void> {
    const job = await this.scoped(principal, params.jobId!)
    if (!job) this.notFound(res)
    else this.json(res, 200, job)
  }

  private async getUsage(req: IncomingMessage, res: ServerResponse, params: Record<string, string>, principal: AuthnPrincipal): Promise<void> {
    if (!(await this.scoped(principal, params.jobId!))) throw new JobNotFoundError(params.jobId!)
    const usage = await this.runner.collectUsage(params.jobId!)
    this.json(res, 200, { jobId: params.jobId!, usage })
  }

  private async cancelJob(req: IncomingMessage, res: ServerResponse, params: Record<string, string>, principal: AuthnPrincipal): Promise<void> {
    if (!(await this.scoped(principal, params.jobId!))) throw new JobNotFoundError(params.jobId!)
    const state = await this.runner.cancelJob(params.jobId!)
    this.json(res, 200, { status: state.status })
  }

  private async submitInput(req: IncomingMessage, res: ServerResponse, params: Record<string, string>, principal: AuthnPrincipal): Promise<void> {
    if (!(await this.scoped(principal, params.jobId!))) throw new JobNotFoundError(params.jobId!)
    const body = await this.readBody(req)
    if (typeof body.text !== "string") {
      this.json(res, 400, { error: { code: "BAD_REQUEST", message: "text field required" } })
      return
    }
    const state = await this.runner.submitInput(params.jobId!, body.text)
    this.json(res, 200, { status: state.status })
  }

  private async events(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
    principal: AuthnPrincipal,
    query: URLSearchParams,
  ): Promise<void> {
    if (!(await this.scoped(principal, params.jobId!))) throw new JobNotFoundError(params.jobId!)
    const after = Number(query.get("after") ?? 0)
    const follow = query.get("follow") === "true"
    if (!follow) {
      // Non-following replay: one bounded query, exact seq ordering, no gap.
      const events = await this.runner.listEvents(params.jobId!, Math.max(0, after || 0))
      this.json(res, 200, { events })
      return
    }
    // SSE: replay, then live follow, honouring no-gap semantics end-to-end.
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    })
    const abort = new AbortController()
    req.on("close", () => abort.abort())
    try {
      for await (const event of this.runner.streamEvents(params.jobId!, Math.max(0, after || 0), abort.signal)) {
        res.write(`event: job-event\ndata: ${JSON.stringify(event)}\n\n`)
      }
      res.write(`event: done\ndata: {"done":true}\n\n`)
    } catch {
      // Client disconnected mid-stream. The job continues; its terminal state
      // remains queryable through GET /jobs/:id or GET /jobs/:id/usage.
    }
    res.end()
  }

  // -------------------------------------------------------------------------
  // Business-layer read handlers
  // -------------------------------------------------------------------------

  /** Resolve the authenticated principal into the business-layer identity. When
   *  an API-key authenticator is configured, it maps the bearer secret to a
   *  ResolvedPrincipal; otherwise the synthetic header principal is wrapped. */
  private async resolvePrincipal(_req: IncomingMessage, authn: AuthnPrincipal): Promise<ResolvedPrincipal | null> {
    if (!this.business) return null
    if (this.business.apiKeyAuthenticator) {
      const auth = _req.headers["authorization"]
      const token = typeof auth === "string" && auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null
      if (!token) return null
      return this.business.apiKeyAuthenticator(token)
    }
    return {
      principalId: `authn:${authn.tenantId}:${authn.orgId}`,
      tenantId: authn.tenantId,
      orgId: authn.orgId,
      role: "admin",
      kind: "service_account",
      projectScope: ["*"],
      admin: authn.admin,
    }
  }

  /** Tenant/org scoping for read handlers: the orgId in the URL must match the
   *  authenticated principal's tenant. Cross-tenant reads return 404. */
  private scopeTenant(principal: AuthnPrincipal, orgId: string): boolean {
    return principal.admin || orgId === principal.orgId || principal.orgId === "*"
  }

  private async listOrganizations(_req: IncomingMessage, res: ServerResponse, _params: Record<string, string>, principal: AuthnPrincipal): Promise<void> {
    if (!this.business) return this.json(res, 501, { error: { code: "NOT_CONFIGURED", message: "business layer not enabled" } })
    const orgs = await this.business.identity.listOrganizations(principal.tenantId)
    this.json(res, 200, { organizations: orgs })
  }

  private async listProjects(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, principal: AuthnPrincipal): Promise<void> {
    if (!this.business) return this.json(res, 501, { error: { code: "NOT_CONFIGURED", message: "business layer not enabled" } })
    const orgId = params.orgId!
    if (!this.scopeTenant(principal, orgId) && !principal.admin) return this.notFound(res)
    const projects = await this.business.identity.listProjects(principal.tenantId, orgId)
    this.json(res, 200, { projects })
  }

  private async listQuotas(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, principal: AuthnPrincipal): Promise<void> {
    if (!this.business) return this.json(res, 501, { error: { code: "NOT_CONFIGURED", message: "business layer not enabled" } })
    const orgId = params.orgId!
    if (!this.scopeTenant(principal, orgId) && !principal.admin) return this.notFound(res)
    const reservations = await this.business.quota.listReservations({ tenantId: principal.tenantId, orgId, projectId: "*" })
    this.json(res, 200, { reservations })
  }

  private async listProjectQuotas(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, principal: AuthnPrincipal): Promise<void> {
    if (!this.business) return this.json(res, 501, { error: { code: "NOT_CONFIGURED", message: "business layer not enabled" } })
    const { orgId, projectId } = params
    if (!this.scopeTenant(principal, orgId!) && !principal.admin) return this.notFound(res)
    const reservations = await this.business.quota.listReservations({ tenantId: principal.tenantId, orgId: orgId!, projectId: projectId! })
    this.json(res, 200, { reservations })
  }

  private async getScopeUsage(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, principal: AuthnPrincipal): Promise<void> {
    if (!this.business) return this.json(res, 501, { error: { code: "NOT_CONFIGURED", message: "business layer not enabled" } })
    const orgId = params.orgId!
    if (!this.scopeTenant(principal, orgId) && !principal.admin) return this.notFound(res)
    const aggregate = await this.business.metering.aggregateScope({ tenantId: principal.tenantId, orgId, projectId: "*" })
    this.json(res, 200, { usage: aggregate })
  }

  private async getProjectUsage(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, principal: AuthnPrincipal): Promise<void> {
    if (!this.business) return this.json(res, 501, { error: { code: "NOT_CONFIGURED", message: "business layer not enabled" } })
    const { orgId, projectId } = params
    if (!this.scopeTenant(principal, orgId!) && !principal.admin) return this.notFound(res)
    const aggregate = await this.business.metering.aggregateScope({ tenantId: principal.tenantId, orgId: orgId!, projectId: projectId! })
    this.json(res, 200, { usage: aggregate })
  }

  private async getLedger(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, principal: AuthnPrincipal): Promise<void> {
    if (!this.business) return this.json(res, 501, { error: { code: "NOT_CONFIGURED", message: "business layer not enabled" } })
    const orgId = params.orgId!
    if (!this.scopeTenant(principal, orgId) && !principal.admin) return this.notFound(res)
    const entries = await this.business.billing.listEntries({ tenantId: principal.tenantId, orgId, projectId: "*" })
    const balance = await this.business.billing.getBalance({ tenantId: principal.tenantId, orgId, projectId: "*" })
    this.json(res, 200, { entries, balance })
  }

  private async getProjectLedger(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, principal: AuthnPrincipal): Promise<void> {
    if (!this.business) return this.json(res, 501, { error: { code: "NOT_CONFIGURED", message: "business layer not enabled" } })
    const { orgId, projectId } = params
    if (!this.scopeTenant(principal, orgId!) && !principal.admin) return this.notFound(res)
    const entries = await this.business.billing.listEntries({ tenantId: principal.tenantId, orgId: orgId!, projectId: projectId! })
    const balance = await this.business.billing.getBalance({ tenantId: principal.tenantId, orgId: orgId!, projectId: projectId! })
    this.json(res, 200, { entries, balance })
  }

  private async getAudit(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, principal: AuthnPrincipal, query: URLSearchParams): Promise<void> {
    if (!this.business) return this.json(res, 501, { error: { code: "NOT_CONFIGURED", message: "business layer not enabled" } })
    const orgId = params.orgId!
    if (!this.scopeTenant(principal, orgId) && !principal.admin) return this.notFound(res)
    const limit = Math.min(Number(query.get("limit") ?? 1000), 5000)
    const events = await this.business.audit.list({ tenantId: principal.tenantId, orgId }, limit)
    this.json(res, 200, { events })
  }

  private async getProjectAudit(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, principal: AuthnPrincipal, query: URLSearchParams): Promise<void> {
    if (!this.business) return this.json(res, 501, { error: { code: "NOT_CONFIGURED", message: "business layer not enabled" } })
    const { orgId, projectId } = params
    if (!this.scopeTenant(principal, orgId!) && !principal.admin) return this.notFound(res)
    const limit = Math.min(Number(query.get("limit") ?? 1000), 5000)
    const events = await this.business.audit.list({ tenantId: principal.tenantId, orgId: orgId!, projectId: projectId! }, limit)
    this.json(res, 200, { events })
  }

  // -------------------------------------------------------------------------
  // Phase 1F: operational health + reconciliation (tenant-scoped)
  //
  // Tenant-facing endpoints derive the tenant EXCLUSIVELY from the authenticated
  // principal (`principal.tenantId`), never from the request body — so an
  // ordinary tenant credential can never read another tenant's operational data
  // (cross-tenant access returns 404, no leak). System/operator-level
  // inspection additionally requires an explicitly privileged (admin) principal.
  // -------------------------------------------------------------------------

  /** Lazily build the reconciliation service from the wired business stores. */
  private reconciliationService(): ReconciliationService | null {
    if (!this.business || !this.business.jobs || !this.business.reconciliationStore) return null
    return new ReconciliationService({
      runner: this.runner,
      jobs: this.business.jobs,
      metering: this.business.metering,
      billing: this.business.billing,
      quota: this.business.quota,
      store: this.business.reconciliationStore,
    })
  }

  /** POST /reconcile — run a tenant-scoped reconciliation pass. */
  private async triggerReconcile(_req: IncomingMessage, res: ServerResponse, _params: Record<string, string>, principal: AuthnPrincipal, query: URLSearchParams): Promise<void> {
    const service = this.reconciliationService()
    if (!service) return this.json(res, 501, { error: { code: "NOT_CONFIGURED", message: "reconciliation not enabled" } })
    const result = await service.reconcile({
      tenantId: principal.tenantId,
      scope: query.get("scope") ?? "tenant",
      maxJobs: query.get("maxJobs") ? Number(query.get("maxJobs")) : undefined,
      repair: query.get("repair") === "false" ? false : true,
    })
    this.json(res, 200, result)
  }

  /** GET /reconcile/health — reconciliation health for the authenticated tenant. */
  private async reconcileHealth(_req: IncomingMessage, res: ServerResponse, _params: Record<string, string>, principal: AuthnPrincipal): Promise<void> {
    const service = this.reconciliationService()
    if (!service) return this.json(res, 501, { error: { code: "NOT_CONFIGURED", message: "reconciliation not enabled" } })
    const health = await service.health(principal.tenantId)
    this.json(res, 200, health)
  }

  /** GET /operations/health — operational health for the authenticated tenant.
   *  Aggregates reconciliation health, unresolved usage/pricing, reservation
   *  backlog, settlement backlog, and snapshot GC backlog. Tenant-scoped; an
   *  ordinary tenant sees ONLY its own data. */
  private async operationsHealth(_req: IncomingMessage, res: ServerResponse, _params: Record<string, string>, principal: AuthnPrincipal): Promise<void> {
    if (!this.business) return this.json(res, 501, { error: { code: "NOT_CONFIGURED", message: "business layer not enabled" } })
    const tenantId = principal.tenantId
    const recon = this.reconciliationService()
    const reconHealth = recon ? await recon.health(tenantId) : null
    const unresolvedUsage = this.business.billing.listSettlementsByState(tenantId, "unresolved").length
    const pendingSettlement = this.business.billing.listSettlementsByState(tenantId, "pending").length
    const expiredReservations = await this.business.quota.listExpiredActive()
    const scopedExpired = expiredReservations.filter((r) => r.tenantId === tenantId).length
    const snapshotGcBacklog = this.business.snapshotGc
      ? this.business.snapshotGc.listByState("eligible").length + this.business.snapshotGc.listByState("deleting").length + this.business.snapshotGc.listByState("failed").length
      : 0
    this.json(res, 200, {
      tenantId,
      reconciliation: reconHealth,
      unresolvedUsage,
      unresolvedPricing: unresolvedUsage,
      pendingSettlement,
      settlementBacklog: unresolvedUsage + pendingSettlement,
      expiredReservations: scopedExpired,
      snapshotGcBacklog,
    })
  }

  /** POST /operations/snapshot-gc — run one snapshot GC pass (operator). */
  private async triggerSnapshotGc(_req: IncomingMessage, res: ServerResponse, _params: Record<string, string>, principal: AuthnPrincipal): Promise<void> {
    if (!this.business?.snapshotGc) return this.json(res, 501, { error: { code: "NOT_CONFIGURED", message: "snapshot GC not enabled" } })
    // Snapshot GC is an operator action: require an explicitly privileged
    // principal. An ordinary tenant cannot trigger cross-scope deletion.
    if (!principal.admin) return this.json(res, 403, { error: { code: "FORBIDDEN", message: "operator privileges required" } })
    const result = await this.business.snapshotGc.runGc()
    this.json(res, 200, result)
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  private notFound(res: ServerResponse): void {
    this.json(res, 404, { error: { code: "JOB_NOT_FOUND", message: "job not found" } })
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" })
    res.end(JSON.stringify(body))
  }

  private async readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > MAX_BODY_BYTES) throw new VaulltcoreError("PAYLOAD_TOO_LARGE", "request body too large")
      chunks.push(chunk as Buffer)
    }
    if (chunks.length === 0) return {}
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
    } catch {
      throw new VaulltcoreError("BAD_REQUEST", "request body must be valid JSON")
    }
  }
}
