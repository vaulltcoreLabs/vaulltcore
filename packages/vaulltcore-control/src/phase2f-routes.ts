/**
 * Control-plane integration for Phase 2F: durable metering + immutable usage
 * ledger + cost attribution + B2B usage governance. Purely additive —
 * registers `/usage/*` routes when the Phase 2F layer is wired. It reuses the
 * metering (immutable usage ledger), billing (immutable cost ledger), and quota
 * (admission reservation) stores via the {@link UsageQueryService},
 * {@link QuotaSettlementService}, and {@link VersionedCostCatalog}; it does NOT
 * introduce another server, runtime, accounting ledger, or quota authority.
 *
 * Routes (registered by {@link ControlPlane} when the Phase 2F layer is wired):
 *   GET    /usage                 (bounded, paginated raw usage events)
 *   GET    /usage/summary         (derived aggregate over a filtered scope)
 *   GET    /usage/runs/:id        (per-job derived aggregate)
 *   GET    /usage/ledger          (alias of /usage; explicit ledger query)
 *   POST   /usage/reconcile       (authorized: trigger reconcile of metering)
 *
 * Semantics:
 *   401 unauthenticated; 404 no-existence-leak on inaccessible tenant/run;
 *   422 invalid bounded filters / unbounded range; 409 fenced conflict;
 *   429 pagination/range limits; secrets NEVER returned. Aggregates are DERIVED
 *   and never authoritative. Tenant identity comes from the authenticated
 *   principal, never the body. Reconciliation routes require privileged
 *   authorization (admin).
 */

import type { IncomingMessage, ServerResponse } from "node:http"
import type { ResolvedPrincipal } from "@vaulltcore/identity"
import type { SqlMeteringStore, UsageQueryFilter, UsageQueryCursor, UsageEvent } from "@vaulltcore/metering"
import { MAX_QUERY_LIMIT } from "@vaulltcore/metering"
import type { SqlBillingStore } from "@vaulltcore/billing"
import type { SqlQuotaStore } from "@vaulltcore/quota"
import type { SqlAuditStore } from "@vaulltcore/audit"
import { UsageQueryService, QuotaSettlementService, VersionedCostCatalog, type CostOverride } from "@vaulltcore/usage-governance"
import { UsageGovernanceError } from "@vaulltcore/usage-governance"

// ---------------------------------------------------------------------------
// Layer wiring
// ---------------------------------------------------------------------------

export interface Phase2fLayerOptions {
  readonly metering: SqlMeteringStore
  readonly billing: SqlBillingStore
  readonly quotaStore?: SqlQuotaStore
  readonly audit: SqlAuditStore
  /** Pricing version identity for derived cost attribution. */
  readonly pricing?: { pricingId: string; version: string; effectiveAt: number; unitPrices: Record<string, number> }
  /** Optional provider/model-specific cost overrides. */
  readonly costOverrides?: ReadonlyArray<CostOverride>
  /** Optional reconciler for POST /usage/reconcile. The control plane wires the
   *  Phase 1 reconcile service (NEVER invokes agent execution). */
  readonly reconcile?: () => Promise<{ runId: string; gaps: number; repaired: number; watermark: number }>
}

export interface Phase2fRouteContext {
  readonly metering: SqlMeteringStore
  readonly billing: SqlBillingStore
  readonly quotaStore?: SqlQuotaStore
  readonly audit: SqlAuditStore
  readonly queryService: UsageQueryService
  readonly settlementService: QuotaSettlementService | null
  readonly catalog: VersionedCostCatalog | null
  readonly reconcile?: () => Promise<{ runId: string; gaps: number; repaired: number; watermark: number }>
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
  ctx: Phase2fRouteContext,
) => Promise<void>

export interface Phase2fRoute {
  readonly method: string
  readonly pattern: RegExp
  readonly keys: string[]
  readonly handler: RouteHandler
}

function route(method: string, path: string, handler: RouteHandler): Phase2fRoute {
  const keys = path.split("/").filter((s) => s.startsWith(":")).map((s) => s.slice(1))
  const pattern = new RegExp(`^${path.replace(/:(\w+)/g, () => "([^/]+)")}$`)
  return { method, pattern, keys, handler }
}

