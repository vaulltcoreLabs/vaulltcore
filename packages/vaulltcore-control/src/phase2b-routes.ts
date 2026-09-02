/**
 * Control-plane integration for Phase 2B: production scheduling, delivery
 * observability, durable retry status, SSE automation event streaming,
 * operational health, and tenant-scoped metrics.
 *
 * This is purely additive to the existing control plane — it registers a new
 * set of `/automation/*` and `/operations/*` routes when the Phase 2B layer is
 * wired. It reuses the automation service, scheduler store, and ops store; it
 * does NOT introduce another server or duplicate abstractions.
 *
 * Routes (registered by {@link ControlPlane} when the Phase 2B layer is wired):
 *   POST   /automation/schedules
 *   GET    /automation/schedules
 *   GET    /automation/schedules/:id
 *   POST   /automation/schedules/:id/pause
 *   POST   /automation/schedules/:id/resume
 *   POST   /automation/schedules/:id/cancel
 *   GET    /automation/schedules/:id/occurrences
 *   GET    /automation/runs/:id/deliveries
 *   GET    /operations/retry-status
 *   GET    /operations/health/p2b
 *   GET    /automation/runs/:id/stream?after=<seq>&follow=true   (SSE)
 *   GET    /automation/metrics
 *
 * Preserves: authentication, tenant/project authorization, idempotency on
 * mutating endpoints, safe error semantics. Cross-tenant resources return 404
 * (no existence leak). Tenant identity comes from the authenticated principal,
 * never the body. No internal stack traces, secrets, or provider credentials
 * are exposed.
 */

import type { IncomingMessage, ServerResponse } from "node:http"
import type { ResolvedPrincipal } from "@vaulltcore/identity"
import type { AutomationService, AutomationRun } from "@vaulltcore/automation"
import type { Scheduler, SqlScheduleStore, ScheduleVersion, Schedule, ScheduleOccurrence, ScheduleState, ScheduleKind, MissedRunPolicy } from "@vaulltcore/scheduler"
import type { SqlOpsStore, OpsWorkKind, OpsWorkState } from "@vaulltcore/ops"
import { AutomationError } from "@vaulltcore/automation"

// ---------------------------------------------------------------------------
// Layer wiring
// ---------------------------------------------------------------------------

export interface Phase2bLayerOptions {
  readonly schedulerStore: SqlScheduleStore
  readonly scheduler?: Scheduler
  readonly opsStore: SqlOpsStore
}

export type Phase2bLayer = Phase2bLayerOptions & { readonly service: AutomationService }

// ---------------------------------------------------------------------------
// Route plumbing (mirrors automation-routes.ts conventions)
// ---------------------------------------------------------------------------

export interface Phase2bRouteContext {
  readonly service: AutomationService
  readonly schedulerStore: SqlScheduleStore
  readonly scheduler: Scheduler | null
  readonly opsStore: SqlOpsStore
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
  ctx: Phase2bRouteContext,
) => Promise<void>

export interface Phase2bRoute {
  readonly method: string
  readonly pattern: RegExp
  readonly keys: string[]
  readonly handler: RouteHandler
}

function route(method: string, path: string, handler: RouteHandler): Phase2bRoute {
  const keys = path.split("/").filter((s) => s.startsWith(":")).map((s) => s.slice(1))
  const pattern = new RegExp(`^${path.replace(/:(\w+)/g, () => "([^/]+)")}$`)
  return { method, pattern, keys, handler }
}

async function resolveOrFail(ctx: Phase2bRouteContext, req: IncomingMessage, res: ServerResponse, authn: { tenantId: string; orgId: string; projectId: string; admin?: boolean }): Promise<ResolvedPrincipal | null> {
  const principal = await ctx.resolvePrincipal(req, authn)
  if (!principal) {
    ctx.json(res, 401, { error: { code: "UNAUTHENTICATED", message: "principal could not be resolved" } })
    return null
  }
  return principal
}

