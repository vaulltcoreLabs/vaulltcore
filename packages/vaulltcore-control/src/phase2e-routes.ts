/**
 * Control-plane integration for Phase 2E: production reliability + operational
 * controls. Purely additive — registers `/operations/*` and `/reliability/*`
 * routes when the Phase 2E layer is wired. It reuses the reliability service
 * (reconciliation, redrive, timeout, health) and the existing ops/trigger/quota
 * stores; it does NOT introduce another server, runtime, or authorization
 * model.
 *
 * Routes (registered by {@link ControlPlane} when the Phase 2E layer is wired):
 *   GET    /operations/retry-status            (retry/dead-letter overview)
 *   GET    /operations/dead-letter             (dead-lettered ops + dispatches)
 *   POST   /operations/dead-letter/:id/redrive (authorized redrive — ops)
 *   POST   /operations/dispatches/:id/redrive  (authorized redrive — dispatch)
 *   POST   /operations/reconcile               (trigger a bounded reconcile pass)
 *   POST   /operations/timeout-scan            (trigger a bounded timeout pass)
 *   POST   /runs/:id/cancel                    (cooperative durable cancel)
 *   GET    /readiness                          (liveness/readiness probe)
 *   GET    /operations/health/reliability      (tenant-safe operational health)
 *
 * Preserves: authentication, tenant/project authorization (reuses Phase 1E
 * role-rank), safe error semantics. Cross-tenant/unauthorized access returns
 * 404 (no existence leak). Tenant identity comes from the authenticated
 * principal, never the body. No stack traces, secrets, or credentials are
 * exposed in JSON/errors/audit. Returns deterministic errors: 401/404/409/422.
 */

import type { IncomingMessage, ServerResponse } from "node:http"
import type { ResolvedPrincipal } from "@vaulltcore/identity"
import type { AutomationService } from "@vaulltcore/automation"
import type { SqlTriggerStore } from "@vaulltcore/automation"
import type { SqlOpsStore } from "@vaulltcore/ops"
import type { SqlQuotaStore } from "@vaulltcore/quota"
import type { SqlAuditStore } from "@vaulltcore/audit"
import {
  ReliabilityReconciliationService,
  RedriveService,
  TimeoutService,
  HealthService,
  SqlStorageProbe,
  AuditTelemetrySink,
  requestCancellation,
} from "@vaulltcore/reliability"
import { AutomationError } from "@vaulltcore/automation"

// ---------------------------------------------------------------------------
// Layer wiring
// ---------------------------------------------------------------------------

export interface Phase2eLayerOptions {
  readonly opsStore: SqlOpsStore
  readonly triggerStore?: SqlTriggerStore
  readonly quotaStore?: SqlQuotaStore
  readonly audit: SqlAuditStore
  readonly service: AutomationService
  /** The automation store (for reconciliation + timeout scanning). */
  readonly automationStore: import("@vaulltcore/automation").AutomationStore
  /** The SQL store base for the readiness storage probe. */
  readonly storage: import("@vaulltcore/store-sql").SqlStoreBase
  /** Optional dispatch service for stranded-dispatch redrive in reconciliation. */
  readonly dispatchService?: import("@vaulltcore/automation").TriggerDispatchService
}

export interface Phase2eRouteContext {
  readonly service: AutomationService
  readonly opsStore: SqlOpsStore
  readonly triggerStore?: SqlTriggerStore
  readonly quotaStore?: SqlQuotaStore
  readonly audit: SqlAuditStore
  readonly automationStore: import("@vaulltcore/automation").AutomationStore
  readonly storage: import("@vaulltcore/store-sql").SqlStoreBase
  readonly dispatchService?: import("@vaulltcore/automation").TriggerDispatchService
  resolvePrincipal(req: IncomingMessage, authn: { tenantId: string; orgId: string; projectId: string; admin?: boolean }): Promise<ResolvedPrincipal | null>
  json(res: ServerResponse, status: number, body: unknown): void
  readBody(req: IncomingMessage): Promise<Record<string, unknown>>
}

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  authn: { tenantId: string; orgId: string; projectId: string; admin?: boolean },
  query: URLSearchParams,
  ctx: Phase2eRouteContext,
) => Promise<void>

export interface Phase2eRoute {
  readonly method: string
  readonly pattern: RegExp
  readonly keys: string[]
  readonly handler: RouteHandler
}

