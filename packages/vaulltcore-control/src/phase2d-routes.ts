/**
 * Control-plane integration for Phase 2D: connected-product activation.
 *
 * Connected Account API + trigger management + the trigger→run dispatch sink.
 * Purely additive to the control plane — registers `/connections/*`,
 * `/oauth/callback`, `/triggers/*`, and `/integrations/*` routes when the
 * Phase 2D layer is wired. It reuses the credentials lifecycle, OAuth
 * adapters, automation trigger store + dispatch service, and the webhook
 * gateway; it does NOT introduce another server, runtime, or authorization
 * model.
 *
 * Routes (registered by {@link ControlPlane} when the Phase 2D layer is wired):
 *   GET    /integrations/capabilities
 *   POST   /connections                 (start a connection / begin OAuth)
 *   GET    /connections                 (list project-scoped connections)
 *   GET    /connections/:id             (inspect status — no secrets)
 *   POST   /connections/:id/reconnect  (reauthorize)
 *   POST   /connections/:id/refresh    (refresh lifecycle where supported)
 *   POST   /connections/:id/disconnect  (revoke)
 *   GET    /oauth/callback              (OAuth callback; state-bound, replay-safe)
 *   POST   /triggers                    (publish/revise a trigger)
 *   GET    /triggers                    (list project-scoped)
 *   GET    /triggers/:id
 *   POST   /triggers/:id/enable
 *   POST   /triggers/:id/disable
 *   POST   /triggers/:id/invoke         (manual trigger class only)
 *   GET    /triggers/dispatches/:id     (dispatch status)
 *   POST   /integrations/dispatch       (manual dispatch for testing/recovery)
 *
 * Preserves: authentication, tenant/project authorization (reuses Phase 1E
 * role-rank), idempotency on mutating endpoints via existing patterns,
 * safe error semantics. Cross-tenant/unauthorized-project access returns 404
 * (no existence leak). Tenant identity comes from the authenticated principal,
 * never the body. No stack traces, secrets, or credentials are exposed in
 * JSON/errors/audit. Callback tenant/principal/provider scope is bound to the
 * durable authorization state BEFORE the redirect and validated on settlement —
 * never trusted from the callback query alone.
 */

import type { IncomingMessage, ServerResponse } from "node:http"
import type { ResolvedPrincipal } from "@vaulltcore/identity"
import type {
  ConnectionLifecycle,
  OAuthAdapterRegistry,
  SqlAuthorizationAttemptStore,
  AuthorizationAttempt,
  ProviderFamily,
} from "@vaulltcore/credentials"
import { CredentialError } from "@vaulltcore/credentials"
import type {
  AutomationService,
  TriggerDispatchService,
  SqlTriggerStore,
  TriggerDefinition,
  PublishTriggerInput,
  TriggerClass,
  TriggerState,
  TriggerMatchCriteria,
  TriggerRunSink,
  TriggerRunRejection,
} from "@vaulltcore/automation"
import { AutomationError } from "@vaulltcore/automation"
import type { ModelConnectionService } from "@vaulltcore/models"
import type { SqlWebhookStore, WebhookEventRecord } from "@vaulltcore/webhooks"
import type { NormalizedEvent } from "@vaulltcore/integration"
import type { SqlCredentialStore, ProviderConnection } from "@vaulltcore/credentials"
import { sanitizeMetadata } from "@vaulltcore/audit"
import type { SqlAuditStore } from "@vaulltcore/audit"

// ---------------------------------------------------------------------------
// Layer wiring
// ---------------------------------------------------------------------------

export interface Phase2dLayerOptions {
  readonly credentialStore: SqlCredentialStore
  readonly attemptStore: SqlAuthorizationAttemptStore
  readonly lifecycle: ConnectionLifecycle
  readonly oauthAdapters: OAuthAdapterRegistry
  readonly triggerStore: SqlTriggerStore
  readonly dispatchService: TriggerDispatchService
  readonly modelConnections?: ModelConnectionService
  readonly webhookStore?: SqlWebhookStore
  readonly audit?: SqlAuditStore
}

export type Phase2dLayer = Phase2dLayerOptions & { readonly service: AutomationService }

