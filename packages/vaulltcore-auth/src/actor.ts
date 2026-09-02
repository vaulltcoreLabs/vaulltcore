/**
 * Actor resolution (Phase 2G). The single boundary where an authenticated
 * principal becomes a Vaulltcore {@link Actor} with a validated tenant
 * context. Resolution ordering:
 *
 * 1. `Authorization: Bearer <secret>` — machine credential (`vc_svc`-style
 *    `<credentialId>.<body>`) when it parses as one, otherwise the existing
 *    Phase 1E API-key authority.
 * 2. `Cookie: better-auth.session_token=…` — Better Auth session → Vaulltcore
 *    user identity → server-side membership check → role-derived permissions.
 *
 * Membership and roles are ALWAYS re-read from durable state on resolution:
 * privilege changes (role change, member removal, user disable, credential
 * revoke) take effect at the next request — no stale elevation embedded in a
 * client token.
 */

import type { SqlIdentityStore, ResolvedPrincipal, Role } from "@vaulltcore/identity"
import type { SqlAuditStore } from "@vaulltcore/audit"
import {
  Actor,
  AuthError,
  permissionsForRole,
  type Permission,
} from "./contracts"
import { SqlB2bAuthStore, fingerprintSecret } from "./auth-store"
import { BetterAuthAdapter } from "./better-auth-adapter"
import { ServiceIdentityService } from "./service-identity"

export interface ResolveInput {
  /** Raw `authorization` header value. */
  readonly authorization?: unknown
  /** Raw `cookie` header value. */
  readonly cookie?: unknown
  /** Client-requested organization hint (`x-vc-org`). Validated server-side
   *  against actual membership — never trusted by itself. */
  readonly requestedOrgId?: string
}

export interface ActorResolverDeps {
  readonly identity: SqlIdentityStore
  readonly authStore: SqlB2bAuthStore
  readonly sessions?: BetterAuthAdapter
  readonly serviceIdentities?: ServiceIdentityService
  readonly audit?: SqlAuditStore
}

function headerValue(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null
}

export class ActorResolver {
  private readonly identity: SqlIdentityStore
  private readonly authStore: SqlB2bAuthStore
  private readonly sessions?: BetterAuthAdapter
  private readonly serviceIdentities?: ServiceIdentityService
  private readonly audit?: SqlAuditStore

  constructor(deps: ActorResolverDeps) {
    this.identity = deps.identity
    this.authStore = deps.authStore
    this.sessions = deps.sessions
    this.serviceIdentities = deps.serviceIdentities
    this.audit = deps.audit
  }

  /**
   * Resolve a request to a validated actor. Returns null for unauthenticated
   * requests; throws {@link AuthError} for authenticated-but-invalid contexts
   * (e.g. a requested org the principal is not a member of).
   */
  async resolve(input: ResolveInput): Promise<Actor | null> {
    const authorization = headerValue(input.authorization)
    const cookie = headerValue(input.cookie)
    if (authorization && authorization.toLowerCase().startsWith("bearer ")) {
      const secret = authorization.slice(7).trim()
      const actor = await this.resolveBearer(secret, input.requestedOrgId)
      if (actor) return actor
    }
    if (cookie && this.sessions) {
      return this.resolveSession(cookie, input.requestedOrgId)
    }
    return null
  }

  private async resolveBearer(secret: string, requestedOrgId: string | undefined): Promise<Actor | null> {
    // Machine credentials look like `<credentialId>.<body>`; API keys use the
    // same internal separator but carry their own prefix (vc_live_…).
    if (this.serviceIdentities && !secret.startsWith("vc_live_")) {
      const machine = await this.serviceIdentities.authenticateMachineCredential(secret).catch(() => null)
      if (machine) {
        if (requestedOrgId && machine.orgId !== requestedOrgId) {
          throw new AuthError("ORG_NOT_MEMBER", "requested organization does not match the credential scope")
        }
        return machine
      }
    }
    const principal = await this.identity.authenticateApiKey(secret).catch(() => null)
    if (!principal) return null
    if (requestedOrgId && principal.orgId !== requestedOrgId) {
      throw new AuthError("ORG_NOT_MEMBER", "requested organization does not match the principal's organization")
    }
    return this.fromResolvedPrincipal(principal)
  }

