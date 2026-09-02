/**
 * Vaulltcore credential & connection lifecycle contracts (Phase 2C).
 *
 * A "connection" is a tenant/org/project-scoped link to an external system
 * (GitHub, GitLab, Linear, Slack, an S3 endpoint, an SMTP server, a BYOK model
 * provider). A connection owns durable metadata (provider, account identity,
 * capabilities, last-used, expiry) and a reference to a secret held behind a
 * replaceable {@link SecretProvider} seam. The plaintext secret is NEVER
 * stored by the credential store, NEVER returned by list/get, NEVER written to
 * audit/logs/events/errors.
 *
 * Security invariants:
 * - Secrets flow only through explicit {@link CredentialResolver} boundaries.
 * - A connection's tenantId/orgId/projectId are immutable; a forged request
 *   body cannot select another tenant's connection.
 * - Rotation changes the secret reference without changing connection identity.
 * - Revocation/expiry is enforced at resolve time (a revoked/expired
 *   connection resolves to nothing).
 * - lastUsedAt is best-effort and NEVER an authorization source (authoritative
 *   key state, not a cached timestamp, gates access).
 */

/** Provider families a connection can target. */
export const PROVIDER_FAMILIES = [
  "git",
  "project",
  "notification",
  "storage",
  "email",
  "model",
] as const
export type ProviderFamily = (typeof PROVIDER_FAMILIES)[number]

/** Lifecycle state of a connection. */
export const CONNECTION_STATES = [
  "disconnected",
  "authorization_pending",
  "authorization_verified",
  "active",
  "degraded",
  "expired",
  "revoked",
] as const
export type ConnectionState = (typeof CONNECTION_STATES)[number]

/** Valid connection-state transitions. Invalid transitions fail
 *  deterministically (a store transition never silently coerces an illegal
 *  path). Revoked/disconnected are terminal within the connection record; a
 *  reauthorize creates a NEW authorization attempt that, on verification,
 *  reactivates the same connection identity. */
export const CONNECTION_TRANSITIONS: Readonly<Record<ConnectionState, readonly ConnectionState[]>> = {
  disconnected: ["authorization_pending"],
  authorization_pending: ["authorization_verified", "disconnected"],
  authorization_verified: ["active", "disconnected"],
  active: ["degraded", "expired", "revoked", "disconnected"],
  degraded: ["active", "expired", "revoked", "disconnected"],
  expired: ["revoked", "disconnected"],
  revoked: ["disconnected"],
}

/** Assert a transition is legal; throws deterministically if not. */
export function assertConnectionTransition(from: ConnectionState, to: ConnectionState): void {
  if (from === to) return
  const allowed = CONNECTION_TRANSITIONS[from]
  if (!allowed || !allowed.includes(to)) {
    throw new CredentialError("INVALID_TRANSITION", `invalid connection transition: ${from} → ${to}`, 409)
  }
}

/** A capability a connection declares it can perform (read, write, …). */
export type ConnectionCapability =
  | "read"
  | "write"
  | "repo:list"
  | "repo:read"
  | "repo:write"
  | "issue:read"
  | "issue:write"
  | "pr:read"
  | "pr:write"
  | "webhook:verify"
  | "model:stream"
  | "object:read"
  | "object:write"
  | "message:send"

/** The externally authenticated account a connection represents. */
export interface ProviderAccountIdentity {
  /** Stable external account/installation id (e.g. GitHub App installation id, Slack team id). */
  readonly externalId: string
  /** Human-readable account name (e.g. login, workspace name). Redacted-safe. */
  readonly displayName: string | null
  /** Scopes/permissions granted by the external provider. */
  readonly scopes: readonly string[]
}

// ---------------------------------------------------------------------------
// Authorization method capabilities (Phase 2D)
// ---------------------------------------------------------------------------

/**
 * How a connection's secret was obtained. The control plane selects adapters
 * by capability, not by provider-name conditionals. Not every provider uses
 * OAuth — API-key/BYOK and app-installation identity remain first-class.
 */
