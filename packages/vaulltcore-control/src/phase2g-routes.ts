/**
 * Control-plane integration for Phase 2G: B2B identity, authentication,
 * authorization & tenant security hardening. Purely additive — registers
 * `/auth/*` (public Better Auth bridge) and `/identity/*` (protected, fully
 * actor-resolved) routes when the Phase 2G layer is wired. It reuses the
 * Vaulltcore identity store (authoritative membership/roles), the
 * {@link ActorResolver} (single session→actor boundary), and the
 * {@link ServiceIdentityService}; it introduces NO second authorization model
 * and NO second secret store.
 *
 * Request security pipeline for `/identity/*`:
 *   1. request received
 *   2. authentication resolved (Better Auth session OR bearer secret)
 *   3. authenticated principal validated (user enabled, session not revoked)
 *   4. Vaulltcore actor resolved (role → permissions, attribution only)
 *   5. tenant/organization context validated (server-side membership check)
 *   6. authorization performed (central permission contract, domain boundary)
 *   7. domain operation invoked
 *   8. sensitive operation audited (sanitized)
 *   9. sanitized response returned (never secrets; issuance is the only
 *      endpoint that ever returns a secret — once)
 *
 * Public trust-boundary exceptions (explicit): `/health`, `/auth/*`
 * (Better Auth authentication flows), and the pre-existing webhook/OAuth
 * trust boundaries. Nothing else is public.
 *
 * Status semantics: 401 unauthenticated; 403 authenticated but forbidden;
 * 404 cross-tenant isolation (no existence leak); 409 deterministic state
 * conflict; 422 semantically invalid input. Secrets NEVER appear in
 * list/get/lifecycle responses.
 */

import type { IncomingMessage, ServerResponse } from "node:http"
import type { SqlIdentityStore, Role } from "@vaulltcore/identity"
import { ROLES, IdentityError } from "@vaulltcore/identity"
import type { SqlAuditStore, AuditEventType } from "@vaulltcore/audit"
import {
  Actor,
  ActorResolver,
  AuthError,
  AuthorizationError,
  BetterAuthAdapter,
  ServiceIdentityService,
  SqlB2bAuthStore,
  authorize,
  isPermission,
  type Permission,
} from "@vaulltcore/auth"

// ---------------------------------------------------------------------------
// Layer wiring
// ---------------------------------------------------------------------------

export interface Phase2gLayerOptions {
  readonly resolver: ActorResolver
  readonly authStore: SqlB2bAuthStore
  readonly identity: SqlIdentityStore
  readonly serviceIdentities: ServiceIdentityService
  readonly audit?: SqlAuditStore
  /** Better Auth adapter. When absent, the public `/auth/*` bridge is not
   *  registered and session resolution simply cannot succeed. */
  readonly betterAuth?: BetterAuthAdapter
}

export interface Phase2gRouteContext extends Phase2gLayerOptions {
  json(res: ServerResponse, status: number, body: unknown): void
  readBody(req: IncomingMessage): Promise<Record<string, unknown>>
}

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  actor: Actor,
  query: URLSearchParams,
  ctx: Phase2gRouteContext,
) => Promise<void>

export interface Phase2gRoute {
  readonly method: string
  readonly pattern: RegExp
  readonly keys: string[]
  readonly handler: RouteHandler
}

function route(method: string, path: string, handler: RouteHandler): Phase2gRoute {
  const keys = path.split("/").filter((s) => s.startsWith(":")).map((s) => s.slice(1))
  const pattern = new RegExp(`^${path.replace(/:(\w+)/g, () => "([^/]+)")}$`)
  return { method, pattern, keys, handler }
}

/** Central permission guard: throws AuthorizationError (→403) on denial. */
function guard(actor: Actor, permission: Permission): void {
  authorize(actor, permission)
}

/** Org scoping guard: a route path org must match the validated actor org —
 *  cross-tenant access is denied BEFORE resource disclosure (404, no leak). */