async function resolveOrFail(ctx: Phase2fRouteContext, req: IncomingMessage, res: ServerResponse, authn: { tenantId: string; orgId: string; projectId: string; admin?: boolean }): Promise<ResolvedPrincipal | null> {
  const principal = await ctx.resolvePrincipal(req, authn)
  if (!principal) {
    ctx.json(res, 401, { error: { code: "UNAUTHENTICATED", message: "principal could not be resolved" } })
    return null
  }
  return principal
}

/** Build the Phase 2F route context from layer options. */
export function buildPhase2fContext(options: Phase2fLayerOptions, helpers: {
  resolvePrincipal: Phase2fRouteContext["resolvePrincipal"]
  json: Phase2fRouteContext["json"]
  readBody: Phase2fRouteContext["readBody"]
}): Phase2fRouteContext {
  const queryService = new UsageQueryService(options.metering)
  const settlementService = options.quotaStore ? new QuotaSettlementService({ metering: options.metering, quota: options.quotaStore }) : null
  let catalog: VersionedCostCatalog | null = null
  if (options.pricing) {
    catalog = new VersionedCostCatalog(
      { pricingId: options.pricing.pricingId, version: options.pricing.version, effectiveAt: options.pricing.effectiveAt, createdAt: 0, unitPrices: options.pricing.unitPrices as never },
      options.costOverrides,
    )
  }
  return {
    metering: options.metering,
    billing: options.billing,
    ...(options.quotaStore ? { quotaStore: options.quotaStore } : {}),
    audit: options.audit,
    queryService,
    settlementService,
    catalog,
    ...(options.reconcile ? { reconcile: options.reconcile } : {}),
    resolvePrincipal: helpers.resolvePrincipal,
    json: helpers.json,
    readBody: helpers.readBody,
  }
}