function route(method: string, path: string, handler: RouteHandler): Phase2eRoute {
  const keys = path.split("/").filter((s) => s.startsWith(":")).map((s) => s.slice(1))
  const pattern = new RegExp(`^${path.replace(/:(\w+)/g, () => "([^/]+)")}$`)
  return { method, pattern, keys, handler }
}

async function resolveOrFail(ctx: Phase2eRouteContext, req: IncomingMessage, res: ServerResponse, authn: { tenantId: string; orgId: string; projectId: string; admin?: boolean }): Promise<ResolvedPrincipal | null> {
  const principal = await ctx.resolvePrincipal(req, authn)
  if (!principal) {
    ctx.json(res, 401, { error: { code: "UNAUTHENTICATED", message: "principal could not be resolved" } })
    return null
  }
  return principal
}

function handlePhase2eError(error: unknown, ctx: Phase2eRouteContext, res: ServerResponse): void {
  if (error instanceof AutomationError) {
    ctx.json(res, error.status, { error: { code: error.code, message: error.message } })
    return
  }
  const message = error instanceof Error ? error.message : "internal error"
  if (/version conflict|fenced/i.test(message)) {
    ctx.json(res, 409, { error: { code: "CONFLICT", message: "resource version conflict" } })
    return
  }
  ctx.json(res, 500, { error: { code: "INTERNAL", message: "internal error" } })
}

/** Sanitize a diagnostic string (never secrets). */
function redact(text: string | null): string | null {
  if (!text) return text
  return text
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/(password|secret|api[_-]?key|token)=([^&\s]+)/gi, "$1=[redacted]")
    .replace(/[A-Za-z0-9_-]{32,}/g, (m) => (/(token|key|secret|password|bearer|auth)/i.test(m) ? "[redacted]" : m))
}