function sameOrg(actor: Actor, orgId: string): boolean {
  return actor.orgId === orgId
}

function auditAction(ctx: Phase2gRouteContext, actor: Actor, type: AuditEventType, metadata: Record<string, unknown>): void {
  if (!ctx.audit) return
  void ctx.audit
    .append({
      actor: { principalId: actor.principalId, kind: actor.actorClass, tenantId: actor.tenantId },
      scope: { tenantId: actor.tenantId, orgId: actor.orgId },
      type,
      metadata,
    })
    .catch(() => undefined)
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function getMe(_req: IncomingMessage, res: ServerResponse, _params: Record<string, string>, actor: Actor, _query: URLSearchParams, ctx: Phase2gRouteContext): Promise<void> {
  ctx.json(res, 200, {
    actorClass: actor.actorClass,
    principalId: actor.principalId,
    tenantId: actor.tenantId,
    orgId: actor.orgId,
    role: actor.role,
    projectScope: actor.projectScope,
    // Attribution references are ids/fingerprints only — never secrets.
    attribution: actor.attribution,
  })
}

async function getPermissions(_req: IncomingMessage, res: ServerResponse, _params: Record<string, string>, actor: Actor, _query: URLSearchParams, ctx: Phase2gRouteContext): Promise<void> {
  ctx.json(res, 200, { permissions: actor.permissions })
}

async function getOrgs(_req: IncomingMessage, res: ServerResponse, _params: Record<string, string>, actor: Actor, _query: URLSearchParams, ctx: Phase2gRouteContext): Promise<void> {
  const memberships = await ctx.identity.listMembershipsByPrincipal(actor.principalId)
  ctx.json(res, 200, {
    organizations: memberships.map((m) => ({ tenantId: m.tenantId, orgId: m.orgId, role: m.role })),
  })
}

async function listMembers(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, actor: Actor, _query: URLSearchParams, ctx: Phase2gRouteContext): Promise<void> {
  if (!sameOrg(actor, params.orgId!)) return ctx.json(res, 404, { error: { code: "NOT_FOUND", message: "organization not found" } })
  guard(actor, "member.read")
  const members = await ctx.identity.listMembers(actor.tenantId, params.orgId!)
  ctx.json(res, 200, {
    members: members.map((m) => ({ principalId: m.principalId, role: m.role, createdAt: m.createdAt })),
  })
}

async function upsertMember(req: IncomingMessage, res: ServerResponse, params: Record<string, string>, actor: Actor, _query: URLSearchParams, ctx: Phase2gRouteContext): Promise<void> {
  if (!sameOrg(actor, params.orgId!)) return ctx.json(res, 404, { error: { code: "NOT_FOUND", message: "organization not found" } })
  guard(actor, "member.manage")
  const body = await ctx.readBody(req)
  const principalId = typeof body.userId === "string" ? body.userId : typeof body.principalId === "string" ? body.principalId : null
  const role = typeof body.role === "string" ? body.role : null
  if (!principalId || !role) return ctx.json(res, 422, { error: { code: "INVALID_INPUT", message: "userId and role required" } })
  if (!(ROLES as readonly string[]).includes(role)) {
    return ctx.json(res, 422, { error: { code: "INVALID_INPUT", message: `unknown role "${role}"` } })
  }
  const projects = Array.isArray(body.projects) ? (body.projects as string[]) : []
  for (const projectId of projects) {
    if (typeof projectId !== "string" || !(await ctx.identity.getProject(actor.tenantId, params.orgId!, projectId))) {
      return ctx.json(res, 422, { error: { code: "INVALID_INPUT", message: `unknown project "${String(projectId)}"` } })
    }
  }
  // Register the principal idempotently (human kind), then bind membership.
  try {
    await ctx.identity.registerPrincipal(actor.tenantId, principalId, "user")
  } catch (error) {
    if (!(error instanceof IdentityError && error.code === "PRINCIPAL_EXISTS")) throw error
  }
  const existing = await ctx.identity.getMember(actor.tenantId, params.orgId!, principalId)
  if (existing) {
    await ctx.identity.setMemberRole(actor.tenantId, params.orgId!, principalId, role as Role)
    auditAction(ctx, actor, "member_role_changed", { principalId, role })
    return ctx.json(res, 200, { principalId, role, updated: true })
  }
  const member = await ctx.identity.addMember(actor.tenantId, params.orgId!, principalId, role as Role)
  for (const projectId of projects) {
    await ctx.identity.grantProject(actor.tenantId, params.orgId!, projectId, principalId, role as Role)
  }
  auditAction(ctx, actor, "member_added", { principalId, role, projects })
  ctx.json(res, 201, { principalId, role: member.role, projects })
}

async function changeMemberRole(req: IncomingMessage, res: ServerResponse, params: Record<string, string>, actor: Actor, _query: URLSearchParams, ctx: Phase2gRouteContext): Promise<void> {
  if (!sameOrg(actor, params.orgId!)) return ctx.json(res, 404, { error: { code: "NOT_FOUND", message: "organization not found" } })
  guard(actor, "member.manage")
  const body = await ctx.readBody(req)
  const role = typeof body.role === "string" ? body.role : null
  if (!role || !(ROLES as readonly string[]).includes(role)) {
    return ctx.json(res, 422, { error: { code: "INVALID_INPUT", message: `unknown role ${JSON.stringify(body.role)}` } })
  }
  const member = await ctx.identity.getMember(actor.tenantId, params.orgId!, params.principalId!)
  if (!member) return ctx.json(res, 404, { error: { code: "NOT_FOUND", message: "member not found" } })
  await ctx.identity.setMemberRole(actor.tenantId, params.orgId!, params.principalId!, role as Role)
  auditAction(ctx, actor, "member_role_changed", { principalId: params.principalId!, from: member.role, to: role })
  ctx.json(res, 200, { principalId: params.principalId!, role })
}

async function removeMember(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, actor: Actor, _query: URLSearchParams, ctx: Phase2gRouteContext): Promise<void> {
  if (!sameOrg(actor, params.orgId!)) return ctx.json(res, 404, { error: { code: "NOT_FOUND", message: "organization not found" } })
  guard(actor, "member.manage")
  const member = await ctx.identity.getMember(actor.tenantId, params.orgId!, params.principalId!)
  if (!member) return ctx.json(res, 404, { error: { code: "NOT_FOUND", message: "member not found" } })
  await ctx.identity.removeMember(actor.tenantId, params.orgId!, params.principalId!)
  auditAction(ctx, actor, "member_removed", { principalId: params.principalId! })
  ctx.json(res, 200, { removed: true })
}

async function createServiceIdentity(req: IncomingMessage, res: ServerResponse, _params: Record<string, string>, actor: Actor, _query: URLSearchParams, ctx: Phase2gRouteContext): Promise<void> {
  const body = await ctx.readBody(req)
  const name = typeof body.name === "string" ? body.name : null
  const permissions = Array.isArray(body.permissions) ? (body.permissions as string[]) : null
  const projects = Array.isArray(body.projects) ? (body.projects as string[]) : undefined
  if (!name || !permissions) return ctx.json(res, 422, { error: { code: "INVALID_INPUT", message: "name and permissions required" } })
  if (!permissions.every((p) => isPermission(p))) {
    return ctx.json(res, 422, { error: { code: "INVALID_INPUT", message: "unknown permission in permissions" } })
  }
  const identity = await ctx.serviceIdentities.create(actor, { name, permissions, projectIds: projects })
  ctx.json(res, 201, sanitizeIdentity(identity))
}

async function listServiceIdentities(_req: IncomingMessage, res: ServerResponse, _params: Record<string, string>, actor: Actor, _query: URLSearchParams, ctx: Phase2gRouteContext): Promise<void> {
  const identities = await ctx.serviceIdentities.list(actor)
  ctx.json(res, 200, { serviceIdentities: identities.map(sanitizeIdentity) })
}

function transitionServiceIdentity(kind: "disable" | "enable" | "revoke"): RouteHandler {
  return async (_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, actor: Actor, _query: URLSearchParams, ctx: Phase2gRouteContext): Promise<void> => {
    const serviceIdentityId = params.id!
    const updated =
      kind === "disable"
        ? await ctx.serviceIdentities.disable(actor, serviceIdentityId)
        : kind === "enable"
          ? await ctx.serviceIdentities.enable(actor, serviceIdentityId)
          : await ctx.serviceIdentities.revoke(actor, serviceIdentityId)
    ctx.json(res, 200, sanitizeIdentity(updated))
  }
}

async function issueCredential(req: IncomingMessage, res: ServerResponse, params: Record<string, string>, actor: Actor, _query: URLSearchParams, ctx: Phase2gRouteContext): Promise<void> {
  const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>))
  const expiresInMs = typeof body.expiresInMs === "number" && body.expiresInMs > 0 ? body.expiresInMs : undefined
  const issued = await ctx.serviceIdentities.issueCredential(actor, params.id!, { expiresInMs })
  // The ONLY endpoint that ever returns a secret — exactly once at issuance.
  ctx.json(res, 201, {
    credentialId: issued.credentialId,
    serviceIdentityId: issued.serviceIdentityId,
    prefix: issued.prefix,
    fingerprint: issued.fingerprint,
    secret: issued.secret,
    expiresAt: issued.expiresAt,
  })
}

