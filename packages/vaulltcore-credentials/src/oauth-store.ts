/**
 * Durable OAuth authorization-attempt store (Phase 2D).
 *
 * Owns the authorization lifecycle BEFORE a usable secret crosses the
 * SecretProvider boundary. The `state` nonce is cryptographically random,
 * single-use, and bound durably (tenant/org/project/principal/provider/
 * connection) BEFORE the redirect — so a forged callback cannot select
 * another tenant's connection or replay an old state.
 *
 * Settlement is the one-time linearization point: a duplicate callback returns
 * the original outcome (idempotent) and never creates contradictory state. The
 * PKCE verifier is deleted at settlement; no access/refresh token or client
 * secret is ever stored here — only the opaque ref + fingerprint the
 * SecretProvider returned after the secret has crossed its boundary.
 *
 * Reuses {@link SqlStoreBase} so the atomic-commit boundary + dialect-aware
 * placeholder rewriting are identical to the Phase 1 stores. Every state-
 * changing write is fenced by the UNIQUE `state` constraint (single-use).
 */

import { randomBytes, createHash, timingSafeEqual } from "node:crypto"
import { SqlStoreBase, isUniqueViolation, type SqlDialect, type SqlDatabase } from "@vaulltcore/store-sql"
import {
  type AuthorizationAttempt,
  type AuthorizationAttemptOutcome,
  type AuthorizationAttemptState,
  type AuthorizationMethod,
  type CreateAuthorizationAttemptInput,
  type ProviderAccountIdentity,
  type ProviderFamily,
  CredentialError,
} from "./contracts"

/** PKCE code challenge method (S256 only — plain is rejected). */
export function deriveCodeChallenge(verifier: string): string {
  return "sha256:" + createHash("sha256").update(verifier).digest("base64url")
}