export const PHASE2E_ROUTES: Phase2eRoute[] = [
  // -- Retry / dead-letter status (tenant-scoped) ---------------------------

  route("GET", "/operations/retry-status", async (req, res, _params, authn, query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    try {
      const kindParam = query.get("kind")
      const stateParam = query.get("state")
      const items = ctx.opsStore.list(principal.tenantId, kindParam as never, stateParam as never)
      const deadLetter = ctx.opsStore.listDeadLettered(principal.tenantId, 100)
      let dispatchDeadLetter = [] as Array<{ dispatchId: string; triggerId: string; lastError: string | null; attempts: number; updatedAt: number }>
      if (ctx.triggerStore) {
        const dl = await ctx.triggerStore.listDeadLetteredDispatches(principal.tenantId, 100)
        dispatchDeadLetter = dl.map((d) => ({ dispatchId: d.dispatchId, triggerId: d.triggerId, lastError: redact(d.lastError), attempts: d.attempts, updatedAt: d.updatedAt }))
      }
      ctx.json(res, 200, {
        items: items.map((i) => ({
          itemId: i.id,
          kind: i.kind,
          state: i.state,
          attempts: i.attempts,
          lastError: redact(i.lastError),
          nextRetryAt: i.nextRetryAt,
          retryClass: i.retryClass,
          targetRef: i.targetRef,
        })),
        deadLetter: deadLetter.map((i) => ({
          itemId: i.id,
          kind: i.kind,
          attempts: i.attempts,
          lastError: redact(i.lastError),
          retryClass: i.retryClass,
          targetRef: i.targetRef,
        })),
        dispatchDeadLetter,
      })
    } catch (error) {
      handlePhase2eError(error, ctx, res)
    }
  }),

  // -- Authorized redrive (ops) --------------------------------------------

  route("POST", "/operations/dead-letter/:id/redrive", async (req, res, params, authn, _query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    try {
      if (!principal.admin) {
        ctx.json(res, 403, { error: { code: "FORBIDDEN", message: "operator privileges required for redrive" } })
        return
      }
      const telemetry = new AuditTelemetrySink(ctx.audit, "reliability-redrive")
      const svc = new RedriveService({ opsStore: ctx.opsStore, ...(ctx.triggerStore ? { triggerStore: ctx.triggerStore } : {}), telemetry, tenantId: principal.tenantId })
      const result = await svc.redriveOps(params.id!)
      ctx.json(res, 200, result)
    } catch (error) {
      handlePhase2eError(error, ctx, res)
    }
  }),

  // -- Authorized redrive (dispatch) ---------------------------------------

  route("POST", "/operations/dispatches/:id/redrive", async (req, res, params, authn, _query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    try {
      if (!principal.admin) {
        ctx.json(res, 403, { error: { code: "FORBIDDEN", message: "operator privileges required for redrive" } })
        return
      }
      if (!ctx.triggerStore) {
        ctx.json(res, 501, { error: { code: "NOT_CONFIGURED", message: "trigger store not enabled" } })
        return
      }
      const telemetry = new AuditTelemetrySink(ctx.audit, "reliability-redrive")
      const svc = new RedriveService({ opsStore: ctx.opsStore, triggerStore: ctx.triggerStore, telemetry, tenantId: principal.tenantId })
      const result = await svc.redriveDispatch(params.id!)
      ctx.json(res, 200, result)
    } catch (error) {
      handlePhase2eError(error, ctx, res)
    }
  }),

  // -- Reconcile (bounded pass; tenant-scoped) -----------------------------

  route("POST", "/operations/reconcile", async (req, res, _params, authn, query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    try {
      if (!principal.admin) {
        ctx.json(res, 403, { error: { code: "FORBIDDEN", message: "operator privileges required for reconcile" } })
        return
      }
      const all = query.get("all") === "true"
      const telemetry = new AuditTelemetrySink(ctx.audit, "reliability-reconcile")
      const svc = new ReliabilityReconciliationService({
        opsStore: ctx.opsStore,
        ...(ctx.dispatchService ? { dispatchService: ctx.dispatchService } : {}),
        service: ctx.service,
        automationStore: ctx.automationStore,
        ...(ctx.quotaStore ? { quotaStore: ctx.quotaStore } : {}),
        telemetry,
        tenantId: principal.tenantId,
      })
      const result = all ? await svc.reconcileAll(10) : await svc.reconcile(null)
      ctx.json(res, 200, result)
    } catch (error) {
      handlePhase2eError(error, ctx, res)
    }
  }),

  // -- Timeout scan (bounded pass) -----------------------------------------

  route("POST", "/operations/timeout-scan", async (req, res, _params, authn, _query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    try {
      if (!principal.admin) {
        ctx.json(res, 403, { error: { code: "FORBIDDEN", message: "operator privileges required for timeout scan" } })
        return
      }
      const telemetry = new AuditTelemetrySink(ctx.audit, "reliability-timeout")
      const svc = new TimeoutService({ service: ctx.service, store: ctx.automationStore, telemetry, tenantId: principal.tenantId })
      const result = await svc.scan()
      ctx.json(res, 200, result)
    } catch (error) {
      handlePhase2eError(error, ctx, res)
    }
  }),

  // -- Cooperative durable cancel ------------------------------------------

  route("POST", "/runs/:id/cancel", async (req, res, params, authn, _query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    try {
      const telemetry = new AuditTelemetrySink(ctx.audit, "reliability-cancel")
      const run = await requestCancellation(ctx.service, telemetry, principal.tenantId, params.id!)
      ctx.json(res, 200, { runId: run.runId, status: run.status })
    } catch (error) {
      handlePhase2eError(error, ctx, res)
    }
  }),

  // -- Readiness (liveness/readiness probe; never external-provider-dependent)

  route("GET", "/readiness", async (_req, res, _params, authn, _query, ctx) => {
    // Readiness does not require a tenant-scoped principal (it is a process
    // probe), but the authenticator must still have authenticated the caller.
    try {
      const health = new HealthService({ storage: new SqlStorageProbe(ctx.storage), ...(ctx.opsStore ? { opsStore: ctx.opsStore } : {}), ...(ctx.quotaStore ? { quotaStore: ctx.quotaStore } : {}), tenantId: authn.tenantId })
      ctx.json(res, 200, health.readiness())
    } catch (error) {
      handlePhase2eError(error, ctx, res)
    }
  }),

  // -- Tenant-safe operational health --------------------------------------

  route("GET", "/operations/health/reliability", async (req, res, _params, authn, _query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    try {
      const health = new HealthService({ storage: new SqlStorageProbe(ctx.storage), ...(ctx.opsStore ? { opsStore: ctx.opsStore } : {}), ...(ctx.quotaStore ? { quotaStore: ctx.quotaStore } : {}), tenantId: principal.tenantId })
      const report = await health.tenantHealth()
      ctx.json(res, 200, report)
    } catch (error) {
      handlePhase2eError(error, ctx, res)
    }
  }),
]