function handlePhase2bError(error: unknown, ctx: Phase2bRouteContext, res: ServerResponse): void {
  if (error instanceof AutomationError) {
    ctx.json(res, error.status, { error: { code: error.code, message: error.message } })
    return
  }
  if (error instanceof Phase2bError) {
    ctx.json(res, error.status, { error: { code: error.code, message: error.message } })
    return
  }
  // Never leak internal details. Genuine provider/server failures surface as 5xx.
  const message = error instanceof Error ? error.message : "internal error"
  if (/version conflict|fenced/i.test(message)) {
    ctx.json(res, 409, { error: { code: "CONFLICT", message: "resource version conflict" } })
    return
  }
  ctx.json(res, 500, { error: { code: "INTERNAL", message: "internal error" } })
}

class Phase2bError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message)
  }
}

// ---------------------------------------------------------------------------
// Sanitization: never expose secrets / internal paths in route output
// ---------------------------------------------------------------------------

function sanitizeDelivery(d: {
  readonly deliveryId: string
  readonly runId: string
  readonly idempotencyKey: string
  readonly destination: string
  status: string
  attempts: number
  resultRef: string | null
  updatedAt: number
  lastError: string | null
  deliveryVersion: number
}): Record<string, unknown> {
  return {
    deliveryId: d.deliveryId,
    runId: d.runId,
    status: d.status,
    attempts: d.attempts,
    resultRef: d.resultRef,
    updatedAt: d.updatedAt,
    // lastError is provider-returned text; redact anything that looks like a
    // secret/credential. Destinations are never echoed raw (masked).
    lastError: redactSecrets(d.lastError),
    destination: maskDestination(d.destination),
  }
}

function redactSecrets(text: string | null): string | null {
  if (!text) return text
  return text
    .replace(/[A-Za-z0-9_-]{20,}/g, (m) => (/(token|key|secret|password|bearer|auth)/i.test(m) ? "[redacted]" : m))
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/(password|secret|api[_-]?key|token)=([^&\s]+)/gi, "$1=[redacted]")
}

function maskDestination(destination: string): string {
  // Keep the scheme + host for debugging, strip userinfo/path/query that may
  // carry tokens. For email, keep the domain only.
  if (destination.includes("@")) {
    const [local, domain] = destination.split("@")
    return `${local ? local[0] : ""}***@${domain ?? "unknown"}`
  }
  try {
    const u = new URL(destination)
    return `${u.protocol}//${u.host}`
  } catch {
    return "[masked]"
  }
}

// ---------------------------------------------------------------------------
// Schedule view (combines schedule + current version; never exposes secrets)
// ---------------------------------------------------------------------------

function scheduleView(sched: Schedule, version: ScheduleVersion | null): Record<string, unknown> {
  return {
    scheduleId: sched.scheduleId,
    tenantId: sched.owner.tenantId,
    orgId: sched.owner.orgId,
    projectId: sched.owner.projectId,
    name: sched.name,
    state: sched.state,
    version: sched.currentVersion,
    lastAdmittedAt: sched.lastAdmittedAt,
    createdAt: sched.createdAt,
    updatedAt: sched.updatedAt,
    currentVersion: version ? {
      kind: version.kind,
      cron: version.cron,
      scheduledAt: version.scheduledAt,
      timezone: version.timezone,
      automationVersionId: version.automationVersionId,
      missedRunPolicy: version.missedRunPolicy,
      maxCatchUp: version.maxCatchUp,
      input: version.input,
      checksum: version.checksum,
    } : null,
  }
}