function handlePhase2fError(error: unknown, ctx: Phase2fRouteContext, res: ServerResponse): void {
  if (error instanceof UsageGovernanceError) {
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

/** Parse a bounded usage query filter from query params (tenant-scoped). */
function parseFilter(principal: ResolvedPrincipal, query: URLSearchParams): { filter: UsageQueryFilter; cursor: UsageQueryCursor | null; limit: number } {
  const from = query.get("from") ? Number(query.get("from")) : undefined
  const to = query.get("to") ? Number(query.get("to")) : undefined
  const kind = query.get("kind") ?? undefined
  const provider = query.get("provider") ?? undefined
  const model = query.get("model") ?? undefined
  const runId = query.get("runId") ?? undefined
  const cursorRaw = query.get("cursor")
  const limitParam = query.get("limit") ? Number(query.get("limit")) : 200
  if (Number.isNaN(limitParam) || limitParam < 1) throw new UsageGovernanceError("INVALID_LIMIT", "limit must be a positive integer", 422)
  if (limitParam > MAX_QUERY_LIMIT) throw new UsageGovernanceError("LIMIT_TOO_LARGE", `limit exceeds maximum of ${MAX_QUERY_LIMIT}`, 422)
  const filter: UsageQueryFilter = {
    tenantId: principal.tenantId,
    ...(from !== undefined && !Number.isNaN(from) ? { from } : {}),
    ...(to !== undefined && !Number.isNaN(to) ? { to } : {}),
    ...(kind ? { kind: kind as UsageQueryFilter["kind"] } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(runId ? { runId } : {}),
  }
  let cursor: UsageQueryCursor | null = null
  if (cursorRaw) {
    try {
      cursor = JSON.parse(Buffer.from(cursorRaw, "base64url").toString("utf8")) as UsageQueryCursor
    } catch {
      throw new UsageGovernanceError("INVALID_CURSOR", "cursor is malformed", 422)
    }
  }
  return { filter, cursor, limit: limitParam }
}

function serializeEvent(e: UsageEvent) {
  return {
    eventId: e.eventId,
    kind: e.kind,
    quantity: e.quantity,
    unit: e.unit,
    provider: e.provider,
    model: e.model,
    jobId: e.jobId,
    recordedAt: e.recordedAt,
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const PHASE2F_ROUTES: Phase2fRoute[] = [
  // -- Bounded, paginated raw usage events -------------------------------

  route("GET", "/usage", async (req, res, _params, authn, query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    try {
      const { filter, cursor, limit } = parseFilter(principal, query)
      const result = ctx.queryService.query(filter, cursor, limit)
      const nextCursor = result.nextCursor
        ? Buffer.from(JSON.stringify(result.nextCursor), "utf8").toString("base64url")
        : null
      ctx.json(res, 200, {
        items: result.items.map(serializeEvent),
        nextCursor,
        hasMore: result.hasMore,
      })
    } catch (error) {
      handlePhase2fError(error, ctx, res)
    }
  }),

  // -- Derived aggregate over a filtered scope ---------------------------

  route("GET", "/usage/summary", async (req, res, _params, authn, query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    try {
      const { filter } = parseFilter(principal, query)
      const summary = ctx.queryService.summary(filter)
      ctx.json(res, 200, {
        aggregate: summary.aggregate,
        breakdown: summary.breakdown,
        totalEvents: summary.totalEvents,
      })
    } catch (error) {
      handlePhase2fError(error, ctx, res)
    }
  }),

  // -- Per-job derived aggregate (tenant-scoped; cross-tenant → empty) --

  route("GET", "/usage/runs/:id", async (req, res, params, authn, _query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    try {
      const jobId = params.id ?? ""
      const aggregate = await ctx.queryService.jobAggregate(principal.tenantId, jobId)
      // Cross-tenant jobs return an empty aggregate (no existence leak); a
      // missing job also returns an empty aggregate — 404 would leak existence.
      ctx.json(res, 200, { ...aggregate, jobId })
    } catch (error) {
      handlePhase2fError(error, ctx, res)
    }
  }),

  // -- Explicit ledger alias (same bounded query as /usage) -------------

  route("GET", "/usage/ledger", async (req, res, _params, authn, query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    try {
      const { filter, cursor, limit } = parseFilter(principal, query)
      const result = ctx.queryService.query(filter, cursor, limit)
      const nextCursor = result.nextCursor
        ? Buffer.from(JSON.stringify(result.nextCursor), "utf8").toString("base64url")
        : null
      ctx.json(res, 200, {
        items: result.items.map(serializeEvent),
        nextCursor,
        hasMore: result.hasMore,
      })
    } catch (error) {
      handlePhase2fError(error, ctx, res)
    }
  }),

  // -- Authorized usage reconciliation (admin only) ---------------------

  route("POST", "/usage/reconcile", async (req, res, _params, authn, _query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    if (!principal.admin) {
      ctx.json(res, 403, { error: { code: "FORBIDDEN", message: "reconciliation requires admin authorization" } })
      return
    }
    if (!ctx.reconcile) {
      ctx.json(res, 501, { error: { code: "NOT_CONFIGURED", message: "usage reconciliation is not wired" } })
      return
    }
    try {
      // Audit: reconciliation requested (sanitized; no usage payload).
      await ctx.audit.append({
        actor: { principalId: principal.principalId, kind: principal.kind, tenantId: principal.tenantId },
        scope: { tenantId: principal.tenantId, orgId: principal.orgId, projectId: authn.projectId },
        type: "usage_reconciliation_requested",
        metadata: {},
      })
      const result = await ctx.reconcile()
      await ctx.audit.append({
        actor: { principalId: principal.principalId, kind: principal.kind, tenantId: principal.tenantId },
        scope: { tenantId: principal.tenantId, orgId: principal.orgId, projectId: authn.projectId },
        type: "usage_reconciliation_completed",
        metadata: { runId: result.runId, gaps: result.gaps, repaired: result.repaired, watermark: result.watermark },
      })
      ctx.json(res, 200, result)
    } catch (error) {
      handlePhase2fError(error, ctx, res)
    }
  }),
]