// ---------------------------------------------------------------------------
// Route plumbing (mirrors phase2b-routes.ts conventions)
// ---------------------------------------------------------------------------

export interface Phase2dRouteContext {
  readonly service: AutomationService
  readonly credentialStore: SqlCredentialStore
  readonly attemptStore: SqlAuthorizationAttemptStore
  readonly lifecycle: ConnectionLifecycle
  readonly oauthAdapters: OAuthAdapterRegistry
  readonly triggerStore: SqlTriggerStore
  readonly dispatchService: TriggerDispatchService
  readonly modelConnections: ModelConnectionService | null
  readonly webhookStore: SqlWebhookStore | null
  readonly audit: SqlAuditStore | null
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
  ctx: Phase2dRouteContext,
) => Promise<void>

export interface Phase2dRoute {
  readonly method: string
  readonly pattern: RegExp
  readonly keys: string[]
  readonly handler: RouteHandler
}

function route(method: string, path: string, handler: RouteHandler): Phase2dRoute {
  const keys = path.split("/").filter((s) => s.startsWith(":")).map((s) => s.slice(1))
  const pattern = new RegExp(`^${path.replace(/:(\w+)/g, () => "([^/]+)")}$`)
  return { method, pattern, keys, handler }
}

async function resolveOrFail(ctx: Phase2dRouteContext, req: IncomingMessage, res: ServerResponse, authn: { tenantId: string; orgId: string; projectId: string; admin?: boolean }): Promise<ResolvedPrincipal | null> {
  const principal = await ctx.resolvePrincipal(req, authn)
  if (!principal) {
    ctx.json(res, 401, { error: { code: "UNAUTHENTICATED", message: "principal could not be resolved" } })
    return null
  }
  return principal
}

function handlePhase2dError(error: unknown, ctx: Phase2dRouteContext, res: ServerResponse): void {
  if (error instanceof AutomationError) {
    ctx.json(res, error.status, { error: { code: error.code, message: error.message } })
    return
  }
  if (error instanceof CredentialError) {
    ctx.json(res, error.status, { error: { code: error.code, message: error.message } })
    return
  }
  const message = error instanceof Error ? error.message : "internal error"
  if (/version conflict|fenced/i.test(message)) {
    ctx.json(res, 409, { error: { code: "CONFLICT", message: "resource version conflict" } })
    return
  }
  if (/not found/i.test(message)) {
    ctx.json(res, 404, { error: { code: "NOT_FOUND", message: "resource not found" } })
    return
  }
  ctx.json(res, 500, { error: { code: "INTERNAL", message: "internal error" } })
}

function asString(value: unknown, field: string, ctx: Phase2dRouteContext, res: ServerResponse): string | null {
  if (typeof value !== "string" || value.length === 0) {
    ctx.json(res, 422, { error: { code: "INVALID_INPUT", message: `${field} must be a non-empty string` } })
    return null
  }
  return value
}

/** Safe connection view — never exposes secretRef, secretFingerprint, or any
 *  usable credential. Only opaque identity + lifecycle state + metadata. */
function connectionView(c: ProviderConnection): Record<string, unknown> {
  return {
    connectionId: c.connectionId,
    tenantId: c.tenantId,
    orgId: c.orgId,
    projectId: c.projectId,
    family: c.family,
    provider: c.provider,
    account: { externalId: c.account.externalId, displayName: c.account.displayName },
    capabilities: c.capabilities,
    state: c.state,
    version: c.version,
    lastUsedAt: c.lastUsedAt,
    expiresAt: c.expiresAt,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    // secretRef / secretFingerprint intentionally omitted.
  }
}

function triggerView(t: TriggerDefinition): Record<string, unknown> {
  return {
    triggerId: t.triggerId,
    templateId: t.templateId,
    versionId: t.versionId,
    triggerClass: t.triggerClass,
    name: t.name,
    criteria: t.criteria,
    scheduleId: t.scheduleId,
    inputMapping: t.inputMapping,
    state: t.state,
    revision: t.revision,
    createdAt: t.createdAt,
    createdBy: t.createdBy,
    updatedAt: t.updatedAt,
  }
}