export const AUTHORIZATION_METHODS = [
  "oauth_authorization_code",
  "oauth_pkce",
  "refresh_token",
  "webhook",
  "api_key",
  "app_installation",
  "service_identity",
] as const
export type AuthorizationMethod = (typeof AUTHORIZATION_METHODS)[number]

/**
 * A provider's authorization capability surface. Declared by an adapter; the
 * control plane uses this (never provider-name branching) to drive flows.
 * GitHub/GitLab app-installation identity is distinguishable from user OAuth
 * identity via `identityKind` — never flattened into a generic string.
 */
export interface AuthorizationCapability {
  readonly provider: string
  readonly family: ProviderFamily
  readonly methods: readonly AuthorizationMethod[]
  /** Identity kind this capability produces (user OAuth vs app installation). */
  readonly identityKind: "user" | "app_installation" | "service"
  /** Whether the provider supports OAuth scopes declaration. */
  readonly supportsScopes: boolean
  /** Whether a refresh-token rotation lifecycle applies. */
  readonly supportsRefresh: boolean
  /** Whether the provider exposes webhooks for inbound events. */
  readonly supportsWebhooks: boolean
}

// ---------------------------------------------------------------------------
// OAuth authorization attempts (Phase 2D)
// ---------------------------------------------------------------------------

/** Lifecycle of a durable authorization attempt. */
export const AUTHORIZATION_ATTEMPT_STATES = [
  "pending",
  "verified",
  "failed",
  "expired",
  "consumed",
] as const
export type AuthorizationAttemptState = (typeof AUTHORIZATION_ATTEMPT_STATES)[number]

/**
 * A durable OAuth authorization attempt. The opaque `state` token is bound
 * durably (BEFORE redirect) to tenant/org/project/principal/provider and
 * validated at callback settlement — a forged callback cannot select another
 * tenant's connection or replay an old state.
 *
 * Security invariants:
 * - `state` is a cryptographically random nonce; it is single-use (consumed at
 *   settlement). A duplicate callback cannot create contradictory state.
 * - PKCE `codeVerifier`/`codeChallenge` are stored ONLY for the duration of
 *   the attempt and never persisted once the attempt is consumed (the verifier
 *   is deleted at settlement; only a one-way hash, if any, would persist).
 * - No access/refresh token or client secret is ever stored in this record.
 *   At successful settlement the resulting secret crosses the SecretProvider
 *   boundary immediately and only an opaque ref + fingerprint persist on the
 *   connection.
 * - `attemptId` + `state` are the linearization points; UNIQUE constraints
 *   make a duplicate settlement idempotent (returns the original outcome).
 */
export interface AuthorizationAttempt {
  readonly attemptId: string
  readonly state: string
  readonly tenantId: string
  readonly orgId: string
  readonly projectId: string
  readonly principalId: string
  readonly provider: string
  readonly family: ProviderFamily
  /** The authorization method this attempt drives. */
  readonly method: AuthorizationMethod
  /** Connection id being (re)authorized; null for a brand-new connection. */
  readonly connectionId: string | null
  /** PKCE code challenge (SHA-256 of the verifier); null when PKCE unsupported. */
  readonly codeChallenge: string | null
  /** PKCE code verifier; transient, deleted at settlement. */
  readonly codeVerifier: string | null
  /** Requested scopes (bound before redirect; validated at settlement). */
  readonly scopes: readonly string[]
  /** The redirect URI the authorization was started against (bound). */
  readonly redirectUri: string
  readonly createdAt: number
  readonly expiresAt: number
  /** Outcome once settled. */
  readonly outcome: AuthorizationAttemptOutcome | null
  readonly settledAt: number | null
}

/** The durable outcome of a settled authorization attempt. Never carries the
 *  raw token — only the opaque secret ref + fingerprint the SecretProvider
 *  returned, plus the verified external account identity. */