async function listCredentials(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, actor: Actor, _query: URLSearchParams, ctx: Phase2gRouteContext): Promise<void> {
  const credentials = await ctx.serviceIdentities.listCredentials(actor, params.id!)
  ctx.json(res, 200, { credentials: credentials.map(sanitizeCredential) })
}

async function revokeCredential(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, actor: Actor, _query: URLSearchParams, ctx: Phase2gRouteContext): Promise<void> {
  const updated = await ctx.serviceIdentities.revokeCredential(actor, params.credentialId!)
  ctx.json(res, 200, sanitizeCredential(updated))
}

// A user may always read/revoke their OWN sessions — self-service, anchored
// on actor.attribution, never on another user's sessions.
async function getSessions(_req: IncomingMessage, res: ServerResponse, _params: Record<string, string>, actor: Actor, _query: URLSearchParams, ctx: Phase2gRouteContext): Promise<void> {
  const userId = actor.attribution.userId
  if (!userId) return ctx.json(res, 403, { error: { code: "FORBIDDEN", message: "session listing requires a human session actor" } })
  const sessions = await ctx.authStore.listSessionsForUser(userId)
  ctx.json(res, 200, { sessions: sessions.map(sanitizeSession) })
}

async function revokeCurrentSession(req: IncomingMessage, res: ServerResponse, _params: Record<string, string>, actor: Actor, _query: URLSearchParams, ctx: Phase2gRouteContext): Promise<void> {
  const fingerprint = actor.attribution.sessionFingerprint
  if (!fingerprint) return ctx.json(res, 403, { error: { code: "FORBIDDEN", message: "revocation requires a human session actor" } })
  const revoked = await ctx.authStore.revokeSession(fingerprint)
  auditAction(ctx, actor, "session_revoked", { fingerprint })
  // Best-effort Better Auth-side cleanup (registry revocation is authoritative).
  const cookie = req.headers.cookie
  if (ctx.betterAuth && typeof cookie === "string") {
    await ctx.betterAuth.revokeBetterAuthSession(cookie).catch(() => undefined)
  }
  ctx.json(res, 200, { revoked: revoked !== null })
}