  private async resolveSession(cookie: string, requestedOrgId: string | undefined): Promise<Actor | null> {
    const session = await this.sessions!.validateSession(cookie)
    if (!session) return null
    const fingerprint = fingerprintSecret(session.token)
    try {
      const record = await this.authStore.getSession(fingerprint)
      if (record?.revokedAt) throw new AuthError("SESSION_REVOKED", "session has been revoked")
      if (!record) {
        // First sighting: register the fingerprint for the revocation ledger.
        await this.authStore.registerSession({ fingerprint, userId: session.userId, betterAuthSessionId: session.sessionId, expiresAt: session.expiresAt })
      }
      const identity = await this.authStore.getUserIdentity(session.userId)
      if (identity && identity.status === "disabled") throw new AuthError("USER_DISABLED", "user is disabled")
      if (!identity) {
        // Idempotent durable provisioning of the Better Auth user → Vaulltcore
        // principal bridge. Missing ORG membership is still enforced below.
        await this.authStore.provisionUserIdentity(session.userId, null)
      }
      const memberships = await this.identity.listMembershipsByPrincipal(session.userId)
      if (memberships.length === 0) throw new AuthError("ORG_NOT_MEMBER", "user has no organization membership")
      const requested = requestedOrgId
      const membership = requested
        ? memberships.find((m) => m.orgId === requested)
        : memberships[0]!
      if (!membership) throw new AuthError("ORG_NOT_MEMBER", `user is not a member of organization ${requested}`)
      const resolved = await this.identity.resolvePrincipal(membership.principalId, membership.orgId, membership.role)
      const actor = this.fromResolvedPrincipal(resolved)
      // Best-effort last-seen metadata; never an authz input.
      void this.authStore.touchSession(fingerprint).catch(() => undefined)
      return { ...actor, actorClass: "user", attribution: { userId: session.userId, sessionFingerprint: fingerprint } }
    } catch (error) {
      if (error instanceof AuthError) {
        // Scope the denial audit to the user's known membership when possible;
        // metadata contains the error code only (no tokens, no cookies).
        const memberships = await this.identity.listMembershipsByPrincipal(session.userId).catch(() => [])
        await this.auditDenied({
          metadata: { code: error.code },
          scope: memberships[0] ? { tenantId: memberships[0]!.tenantId, orgId: memberships[0]!.orgId } : null,
          actor: { principalId: session.userId, kind: "user", tenantId: memberships[0]?.tenantId ?? "unknown" },
        })
      }
      throw error
    }
  }

  private fromResolvedPrincipal(principal: ResolvedPrincipal): Actor {
    return {
      actorClass: principal.kind === "user" ? "user" : "service",
      principalId: principal.principalId,
      tenantId: principal.tenantId,
      orgId: principal.orgId,
      role: principal.role,
      permissions: permissionsForRole(principal.role as Role),
      projectScope: [...principal.projectScope],
      admin: principal.admin ?? false,
      attribution: principal.apiKeyId ? { apiKeyId: principal.apiKeyId } : {},
    }
  }

  /** Explicit system actor for internal callers that must assert their own
   *  authority. Never produced from request resolution. */
  static makeSystemActor(scope: { tenantId: string; orgId: string; principalId?: string; projectScope?: readonly string[] }): Actor {
    return {
      actorClass: "system",
      principalId: scope.principalId ?? "system",
      tenantId: scope.tenantId,
      orgId: scope.orgId,
      role: null,
      permissions: [],
      projectScope: [...(scope.projectScope ?? ["*"])],
      admin: true,
      attribution: {},
    }
  }

  private async auditDenied(input: { metadata: Record<string, unknown>; scope: { tenantId: string; orgId: string } | null; actor?: { principalId: string; kind: string; tenantId: string } | null }): Promise<void> {
    if (!this.audit) return
    await this.audit
      .append({ actor: input.actor ?? null, scope: input.scope, type: "authentication_failed", metadata: input.metadata })
      .catch(() => undefined)
  }
}