export interface AuthorizationAttemptOutcome {
  readonly state: AuthorizationAttemptState
  /** Opaque secret ref (SecretProvider) for the exchanged access credential. */
  readonly secretRef: string
  readonly secretFingerprint: string
  /** Verified external account identity (provider identity verification
   *  happened BEFORE the connection was activated). */
  readonly account: ProviderAccountIdentity
  /** Refresh-token secret ref, when a refresh lifecycle applies. Null otherwise. */
  readonly refreshSecretRef: string | null
  /** Absolute expiry of the access credential (ms epoch); null = no expiry. */
  readonly expiresAt: number | null
  /** Whether settlement was a replay (idempotent duplicate callback). */
  readonly replayed: boolean
}

/** Input to start an authorization attempt. */
export interface CreateAuthorizationAttemptInput {
  readonly tenantId: string
  readonly orgId: string
  readonly projectId: string
  readonly principalId: string
  readonly provider: string
  readonly family: ProviderFamily
  readonly method: AuthorizationMethod
  readonly connectionId?: string | null
  readonly scopes?: readonly string[]
  readonly redirectUri: string
  /** Caller-supplied code verifier (PKCE); the challenge is derived. */
  readonly codeVerifier?: string | null
  /** TTL in ms (default 10 min). */
  readonly ttlMs?: number
}

/**
 * A resolved, usable credential handed to an adapter through the resolver.
 * The `secretRef` is opaque to callers — only the configured SecretProvider
 * can dereference it. Adapters never persist or log the dereferenced secret.
 */
export interface ResolvedCredential {
  readonly connectionId: string
  readonly tenantId: string
  readonly orgId: string
  readonly projectId: string
  readonly family: ProviderFamily
  readonly provider: string
  /** Opaque reference the SecretProvider dereferences into a secret value. */
  readonly secretRef: string
  readonly account: ProviderAccountIdentity
  readonly capabilities: readonly ConnectionCapability[]
  /** SHA-256 fingerprint of the secret for dedup/rotation identity (never the secret). */
  readonly secretFingerprint: string
  /** Transient usable secret value; NEVER persisted/logged/audited/serialized.
   *  Crosses the resolver→adapter boundary only, for the duration of one call. */
  readonly secret: string
}

/**
 * Durable connection metadata. The plaintext secret is NEVER in this record.
 * `secretRef` is an opaque pointer the SecretProvider resolves; `secretFingerprint`
 * is a one-way hash used to detect rotation/identity without storing the secret.
 */
export interface ProviderConnection {
  readonly connectionId: string
  readonly tenantId: string
  readonly orgId: string
  readonly projectId: string
  readonly family: ProviderFamily
  /** Concrete provider within the family (e.g. "github-com", "gitlab-com", "openai"). */
  readonly provider: string
  readonly account: ProviderAccountIdentity
  readonly capabilities: readonly ConnectionCapability[]
  readonly state: ConnectionState
  /** Opaque secret reference; never dereferenced by the store. */
  readonly secretRef: string
  /** SHA-256 fingerprint of the secret body (never the secret). */
  readonly secretFingerprint: string
  readonly version: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastUsedAt: number | null
  /** Absolute expiry (ms epoch); null = no expiry. Enforced at resolve time. */
  readonly expiresAt: number | null
  /** connectionId this connection was rotated from (rotation keeps identity stable via version). */
  readonly rotatedFrom: string | null
}

/** Input to create a connection. The secret is supplied through the
 *  SecretProvider which returns the opaque ref + fingerprint; the store never
 *  receives the plaintext. */
export interface CreateConnectionInput {
  readonly tenantId: string
  readonly orgId: string
  readonly projectId: string
  readonly family: ProviderFamily
  readonly provider: string
  readonly account: ProviderAccountIdentity
  readonly capabilities: readonly ConnectionCapability[]
  /** Opaque secret reference returned by SecretProvider.store. */
  readonly secretRef: string
  /** SHA-256 fingerprint returned by SecretProvider.store. */
  readonly secretFingerprint: string
  readonly expiresAt?: number | null
}

/** Error surface for the credential layer. */
export class CredentialError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message)
    this.name = "CredentialError"
  }
}