async function disableUser(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, actor: Actor, _query: URLSearchParams, ctx: Phase2gRouteContext): Promise<void> {
  guard(actor, "member.manage")
  const userId = params.userId!
  // Only users with membership in the actor's own org may be touched → 404.
  const member = await ctx.identity.getMember(actor.tenantId, actor.orgId, userId)
  if (!member) return ctx.json(res, 404, { error: { code: "NOT_FOUND", message: "user not found" } })
  const disabled = await ctx.authStore.disableUserIdentity(userId)
  const revokedCount = await ctx.authStore.revokeAllSessionsForUser(userId)
  auditAction(ctx, actor, "user_identity_disabled", { userId, revokedSessions: revokedCount })
  ctx.json(res, 200, { userId, status: disabled.status, revokedSessions: revokedCount })
}

async function revokeUserSessions(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, actor: Actor, _query: URLSearchParams, ctx: Phase2gRouteContext): Promise<void> {
  guard(actor, "session.manage")
  const userId = params.userId!
  const member = await ctx.identity.getMember(actor.tenantId, actor.orgId, userId)
  if (!member) return ctx.json(res, 404, { error: { code: "NOT_FOUND", message: "user not found" } })
  const count = await ctx.authStore.revokeAllSessionsForUser(userId)
  auditAction(ctx, actor, "session_revoked", { userId, count })
  ctx.json(res, 200, { revoked: count })
}