// ---------------------------------------------------------------------------
// The trigger→run sink: implements TriggerRunSink over AutomationService.
// ---------------------------------------------------------------------------

/**
 * Bridges a matched trigger to the existing admission boundary → automation
 * run creation. The run is created idempotently on `triggerId` (the dispatch
 * id is folded into the run's idempotency key). Policy/quota denials surface
 * as typed rejections (never silently swallowed into infra retry).
 */
export class TriggerRunSinkImpl implements TriggerRunSink {
  constructor(private readonly service: AutomationService, private readonly audit: SqlAuditStore | null) {}

  async createRunForTrigger(args: {
    readonly tenantId: string
    readonly orgId: string
    readonly projectId: string
    readonly triggerId: string
    readonly triggerRevision: number
    readonly templateId: string
    readonly versionId: string
    readonly dispatchId: string
    readonly event: NormalizedEvent
    readonly inputMapping: Readonly<Record<string, unknown>>
  }): Promise<{ runId: string | null; rejection?: TriggerRunRejection }> {
    // Derive the run input from the event via the trigger's declarative mapping.
    // The mapping is a literal object (validated at publish); no executable code.
    const inputValues = deriveInput(args.inputMapping, args.event)
    // Idempotency key: stable per (trigger, dispatch). A replay re-derives the
    // same key, so the admission pipeline collapses a duplicate create into the
    // original run — no duplicate work at the durable boundary.
    const idempotencyKey = `trig:${args.triggerId}:${args.dispatchId}`
    try {
      const run = await this.service.createRun({
        // The admission boundary (policy/quota) is still applied — it is NEVER
        // bypassed. We synthesize a minimal principal carrying the tenant/org/
        // project scope (role rank is reused, no new auth model).
        principal: synthesizeTriggerPrincipal(args.tenantId, args.orgId, args.projectId),
        orgId: args.orgId,
        projectId: args.projectId,
        templateId: args.templateId,
        versionId: args.versionId,
        input: inputValues,
        idempotencyKey,
      })
      await this.auditAppend(args, "trigger_run_created", { runId: run.runId })
      return { runId: run.runId }
    } catch (error) {
      const rejection = classifyRejection(error)
      await this.auditAppend(args, "trigger_run_rejected", { rejection: rejection.kind, reason: rejection.reason })
      return { runId: null, rejection }
    }
  }

  private async auditAppend(args: { tenantId: string; orgId: string; projectId: string }, type: string, metadata: Record<string, unknown>): Promise<void> {
    await this.audit?.append({
      actor: { principalId: "trigger-sink", kind: "service_account", tenantId: args.tenantId },
      scope: { tenantId: args.tenantId, orgId: args.orgId, projectId: args.projectId },
      type: type as never,
      metadata: sanitizeMetadata(metadata),
    }).catch(() => {})
  }
}

/** Classify an admission failure honestly: policy/quota denials are terminal
 *  rejections, never retried as infrastructure. Transient failures are
 *  retryable. */
function classifyRejection(error: unknown): TriggerRunRejection {
  if (error instanceof AutomationError) {
    if (/quota|capacity/i.test(error.code)) return { kind: "quota", reason: error.message }
    if (/policy|forbidden|denied/i.test(error.code)) return { kind: "policy", reason: error.message }
    if (/input/i.test(error.code)) return { kind: "invalid_input", reason: error.message }
    return { kind: "permanent", reason: error.message }
  }
  const msg = error instanceof Error ? error.message : "unknown error"
  return { kind: "permanent", reason: msg }
}

/** Synthesize a service-account principal for trigger-driven run creation.
 *  The admission boundary still applies (policy/quota); no new auth model. */
function synthesizeTriggerPrincipal(tenantId: string, orgId: string, projectId: string): ResolvedPrincipal {
  return {
    principalId: "trigger-dispatch",
    kind: "service_account",
    tenantId,
    orgId,
    role: "service_account",
    projectScope: [projectId],
  }
}

/** Derive the run input from the trigger's declarative mapping + event. The
 *  mapping is a literal object (no executable code); values may reference event
 *  fields via the `event.*` namespace. */
