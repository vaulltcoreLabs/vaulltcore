/**
 * B2B identity & security contracts (Phase 2G).
 *
 * Authority separation:
 * - Better Auth owns user authentication, session issuance/validation and
 *   OAuth/social login primitives (see {@link BetterAuthAdapter}).
 * - Vaulltcore identity owns tenant/org identity, memberships, roles,
 *   permissions, actors, service identities and machine credentials.
 *
 * A valid Better Auth session NEVER implies authorization by itself. Every
 * protected request must resolve to an {@link Actor} through
 * {@link ActorResolver}, then pass {@link authorize} at the domain boundary.
 *
 * Actor objects carry the MINIMUM context needed for authorization — never
 * secrets, OAuth tokens, raw API keys, session tokens or cookies.
 */

import type { Role } from "@vaulltcore/identity"

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/** Central permission catalog. Domain services authorize against these. */
export const PERMISSIONS = [
  "org.read",
  "org.manage",
  "member.read",
  "member.manage",
  "project.manage",
  "connection.manage",
  "credential.manage",
  "trigger.manage",
  "automation.read",
  "automation.manage",
  "run.read",
  "run.manage",
  "reliability.manage",
  "usage.read",
  "billing.read",
  "billing.manage",
  "reconcile.admin",
  "service_identity.manage",
  "session.manage",
  "api_credential.manage",
] as const
export type Permission = (typeof PERMISSIONS)[number]

export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && (PERMISSIONS as readonly string[]).includes(value)
}

const ALL: readonly Permission[] = PERMISSIONS

/** Role → permissions. This is the ONLY role→permission mapping; domain
 *  services authorize by permission, never by scattered string role checks. */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: ALL,
  admin: ALL.filter((p) => p !== "reconcile.admin"),
  developer: [
    "org.read", "member.read", "automation.read", "automation.manage",
    "trigger.manage", "run.read", "run.manage", "usage.read",
    "connection.manage", "billing.read",
  ],
  operator: [
    "org.read", "member.read", "automation.read", "run.read", "run.manage",
    "reliability.manage", "usage.read",
  ],
  viewer: ["org.read", "member.read", "automation.read", "run.read", "usage.read", "billing.read"],
  // Service accounts get NO implicit permissions beyond these reads; their
  // effective set is the intersection with the explicit credential scope.
  service_account: ["automation.read", "run.read", "usage.read"],
}

/** Effective permissions for a human member role. */
export function permissionsForRole(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role]
}

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------

/** The three actor classes. Not every actor is a user. */
export type ActorClass = "user" | "service" | "system"

/**
 * Validated authorization actor. Contains only the minimum context required
 * for an authorization decision — no secrets, tokens, cookies or provider
 * credentials may ever be attached.
 */
export interface Actor {
  readonly actorClass: ActorClass
  /** Identity-store principal id (for humans: the Better Auth user id). */
  readonly principalId: string
  readonly tenantId: string
  readonly orgId: string
  /** Org membership role for human actors; null for pure service actors. */
  readonly role: Role | null
  /** Effective, already-resolved permission set (deduplicated). */
  readonly permissions: readonly Permission[]
  /** Project grants; "*" = all projects in the org. Never synthesized from absence. */
  readonly projectScope: readonly string[]
  /** Cross-tenant operator flag (deny by default). */
  readonly admin: boolean
  /** Non-secret attribution references (fingerprints/ids only). */
  readonly attribution: {
    readonly userId?: string
    /** sha256 fingerprint of the session token (never the token itself). */
    readonly sessionFingerprint?: string
    readonly apiKeyId?: string
    readonly serviceIdentityId?: string
    readonly credentialId?: string
  }
}

/** Explicit, validated tenant context for one request. */
export interface TenantContext {
  readonly tenantId: string
  readonly orgId: string
  readonly projectId: string
}

// ---------------------------------------------------------------------------
// User identity (durable, Better Auth user → Vaulltcore identity bridge)
// ---------------------------------------------------------------------------

export type UserIdentityStatus = "active" | "disabled"