// ---------------------------------------------------------------------------
// Sanitized projections (never secrets)
// ---------------------------------------------------------------------------

function sanitizeIdentity(identity: import("@vaulltcore/auth").ServiceIdentity): unknown {
  return {
    serviceIdentityId: identity.serviceIdentityId,
    name: identity.name,
    status: identity.status,
    permissions: identity.permissions,
    createdAt: identity.createdAt,
    disabledAt: identity.disabledAt,
    revokedAt: identity.revokedAt,
  }
}

function sanitizeCredential(credential: import("@vaulltcore/auth").MachineCredential): unknown {
  return {
    credentialId: credential.credentialId,
    serviceIdentityId: credential.serviceIdentityId,
    prefix: credential.prefix,
    createdAt: credential.createdAt,
    revokedAt: credential.revokedAt,
    expiresAt: credential.expiresAt,
    lastUsedAt: credential.lastUsedAt,
  }
}

function sanitizeSession(session: import("@vaulltcore/auth").SessionRecord): unknown {
  return {
    fingerprint: session.fingerprint,
    userId: session.userId,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    revokedAt: session.revokedAt,
    lastSeenAt: session.lastSeenAt,
  }
}

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------

export const PHASE2G_ROUTES: readonly Phase2gRoute[] = [
  route("GET", "/identity/me", getMe),
  route("GET", "/identity/permissions", getPermissions),
  route("GET", "/identity/orgs", getOrgs),
  route("GET", "/identity/orgs/:orgId/members", listMembers),
  route("POST", "/identity/orgs/:orgId/members", upsertMember),
  route("PATCH", "/identity/orgs/:orgId/members/:principalId", changeMemberRole),
  route("DELETE", "/identity/orgs/:orgId/members/:principalId", removeMember),
  route("POST", "/identity/service-identities", createServiceIdentity),
  route("GET", "/identity/service-identities", listServiceIdentities),
  route("POST", "/identity/service-identities/:id/disable", transitionServiceIdentity("disable")),
  route("POST", "/identity/service-identities/:id/enable", transitionServiceIdentity("enable")),
  route("POST", "/identity/service-identities/:id/revoke", transitionServiceIdentity("revoke")),
  route("POST", "/identity/service-identities/:id/credentials", issueCredential),
  route("GET", "/identity/service-identities/:id/credentials", listCredentials),
  route("POST", "/identity/credentials/:credentialId/revoke", revokeCredential),
  route("GET", "/identity/sessions", getSessions),
  route("POST", "/identity/sessions/revoke", revokeCurrentSession),
  route("POST", "/identity/users/:userId/disable", disableUser),
  route("POST", "/identity/users/:userId/revoke-sessions", revokeUserSessions),
]