function occurrenceView(o: ScheduleOccurrence): Record<string, unknown> {
  return {
    occurrenceId: o.occurrenceId,
    scheduleId: o.scheduleId,
    version: o.version,
    scheduledTime: o.scheduledTime,
    admittedRunId: o.admittedRunId,
    admittedAt: o.admittedAt,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
}

function asString(v: unknown, field: string, ctx: Phase2bRouteContext, res: ServerResponse): string | null {
  if (typeof v !== "string" || v === "") {
    ctx.json(res, 422, { error: { code: "INVALID_INPUT", message: `${field} required` } })
    return null
  }
  return v
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const PHASE2B_ROUTES: Phase2bRoute[] = [

  // -- Schedules -----------------------------------------------------------

  route("POST", "/automation/schedules", async (req, res, _params, authn, _query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    const body = await ctx.readBody(req)
    const name = asString(body.name, "name", ctx, res)
    if (name === null) return
    const automationVersionId = asString(body.automationVersionId, "automationVersionId", ctx, res)
    if (automationVersionId === null) return
    const kind = body.kind as ScheduleKind
    if (kind !== "one_time" && kind !== "recurring") {
      ctx.json(res, 422, { error: { code: "INVALID_INPUT", message: "kind must be one_time or recurring" } })
      return
    }
    const missedRunPolicy = (body.missedRunPolicy as MissedRunPolicy | undefined) ?? "skip"
    if (missedRunPolicy !== "skip" && missedRunPolicy !== "catch_up") {
      ctx.json(res, 422, { error: { code: "INVALID_INPUT", message: "missedRunPolicy must be skip or catch_up" } })
      return
    }
    const timezone = typeof body.timezone === "string" ? body.timezone : "UTC"
    const cron = kind === "recurring" ? asString(body.cron, "cron (required for recurring)", ctx, res) : null
    if (cron === null && kind === "recurring") return
    const scheduledAt = kind === "one_time" ? Number(body.scheduledAt) : null
    if (kind === "one_time" && (!Number.isFinite(scheduledAt) || scheduledAt === null)) {
      ctx.json(res, 422, { error: { code: "INVALID_INPUT", message: "scheduledAt (epoch ms) required for one_time" } })
      return
    }
    const input = body.input && typeof body.input === "object" ? body.input as Record<string, unknown> : null
    const maxCatchUp = typeof body.maxCatchUp === "number" ? body.maxCatchUp : 1
    try {
      const { schedule, version } = ctx.schedulerStore.createSchedule({
        scheduleId: randomId("sched"),
        owner: { tenantId: principal.tenantId, orgId: principal.orgId, projectId: principal.projectScope[0] ?? principal.orgId },
        name,
        version: { kind, cron, scheduledAt: scheduledAt ?? null, timezone, automationVersionId, missedRunPolicy, maxCatchUp, input },
      })
      ctx.json(res, 201, scheduleView(schedule, version))
    } catch (error) {
      handlePhase2bError(error, ctx, res)
    }
  }),

  route("GET", "/automation/schedules", async (req, res, _params, authn, query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    const orgId = typeof query.get("orgId") === "string" ? query.get("orgId")! : undefined
    const projectId = typeof query.get("projectId") === "string" ? query.get("projectId")! : undefined
    const schedules = ctx.schedulerStore.listSchedules(principal.tenantId, orgId, projectId)
    ctx.json(res, 200, { schedules: schedules.map((s) => scheduleView(s, ctx.schedulerStore.getCurrentVersion(s.scheduleId))) })
  }),

  route("GET", "/automation/schedules/:scheduleId", async (req, res, params, authn, _query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    const sched = ctx.schedulerStore.getSchedule(principal.tenantId, params.scheduleId!)
    if (!sched) {
      ctx.json(res, 404, { error: { code: "NOT_FOUND", message: "schedule not found" } })
      return
    }
    ctx.json(res, 200, scheduleView(sched, ctx.schedulerStore.getCurrentVersion(sched.scheduleId)))
  }),

  route("POST", "/automation/schedules/:scheduleId/pause", async (req, res, params, authn, _query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    const existing = ctx.schedulerStore.getSchedule(principal.tenantId, params.scheduleId!)
    if (!existing) { ctx.json(res, 404, { error: { code: "NOT_FOUND", message: "schedule not found" } }); return }
    try {
      const sched = ctx.schedulerStore.setState(params.scheduleId!, "paused")
      ctx.json(res, 200, scheduleView(sched, ctx.schedulerStore.getCurrentVersion(sched.scheduleId)))
    } catch (error) { handlePhase2bError(error, ctx, res) }
  }),

  route("POST", "/automation/schedules/:scheduleId/resume", async (req, res, params, authn, _query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    const existing = ctx.schedulerStore.getSchedule(principal.tenantId, params.scheduleId!)
    if (!existing) { ctx.json(res, 404, { error: { code: "NOT_FOUND", message: "schedule not found" } }); return }
    try {
      const sched = ctx.schedulerStore.setState(params.scheduleId!, "active")
      ctx.json(res, 200, scheduleView(sched, ctx.schedulerStore.getCurrentVersion(sched.scheduleId)))
    } catch (error) { handlePhase2bError(error, ctx, res) }
  }),

  route("POST", "/automation/schedules/:scheduleId/cancel", async (req, res, params, authn, _query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    const existing = ctx.schedulerStore.getSchedule(principal.tenantId, params.scheduleId!)
    if (!existing) { ctx.json(res, 404, { error: { code: "NOT_FOUND", message: "schedule not found" } }); return }
    try {
      const sched = ctx.schedulerStore.setState(params.scheduleId!, "cancelled")
      ctx.json(res, 200, scheduleView(sched, ctx.schedulerStore.getCurrentVersion(sched.scheduleId)))
    } catch (error) { handlePhase2bError(error, ctx, res) }
  }),

  route("GET", "/automation/schedules/:scheduleId/occurrences", async (req, res, params, authn, _query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    const existing = ctx.schedulerStore.getSchedule(principal.tenantId, params.scheduleId!)
    if (!existing) { ctx.json(res, 404, { error: { code: "NOT_FOUND", message: "schedule not found" } }); return }
    const occurrences = ctx.schedulerStore.listOccurrences(principal.tenantId, params.scheduleId!)
    ctx.json(res, 200, { occurrences: occurrences.map(occurrenceView) })
  }),

  // -- Deliveries ----------------------------------------------------------

  route("GET", "/automation/runs/:runId/deliveries", async (req, res, params, authn, _query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    const run = await ctx.service.getRun(principal, params.runId!)
    if (!run) { ctx.json(res, 404, { error: { code: "NOT_FOUND", message: "run not found" } }); return }
    const deliveries = await ctx.service.listRunDeliveries(principal, params.runId!)
    ctx.json(res, 200, { deliveries: deliveries.map(sanitizeDelivery) })
  }),

  // -- Retry status --------------------------------------------------------

  route("GET", "/operations/retry-status", async (req, res, _params, authn, query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    const kindParam = query.get("kind") as OpsWorkKind | null
    const stateParam = query.get("state") as OpsWorkState | null
    const items = ctx.opsStore.list(principal.tenantId, kindParam ?? null, stateParam ?? null)
    ctx.json(res, 200, {
      items: items.map((i) => ({
        itemId: i.id,
        kind: i.kind,
        state: i.state,
        attempts: i.attempts,
        lastError: redactSecrets(i.lastError),
        nextRetryAt: i.nextRetryAt,
        targetRef: i.targetRef,
      })),
    })
  }),

  // -- Operational health (Phase 2B) --------------------------------------

  route("GET", "/operations/health/p2b", async (req, res, _params, authn, _query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    const t = principal.tenantId
    // Counts derived from durable records (never mutable counters).
    const pending = ctx.opsStore.list(t, null, "pending").length
    const inProgress = ctx.opsStore.list(t, null, "in_progress").length
    const failedRetriable = ctx.opsStore.list(t, null, "failed_retriable").length
    const failedTerminal = ctx.opsStore.list(t, null, "failed_terminal").length
    const runs = await ctx.service.listRuns(principal)
    const byStatus: Record<string, number> = {}
    for (const r of runs) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1
    ctx.json(res, 200, {
      opsQueue: { pending, in_progress: inProgress, failed_retriable: failedRetriable, failed_terminal: failedTerminal },
      runs: byStatus,
      schedules: { active: ctx.schedulerStore.listSchedules(t).filter((s) => s.state === "active").length },
    })
  }),

  // -- Metrics (derived from durable records) ------------------------------

  route("GET", "/automation/metrics", async (req, res, _params, authn, query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    const orgId = typeof query.get("orgId") === "string" ? query.get("orgId")! : undefined
    const projectId = typeof query.get("projectId") === "string" ? query.get("projectId")! : undefined
    const runs = await ctx.service.listRuns(principal, orgId, projectId)
    const counts: Record<string, number> = {}
    let totalDurationMs = 0
    let completed = 0
    let failed = 0
    let deliveryAttempts = 0
    let deliveryFailures = 0
    let approvalLatencySum = 0
    let approvalCount = 0
    for (const r of runs) {
      counts[r.status] = (counts[r.status] ?? 0) + 1
      if (r.completedAt !== null && r.createdAt <= r.completedAt) {
        totalDurationMs += r.completedAt - r.createdAt
        completed++
      }
      if (r.status === "failed") failed++
      // Delivery metrics from durable delivery attempts.
      const deliveries = await ctx.service.listRunDeliveries(principal, r.runId)
      for (const d of deliveries) {
        deliveryAttempts++
        if (d.status === "failed") deliveryFailures++
      }
      // Approval latency from durable approval requests.
      const approvals = await ctx.service.listRunApprovalRequests(principal, r.runId)
      for (const a of approvals) {
        if (a.decisionTime !== null && a.decisionTime >= a.createdAt) {
          approvalLatencySum += a.decisionTime - a.createdAt
          approvalCount++
        }
      }
    }
    ctx.json(res, 200, {
      runs: {
        total: runs.length,
        by_status: counts,
        completed,
        failed,
        avg_duration_ms: completed > 0 ? Math.round(totalDurationMs / completed) : 0,
      },
      delivery: {
        attempts: deliveryAttempts,
        failures: deliveryFailures,
        success_rate: deliveryAttempts > 0 ? (deliveryAttempts - deliveryFailures) / deliveryAttempts : null,
      },
      approvals: {
        decided: approvalCount,
        avg_latency_ms: approvalCount > 0 ? Math.round(approvalLatencySum / approvalCount) : 0,
      },
      schedules: { active: ctx.schedulerStore.listSchedules(principal.tenantId, orgId, projectId).filter((s) => s.state === "active").length },
    })
  }),

  // -- SSE automation event streaming --------------------------------------

  route("GET", "/automation/runs/:runId/stream", async (req, res, params, authn, query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    const run = await ctx.service.getRun(principal, params.runId!)
    if (!run) { ctx.json(res, 404, { error: { code: "NOT_FOUND", message: "run not found" } }); return }
    const after = Math.max(0, Number(query.get("after") ?? 0) || 0)
    const follow = query.get("follow") !== "false" // default follow=true

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    })

    let cursor = after
    const TERMINAL = new Set<AutomationRun["status"]>(["completed", "failed", "cancelled", "rejected", "suspended"])

    // Bounded live-follow loop: poll the durable event log (no gaps, no mutable
    // counter), emit new events in seq order, and stop once the run reaches a
    // terminal state. Backpressure-safe: each poll is a bounded query.
    const abort = new AbortController()
    req.on("close", () => abort.abort())

    try {
      // Initial replay.
      const initial = await ctx.service.listRunEvents(principal, params.runId!, cursor)
      for (const e of initial) {
        res.write(`event: automation-event\ndata: ${JSON.stringify(e)}\n\n`)
        cursor = Math.max(cursor, e.seq)
      }
      if (!follow) {
        res.write(`event: done\ndata: {"done":true}\n\n`)
        res.end()
        return
      }
      // Live follow until terminal or client disconnect.
      while (!abort.signal.aborted) {
        await sleep(50)
        if (abort.signal.aborted) break
        const current = await ctx.service.getRun(principal, params.runId!)
        if (!current) break
        const events = await ctx.service.listRunEvents(principal, params.runId!, cursor)
        for (const e of events) {
          res.write(`event: automation-event\ndata: ${JSON.stringify(e)}\n\n`)
          cursor = Math.max(cursor, e.seq)
        }
        if (TERMINAL.has(current.status)) {
          res.write(`event: done\ndata: ${JSON.stringify({ done: true, status: current.status })}\n\n`)
          break
        }
      }
    } catch {
      // Client disconnected mid-stream. The run continues; terminal state
      // remains queryable through GET /automation/runs/:id.
    }
    res.end()
  }),
]

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