export interface UserIdentity {
  /** Better Auth user id; also the identity-store principal id. */
  readonly userId: string
  readonly displayName: string | null
  readonly status: UserIdentityStatus
  readonly createdAt: number
  readonly disabledAt: number | null
}

// ---------------------------------------------------------------------------
// Service identities & machine credentials
// ---------------------------------------------------------------------------

export type ServiceIdentityStatus = "active" | "disabled" | "revoked"

/** A machine/service principal scoped to exactly ONE tenant+org. */
export interface ServiceIdentity {
  readonly serviceIdentityId: string
  readonly tenantId: string
  readonly orgId: string
  readonly name: string
  readonly status: ServiceIdentityStatus
  /** Explicit, bounded permission set. Never inherits unlimited owner rights. */
  readonly permissions: readonly Permission[]
  readonly createdBy: string | null
  readonly createdAt: number
  readonly disabledAt: number | null
  readonly revokedAt: number | null
}

export type MachineCredentialStatus = "active" | "revoked" | "expired"

/**
 * Machine credential metadata. Only a SHA-256 fingerprint + lookup prefix are
 * persisted; the plaintext secret is shown exactly once at issuance and can
 * never be retrieved later.
 */
export interface MachineCredential {
  readonly credentialId: string
  readonly serviceIdentityId: string
  readonly tenantId: string
  readonly orgId: string
  /** Lookup prefix, e.g. "vc_svc_…". Public-ish, safe to display. */
  readonly prefix: string
  /** SHA-256 fingerprint of the full secret. */
  readonly fingerprint: string
  readonly createdAt: number
  readonly revokedAt: number | null
  readonly expiresAt: number | null
  readonly lastUsedAt: number | null
}

/** Returned once at issuance; the secret is never recoverable afterwards. */
export interface IssuedMachineCredential extends MachineCredential {
  readonly secret: string
}

// ---------------------------------------------------------------------------
// Session registry (Vaulltcore-side revocation + audit ledger)
// ---------------------------------------------------------------------------

/**
 * Durable record of a validated browser session. Better Auth remains the
 * authority for issuance/expiry; this registry is Vaulltcore's revocation and
 * audit ledger. Only the token FINGERPRINT is stored — never the token.
 */
export interface SessionRecord {
  readonly fingerprint: string
  readonly userId: string
  readonly betterAuthSessionId: string
  readonly createdAt: number
  readonly expiresAt: number
  readonly revokedAt: number | null
  readonly lastSeenAt: number | null
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type AuthErrorCode =
  | "UNAUTHENTICATED"
  | "SESSION_EXPIRED"
  | "SESSION_REVOKED"
  | "USER_DISABLED"
  | "ORG_NOT_MEMBER"
  | "FORBIDDEN_PERMISSION"
  | "SERVICE_IDENTITY_INACTIVE"
  | "CREDENTIAL_REVOKED"
  | "CREDENTIAL_EXPIRED"
  | "CONFLICT"
  | "NOT_FOUND"
  | "INVALID_INPUT"

export class AuthError extends Error {
  constructor(readonly code: AuthErrorCode, message: string) {
    super(message)
    this.name = "AuthError"
  }
}

/** Deterministic authorization denial — never carries secrets or cross-tenant detail. */
export class AuthorizationError extends Error {
  constructor(readonly permission: Permission, message = "permission denied") {
    super(message)
    this.name = "AuthorizationError"
  }
}

/** Central authorization check. The ONLY place a permission decision is made
 *  for domain operations; throws {@link AuthorizationError} on denial. */
export function authorize(actor: Actor, permission: Permission): void {
  if (!actor.admin && !actor.permissions.includes(permission)) {
    throw new AuthorizationError(permission, `permission "${permission}" required`)
  }
}

/** True when the actor holds a permission (or is a cross-tenant operator). */
export function hasPermission(actor: Actor, permission: Permission): boolean {
  return actor.admin || actor.permissions.includes(permission)
}

/** True when the actor may act on the given project within its org. */
export function hasProjectAccess(actor: Actor, projectId: string): boolean {
  if (actor.admin) return true
  return actor.projectScope.includes("*") || actor.projectScope.includes(projectId)
}