/** Constant-time comparison of the bound state vs the callback state. */
export function safeEqualState(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8")
  const bb = Buffer.from(b, "utf8")
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

interface AttemptRow {
  attempt_id: string
  state: string
  tenant_id: string
  org_id: string
  project_id: string
  principal_id: string
  provider: string
  family: string
  method: string
  connection_id: string | null
  code_challenge: string | null
  code_verifier: string | null
  scopes: string
  redirect_uri: string
  created_at: number
  expires_at: number
  outcome_state: string | null
  outcome_secret_ref: string | null
  outcome_secret_fingerprint: string | null
  outcome_account_external_id: string | null
  outcome_account_display: string | null
  outcome_account_scopes: string | null
  outcome_refresh_secret_ref: string | null
  outcome_expires_at: number | null
  settled_at: number | null
}

function toAttempt(row: AttemptRow): AuthorizationAttempt {
  const outcome: AuthorizationAttemptOutcome | null =
    row.outcome_state === null
      ? null
      : {
          state: row.outcome_state as AuthorizationAttemptState,
          secretRef: row.outcome_secret_ref ?? "",
          secretFingerprint: row.outcome_secret_fingerprint ?? "",
          account: {
            externalId: row.outcome_account_external_id ?? "",
            displayName: row.outcome_account_display,
            scopes: row.outcome_account_scopes ? (JSON.parse(row.outcome_account_scopes) as string[]) : [],
          },
          refreshSecretRef: row.outcome_refresh_secret_ref,
          expiresAt: row.outcome_expires_at,
          replayed: false,
        }
  return {
    attemptId: row.attempt_id,
    state: row.state,
    tenantId: row.tenant_id,
    orgId: row.org_id,
    projectId: row.project_id,
    principalId: row.principal_id,
    provider: row.provider,
    family: row.family as ProviderFamily,
    method: row.method as AuthorizationMethod,
    connectionId: row.connection_id,
    codeChallenge: row.code_challenge,
    codeVerifier: row.code_verifier,
    scopes: JSON.parse(row.scopes) as string[],
    redirectUri: row.redirect_uri,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    outcome,
    settledAt: row.settled_at,
  }
}

/** Callback parameters validated against a durable attempt. The provider code
 *  and state come from the OAuth redirect; tenant/scope come from the durable
 *  attempt (NEVER from the callback body alone). */
export interface CallbackParams {
  readonly state: string
  readonly code: string
  /** Optional PKCE verifier the caller held; checked against the stored
   *  challenge if the attempt used PKCE. */
  readonly codeVerifier?: string | null
}

/** Input to settle an attempt after a successful token exchange + identity
 *  verification. The caller has ALREADY exchanged the code for a token and
 *  verified the provider identity; it passes the opaque secret ref + verified
 *  account — never the raw token. */
export interface SettleAttemptInput {
  readonly attemptId: string
  readonly state: string
  readonly secretRef: string
  readonly secretFingerprint: string
  readonly account: ProviderAccountIdentity
  readonly refreshSecretRef?: string | null
  readonly expiresAt?: number | null
  /** The code verifier to validate against the stored PKCE challenge (if any). */
  readonly codeVerifier?: string | null
}

export interface OAuthStoreOptions {
  readonly dialect?: SqlDialect
  readonly beforeCommit?: (op: string) => void
  /** Clock for expiry (tests). */
  readonly now?: () => number
}

export class SqlAuthorizationAttemptStore extends SqlStoreBase {
  private readonly now: () => number

  constructor(db: SqlDatabase, options: OAuthStoreOptions = {}) {
    super(db, [], { ...(options.dialect ? { dialect: options.dialect } : {}), beforeCommit: options.beforeCommit })
    this.now = options.now ?? Date.now
  }

  /**
   * Create a durable authorization attempt. The `state` nonce is generated,
   * bound to tenant/org/project/principal/provider, and persisted BEFORE the
   * redirect. Returns the attempt (state + PKCE challenge for the redirect).
   * The verifier is stored transiently (deleted at settlement) — callers that
   * prefer to hold the verifier client-side may pass it; it is still stored so
   * a stateless callback can complete settlement.
   */
  async createAttempt(input: CreateAuthorizationAttemptInput): Promise<AuthorizationAttempt> {
    const attemptId = `auth_${randomBytes(12).toString("base64url")}`
    const state = randomBytes(24).toString("base64url")
    const now = this.now()
    const ttlMs = input.ttlMs ?? 10 * 60 * 1000
    const codeChallenge = input.codeVerifier ? deriveCodeChallenge(input.codeVerifier) : null
    const row = {
      attemptId,
      state,
      tenantId: input.tenantId,
      orgId: input.orgId,
      projectId: input.projectId,
      principalId: input.principalId,
      provider: input.provider,
      family: input.family,
      method: input.method,
      connectionId: input.connectionId ?? null,
      codeChallenge,
      codeVerifier: input.codeVerifier ?? null,
      scopes: JSON.stringify(input.scopes ?? []),
      redirectUri: input.redirectUri,
      createdAt: now,
      expiresAt: now + ttlMs,
    }
    this.atomic("createAttempt", () => {
      this.prepare(
        `INSERT INTO authorization_attempts (
          attempt_id, state, tenant_id, org_id, project_id, principal_id, provider, family,
          method, connection_id, code_challenge, code_verifier, scopes, redirect_uri,
          created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.attemptId, row.state, row.tenantId, row.orgId, row.projectId, row.principalId, row.provider, row.family,
        row.method, row.connectionId, row.codeChallenge, row.codeVerifier, row.scopes, row.redirectUri,
        row.createdAt, row.expiresAt,
      )
    })
    const inserted = this.prepare("SELECT * FROM authorization_attempts WHERE attempt_id = ?").get(attemptId) as unknown as AttemptRow
    return toAttempt(inserted)
  }

  /** Load an attempt by its state nonce (tenant-scoped). Returns null on miss
   *  (no cross-tenant existence leak). */
  async getByState(tenantId: string, state: string): Promise<AuthorizationAttempt | null> {
    const row = this.prepare("SELECT * FROM authorization_attempts WHERE tenant_id = ? AND state = ?").get(tenantId, state) as unknown as AttemptRow | undefined
    return row ? toAttempt(row) : null
  }

  /** Resolve an attempt from the state nonce ALONE (no tenant). Used by the
   *  UNAUTHENTICATED OAuth callback: the state is a high-entropy nonce bound
   *  to the attempt before redirect, so it is the trust root — the tenant is
   *  then taken from the durable attempt, never from the callback query. */
  getByStateGlobal(state: string): AuthorizationAttempt | null {
    const row = this.prepare("SELECT * FROM authorization_attempts WHERE state = ?").get(state) as unknown as AttemptRow | undefined
    return row ? toAttempt(row) : null
  }

  /** Load an attempt by id (tenant-scoped). */
  async get(tenantId: string, attemptId: string): Promise<AuthorizationAttempt | null> {
    const row = this.prepare("SELECT * FROM authorization_attempts WHERE tenant_id = ? AND attempt_id = ?").get(tenantId, attemptId) as unknown as AttemptRow | undefined
    return row ? toAttempt(row) : null
  }

  /**
   * Validate a callback against a durable attempt. Enforces:
   *  - the attempt exists and is tenant-scoped (no cross-tenant leak);
   *  - the state matches (constant-time);
   *  - the attempt is not expired;
   *  - the attempt is not already settled (the caller handles replay);
   *  - the PKCE verifier matches the stored challenge (when PKCE was used).
   * Returns the validated attempt or throws a CredentialError describing the
   * precise failure (callback_rejected audit maps these).
   */
  async validateCallback(tenantId: string, params: CallbackParams): Promise<AuthorizationAttempt> {
    const attempt = await this.getByState(tenantId, params.state)
    if (!attempt) throw new CredentialError("STATE_NOT_FOUND", "authorization state not found", 404)
    if (!safeEqualState(attempt.state, params.state)) {
      // unreachable due to getByState, but defense-in-depth.
      throw new CredentialError("STATE_MISMATCH", "authorization state mismatch", 400)
    }
    const now = this.now()
    if (attempt.expiresAt <= now) {
      // Mark expired so it cannot be settled later.
      this.atomic("expireAttempt", () => {
        this.prepare("UPDATE authorization_attempts SET outcome_state = 'expired', settled_at = ? WHERE attempt_id = ? AND outcome_state IS NULL")
          .run(now, attempt.attemptId)
      })
      throw new CredentialError("ATTEMPT_EXPIRED", "authorization attempt expired", 410)
    }
    if (attempt.outcome !== null && attempt.outcome.state !== "pending") {
      // Already settled — caller uses settleAttempt's replay path.
      return attempt
    }
    // PKCE verifier check (when the attempt used PKCE).
    if (attempt.codeChallenge !== null) {
      const verifier = params.codeVerifier ?? null
      if (!verifier) throw new CredentialError("PKCE_VERIFIER_REQUIRED", "PKCE code verifier required", 400)
      const challenge = deriveCodeChallenge(verifier)
      if (!safeEqualState(challenge, attempt.codeChallenge)) {
        throw new CredentialError("PKCE_VERIFIER_MISMATCH", "PKCE code verifier does not match the challenge", 400)
      }
    }
    return attempt
  }

  /**
   * Settle an attempt one-time with the exchanged + verified credential. This
   * is the linearization point: a duplicate settlement (replayed callback)
   * returns the original outcome and never creates contradictory state. The
   * PKCE verifier is deleted at settlement. The raw token never enters this
   * store — only the opaque ref + fingerprint.
   *
   * Returns { attempt, replayed }.
   */
  async settleAttempt(input: SettleAttemptInput): Promise<{ attempt: AuthorizationAttempt; replayed: boolean }> {
    // Re-validate PKCE if the caller supplied a verifier and the attempt used PKCE.
    const existing = this.prepare("SELECT * FROM authorization_attempts WHERE attempt_id = ? AND state = ?").get(input.attemptId, input.state) as unknown as AttemptRow | undefined
    if (!existing) throw new CredentialError("ATTEMPT_NOT_FOUND", "authorization attempt not found", 404)
    if (existing.tenant_id !== existing.tenant_id) throw new CredentialError("ATTEMPT_NOT_FOUND", "authorization attempt not found", 404)
    const attempt = toAttempt(existing)
    const now = this.now()
    if (attempt.expiresAt <= now && attempt.outcome === null) {
      throw new CredentialError("ATTEMPT_EXPIRED", "authorization attempt expired", 410)
    }
    if (attempt.codeChallenge !== null && input.codeVerifier) {
      const challenge = deriveCodeChallenge(input.codeVerifier)
      if (!safeEqualState(challenge, attempt.codeChallenge)) {
        throw new CredentialError("PKCE_VERIFIER_MISMATCH", "PKCE code verifier does not match the challenge", 400)
      }
    }
    // Idempotent replay: if already verified/consumed, return the original outcome.
    if (attempt.outcome !== null && (attempt.outcome.state === "verified" || attempt.outcome.state === "consumed")) {
      const replayed: AuthorizationAttempt = { ...attempt, outcome: { ...attempt.outcome, replayed: true } }
      return { attempt: replayed, replayed: true }
    }
    // One-time settlement. The conditional update (outcome_state IS NULL) makes
    // a concurrent duplicate settle return the winner's outcome.
    const accountScopes = JSON.stringify(input.account.scopes)
    const result = this.prepare(
      `UPDATE authorization_attempts SET
        outcome_state = 'verified',
        outcome_secret_ref = ?,
        outcome_secret_fingerprint = ?,
        outcome_account_external_id = ?,
        outcome_account_display = ?,
        outcome_account_scopes = ?,
        outcome_refresh_secret_ref = ?,
        outcome_expires_at = ?,
        code_verifier = NULL,
        settled_at = ?
       WHERE attempt_id = ? AND state = ? AND outcome_state IS NULL`,
    ).run(
      input.secretRef, input.secretFingerprint, input.account.externalId, input.account.displayName,
      accountScopes, input.refreshSecretRef ?? null, input.expiresAt ?? null, now, input.attemptId, input.state,
    )
    if (result.changes === 0) {
      // A concurrent settler won: return its outcome as a replay.
      const fresh = this.prepare("SELECT * FROM authorization_attempts WHERE attempt_id = ?").get(input.attemptId) as unknown as AttemptRow
      const replayed = toAttempt(fresh)
      return { attempt: { ...replayed, outcome: replayed.outcome ? { ...replayed.outcome, replayed: true } : null }, replayed: true }
    }
    const fresh = this.prepare("SELECT * FROM authorization_attempts WHERE attempt_id = ?").get(input.attemptId) as unknown as AttemptRow
    return { attempt: toAttempt(fresh), replayed: false }
  }

  /** Mark an attempt consumed (the connection has been activated from it).
   *  Idempotent. */
  async consume(tenantId: string, attemptId: string): Promise<void> {
    this.atomic("consumeAttempt", () => {
      this.prepare("UPDATE authorization_attempts SET outcome_state = 'consumed' WHERE attempt_id = ? AND tenant_id = ? AND outcome_state = 'verified'")
        .run(attemptId, tenantId)
    })
  }

  /** Mark an attempt failed (retriable terminal). Idempotent. */
  async fail(tenantId: string, attemptId: string, reason: string): Promise<void> {
    this.atomic("failAttempt", () => {
      this.prepare("UPDATE authorization_attempts SET outcome_state = 'failed', settled_at = ? WHERE attempt_id = ? AND tenant_id = ? AND outcome_state IS NULL")
        .run(this.now(), attemptId, tenantId)
      void reason
    })
  }

  /** List expired-but-unsettled attempts (reaper input). */
  async listExpired(now = this.now()): Promise<AuthorizationAttempt[]> {
    const rows = this.prepare("SELECT * FROM authorization_attempts WHERE outcome_state IS NULL AND expires_at <= ?").all(now) as unknown as AttemptRow[]
    return rows.map(toAttempt)
  }
}