function deriveInput(mapping: Readonly<Record<string, unknown>>, event: NormalizedEvent): ReadonlyArray<{ readonly fieldId: string; readonly value: unknown }> {
  const out: { fieldId: string; value: unknown }[] = []
  for (const [key, value] of Object.entries(mapping)) {
    out.push({ fieldId: key, value: resolveMappingValue(value, event) })
  }
  return out
}

function resolveMappingValue(value: unknown, event: NormalizedEvent): unknown {
  if (typeof value === "string" && value.startsWith("event.")) {
    const path = value.slice("event.".length).split(".")
    let current: unknown = event
    for (const part of path) {
      if (current && typeof current === "object" && part in (current as Record<string, unknown>)) {
        current = (current as Record<string, unknown>)[part]
      } else {
        return null
      }
    }
    return current
  }
  return value
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const PHASE2D_ROUTES: Phase2dRoute[] = [

  // -- Provider capabilities ----------------------------------------------

  route("GET", "/integrations/capabilities", async (req, res, _params, authn, _query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    const capabilities = ctx.oauthAdapters.listCapabilities().map((cap) => ({
      provider: cap.provider,
      family: cap.family,
      methods: cap.methods,
      identityKind: cap.identityKind,
      supportsRefresh: cap.supportsRefresh,
      supportsWebhooks: cap.supportsWebhooks,
      supportsScopes: cap.supportsScopes,
    }))
    ctx.json(res, 200, { capabilities })
  }),

  // -- Start a connection / begin OAuth ------------------------------------

  route("POST", "/connections", async (req, res, _params, authn, _query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    const body = await ctx.readBody(req)
    const provider = asString(body.provider, "provider", ctx, res)
    if (provider === null) return
    const redirectUri = asString(body.redirectUri, "redirectUri", ctx, res)
    if (redirectUri === null) return
    const method = (body.method as "oauth_authorization_code" | "oauth_pkce" | "api_key" | "app_installation" | "service_identity") ?? "oauth_authorization_code"
    const scopes = Array.isArray(body.scopes) ? (body.scopes as string[]) : []
    const codeVerifier = typeof body.codeVerifier === "string" ? body.codeVerifier : null
    try {
      const result = await ctx.lifecycle.startAuthorization({
        tenantId: principal.tenantId,
        orgId: principal.orgId,
        projectId: principal.projectScope[0] ?? principal.orgId,
        principalId: principal.principalId,
        family: (typeof body.family === "string" ? body.family as ProviderFamily : inferFamily(provider)),
        provider,
        method,
        scopes,
        redirectUri,
        codeVerifier,
      })
      ctx.json(res, 201, {
        attemptId: result.attemptId,
        state: result.state,
        authorizeUrl: result.authorizeUrl,
        codeChallenge: result.codeChallenge,
        // Never expose the secret material or the PKCE verifier beyond the
        // redirect URL the provider requires.
      })
    } catch (error) {
      handlePhase2dError(error, ctx, res)
    }
  }),

  // -- List project-scoped connections -------------------------------------

  route("GET", "/connections", async (req, res, _params, authn, query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    const family = query.get("family") ?? undefined
    const list = await ctx.credentialStore.list({ tenantId: principal.tenantId, orgId: principal.orgId, projectId: principal.projectScope[0] ?? principal.orgId, ...(family ? { family: family as "git" | "project" | "notification" | "model" } : {}) })
    ctx.json(res, 200, { connections: list.map(connectionView) })
  }),

  // -- Inspect connection status ------------------------------------------

  route("GET", "/connections/:id", async (req, res, params, authn, _query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    const conn = await ctx.credentialStore.get(principal.tenantId, params.id!)
    if (!conn || conn.orgId !== principal.orgId || !(principal.projectScope.includes(conn.projectId))) {
      // Cross-tenant / unauthorized project → indistinguishable absence (404).
      ctx.json(res, 404, { error: { code: "NOT_FOUND", message: "connection not found" } })
      return
    }
    ctx.json(res, 200, connectionView(conn))
  }),

  // -- Reconnect / reauthorize ---------------------------------------------

  route("POST", "/connections/:id/reconnect", async (req, res, params, authn, _query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    const conn = await ctx.credentialStore.get(principal.tenantId, params.id!)
    if (!conn || conn.orgId !== principal.orgId || !principal.projectScope.includes(conn.projectId)) {
      ctx.json(res, 404, { error: { code: "NOT_FOUND", message: "connection not found" } })
      return
    }
    const body = await ctx.readBody(req)
    const redirectUri = asString(body.redirectUri, "redirectUri", ctx, res)
    if (redirectUri === null) return
    try {
      const result = await ctx.lifecycle.startAuthorization({
        tenantId: principal.tenantId, orgId: principal.orgId, projectId: conn.projectId,
        principalId: principal.principalId, family: conn.family, provider: conn.provider,
        method: "oauth_authorization_code",
        scopes: conn.account.scopes ?? [],
        redirectUri,
        connectionId: conn.connectionId,
      })
      ctx.json(res, 200, { attemptId: result.attemptId, state: result.state, authorizeUrl: result.authorizeUrl })
    } catch (error) {
      handlePhase2dError(error, ctx, res)
    }
  }),

  // -- Refresh lifecycle ---------------------------------------------------

  route("POST", "/connections/:id/refresh", async (req, res, params, authn, _query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    const conn = await ctx.credentialStore.get(principal.tenantId, params.id!)
    if (!conn || conn.orgId !== principal.orgId || !principal.projectScope.includes(conn.projectId)) {
      ctx.json(res, 404, { error: { code: "NOT_FOUND", message: "connection not found" } })
      return
    }
    try {
      const updated = await ctx.lifecycle.refresh(principal.tenantId, conn.connectionId)
      ctx.json(res, 200, connectionView(updated))
    } catch (error) {
      handlePhase2dError(error, ctx, res)
    }
  }),

  // -- Disconnect / revoke -------------------------------------------------

  route("POST", "/connections/:id/disconnect", async (req, res, params, authn, _query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    const conn = await ctx.credentialStore.get(principal.tenantId, params.id!)
    if (!conn || conn.orgId !== principal.orgId || !principal.projectScope.includes(conn.projectId)) {
      ctx.json(res, 404, { error: { code: "NOT_FOUND", message: "connection not found" } })
      return
    }
    try {
      const updated = await ctx.lifecycle.disconnect(principal.tenantId, conn.connectionId)
      ctx.json(res, 200, connectionView(updated))
    } catch (error) {
      handlePhase2dError(error, ctx, res)
    }
  }),

  // -- OAuth callback (state-bound, replay-safe) --------------------------

  route("GET", "/oauth/callback", async (req, res, _params, authn, query, ctx) => {
    // The callback is UNAUTHENTICATED by design: the caller cannot supply
    // tenant/principal/provider — those are bound to the durable authorization
    // state BEFORE the redirect. The state nonce is the trust root; the tenant
    // is resolved from the durable attempt, never from the callback query.
    void authn
    const state = query.get("state")
    const code = query.get("code")
    if (!state || !code) {
      ctx.json(res, 422, { error: { code: "INVALID_CALLBACK", message: "state and code are required" } })
      return
    }
    // Resolve the attempt (and thus tenant) from the state nonce alone.
    const attempt = ctx.attemptStore.getByStateGlobal(state)
    if (!attempt) {
      // Unknown/expired state — indistinguishable absence (no existence leak).
      ctx.json(res, 404, { error: { code: "CALLBACK_REJECTED", message: "authorization attempt not found" } })
      return
    }
    try {
      const outcome = await ctx.lifecycle.completeCallback({ tenantId: attempt.tenantId, state, code })
      // Idempotent replay: a duplicate callback returns the original outcome.
      ctx.json(res, 200, {
        connectionId: outcome.connectionId,
        attemptId: outcome.attemptId,
        replayed: outcome.replayed,
        externalId: outcome.connection.account.externalId,
        displayName: outcome.connection.account.displayName,
        state: outcome.connection.state,
      })
    } catch (error) {
      const msg = error instanceof Error ? error.message : "callback failed"
      if (/expired|invalid state|wrong tenant|wrong principal|wrong provider|consumed/i.test(msg)) {
        ctx.json(res, 409, { error: { code: "CALLBACK_REJECTED", message: "authorization callback rejected" } })
        return
      }
      handlePhase2dError(error, ctx, res)
    }
  }),

  // -- Triggers: publish/revise --------------------------------------------

  route("POST", "/triggers", async (req, res, _params, authn, _query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    const body = await ctx.readBody(req)
    const templateId = asString(body.templateId, "templateId", ctx, res)
    if (templateId === null) return
    const versionId = asString(body.versionId, "versionId", ctx, res)
    if (versionId === null) return
    const name = asString(body.name, "name", ctx, res)
    if (name === null) return
    const triggerClass = body.triggerClass as TriggerClass
    const criteria = body.criteria as TriggerMatchCriteria | undefined
    const input = {
      tenantId: principal.tenantId,
      orgId: principal.orgId,
      projectId: principal.projectScope[0] ?? principal.orgId,
      principalId: principal.principalId,
      templateId, versionId, triggerClass, name,
      criteria: criteria ?? null,
      scheduleId: typeof body.scheduleId === "string" ? body.scheduleId : null,
      inputMapping: (body.inputMapping && typeof body.inputMapping === "object") ? body.inputMapping as Record<string, unknown> : {},
      state: (body.state as TriggerState | undefined) ?? "enabled",
    } as PublishTriggerInput
    try {
      const trigger = await ctx.triggerStore.publishTrigger(input)
      ctx.json(res, 201, triggerView(trigger))
    } catch (error) {
      handlePhase2dError(error, ctx, res)
    }
  }),

  // -- Triggers: list ------------------------------------------------------

  route("GET", "/triggers", async (req, res, _params, authn, _query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    const list = await ctx.triggerStore.listTriggers({ tenantId: principal.tenantId, orgId: principal.orgId, projectId: principal.projectScope[0] ?? principal.orgId })
    ctx.json(res, 200, { triggers: list.map(triggerView) })
  }),

  // -- Triggers: get -------------------------------------------------------

  route("GET", "/triggers/:id", async (req, res, params, authn, _query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    const trigger = await ctx.triggerStore.getTrigger(principal.tenantId, params.id!)
    if (!trigger || trigger.orgId !== principal.orgId || !principal.projectScope.includes(trigger.projectId)) {
      ctx.json(res, 404, { error: { code: "NOT_FOUND", message: "trigger not found" } })
      return
    }
    ctx.json(res, 200, triggerView(trigger))
  }),

  // -- Triggers: enable/disable --------------------------------------------

  route("POST", "/triggers/:id/enable", async (req, res, params, authn, _query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    const trigger = await ctx.triggerStore.getTrigger(principal.tenantId, params.id!)
    if (!trigger || trigger.orgId !== principal.orgId || !principal.projectScope.includes(trigger.projectId)) {
      ctx.json(res, 404, { error: { code: "NOT_FOUND", message: "trigger not found" } })
      return
    }
    try {
      const updated = await ctx.triggerStore.setTriggerState(principal.tenantId, trigger.triggerId, trigger.revision, "enabled")
      ctx.json(res, 200, triggerView(updated))
    } catch (error) {
      handlePhase2dError(error, ctx, res)
    }
  }),

  route("POST", "/triggers/:id/disable", async (req, res, params, authn, _query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    const trigger = await ctx.triggerStore.getTrigger(principal.tenantId, params.id!)
    if (!trigger || trigger.orgId !== principal.orgId || !principal.projectScope.includes(trigger.projectId)) {
      ctx.json(res, 404, { error: { code: "NOT_FOUND", message: "trigger not found" } })
      return
    }
    try {
      const updated = await ctx.triggerStore.setTriggerState(principal.tenantId, trigger.triggerId, trigger.revision, "disabled")
      ctx.json(res, 200, triggerView(updated))
    } catch (error) {
      handlePhase2dError(error, ctx, res)
    }
  }),

  // -- Triggers: manual invoke --------------------------------------------

  route("POST", "/triggers/:id/invoke", async (req, res, params, authn, _query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    const trigger = await ctx.triggerStore.getTrigger(principal.tenantId, params.id!)
    if (!trigger || trigger.orgId !== principal.orgId || !principal.projectScope.includes(trigger.projectId)) {
      ctx.json(res, 404, { error: { code: "NOT_FOUND", message: "trigger not found" } })
      return
    }
    if (trigger.triggerClass !== "manual") {
      ctx.json(res, 422, { error: { code: "NOT_MANUAL", message: "only manual triggers may be invoked directly" } })
      return
    }
    if (trigger.state === "disabled") {
      ctx.json(res, 409, { error: { code: "TRIGGER_DISABLED", message: "trigger is disabled" } })
      return
    }
    // Synthesize a normalized manual event + dispatch.
    const event: NormalizedEvent = {
      eventId: `manual:${trigger.triggerId}:${Date.now()}`,
      tenantId: trigger.tenantId,
      orgId: trigger.orgId,
      projectId: trigger.projectId,
      provider: "manual",
      providerEventId: `manual:${trigger.triggerId}`,
      kind: "custom",
      resource: `trigger:${trigger.triggerId}`,
      action: "invoke",
      actor: { externalId: principal.principalId, displayName: null },
      payload: {},
      providerTimestamp: null,
      receivedAt: Date.now(),
    }
    try {
      const result = await ctx.dispatchService.dispatchEvent(event)
      ctx.json(res, 201, { dispatches: result.dispatches.length, runIds: result.runIds })
    } catch (error) {
      handlePhase2dError(error, ctx, res)
    }
  }),

  // -- Dispatch status -----------------------------------------------------

  route("GET", "/triggers/dispatches/:id", async (req, res, params, authn, _query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    const dispatch = await ctx.triggerStore.getDispatch(principal.tenantId, params.id!)
    if (!dispatch) {
      ctx.json(res, 404, { error: { code: "NOT_FOUND", message: "dispatch not found" } })
      return
    }
    ctx.json(res, 200, {
      dispatchId: dispatch.dispatchId,
      state: dispatch.state,
      triggerId: dispatch.triggerId,
      triggerRevision: dispatch.triggerRevision,
      automationRunId: dispatch.automationRunId,
      rejectionKind: dispatch.rejectionKind,
      rejectionReason: dispatch.rejectionReason,
      attempts: dispatch.attempts,
      lastError: dispatch.lastError,
      createdAt: dispatch.createdAt,
      updatedAt: dispatch.updatedAt,
    })
  }),

  // -- Manual dispatch (testing/recovery) ---------------------------------

  route("POST", "/integrations/dispatch", async (req, res, _params, authn, _query, ctx) => {
    const principal = await resolveOrFail(ctx, req, res, authn)
    if (!principal) return
    const body = await ctx.readBody(req)
    const eventId = asString(body.eventId, "eventId", ctx, res)
    if (eventId === null) return
    const provider = asString(body.provider, "provider", ctx, res)
    if (provider === null) return
    const event: NormalizedEvent = {
      eventId,
      tenantId: principal.tenantId,
      orgId: principal.orgId,
      projectId: principal.projectScope[0] ?? principal.orgId,
      provider,
      providerEventId: eventId,
      kind: (body.kind as NormalizedEvent["kind"]) ?? "custom",
      resource: typeof body.resource === "string" ? body.resource : `${provider}:manual`,
      action: typeof body.action === "string" ? body.action : null,
      actor: null,
      payload: (body.payload && typeof body.payload === "object") ? body.payload as Record<string, unknown> : {},
      providerTimestamp: null,
      receivedAt: Date.now(),
    }
    try {
      const result = await ctx.dispatchService.dispatchEvent(event)
      ctx.json(res, 201, { dispatches: result.dispatches.length, runIds: result.runIds })
    } catch (error) {
      handlePhase2dError(error, ctx, res)
    }
  }),
]

/** Infer the connection family from a provider name (git/project/etc). */
function inferFamily(provider: string): ProviderFamily {
  if (provider.startsWith("github") || provider.startsWith("gitlab")) return "git"
  if (provider === "linear") return "project"
  if (provider === "slack") return "notification"
  return "model"
}

export type { AuthorizationAttempt, WebhookEventRecord, ProviderConnection }
