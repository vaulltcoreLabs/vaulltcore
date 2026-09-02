/**
 * GitHub OAuth authorization adapter (Phase 2D).
 *
 * Implements the neutral {@link OAuthProviderAdapter} seam for GitHub behind
 * the narrow SSRF-guarded HTTP seam — no GitHub SDK. Exchanges an authorization
 * code for an access token, routes the secret through the {@link SecretProvider}
 * (so only an opaque ref + fingerprint persist), and verifies the provider
 * identity (`GET /user`) BEFORE activation. App-installation identity remains
 * distinguishable from user OAuth identity via the capability's `identityKind`.
 *
 * The raw token never crosses back into the core; the lifecycle activates the
 * connection only after this adapter confirms the verified account.
 */

import { createHash } from "node:crypto"
import type {
  AuthorizationCapability,
  ProviderAccountIdentity,
} from "@vaulltcore/credentials"
import type { OAuthProviderAdapter, ExchangeRequest, ExchangeResult } from "@vaulltcore/credentials"
import { ProviderHttpClient, type ProviderHttpOptions } from "@vaulltcore/integration"

export interface GitHubOAuthAdapterOptions {
  readonly clientId: string
  /** Client secret injected at call time (never stored by the adapter). */
  readonly clientSecretProvider?: () => string | undefined
  /** API base (default https://api.github.com — overridable for GHES). */
  readonly apiBase?: string
  /** OAuth authorize base (default https://github.com). */
  readonly authorizeBase?: string
  readonly http?: ProviderHttpClient
  /** Identity kind: "user" (OAuth) or "app_installation" (GitHub App). */
  readonly identityKind?: "user" | "app_installation"
}

const USER_CAPABILITY: AuthorizationCapability = {
  provider: "github-com",
  family: "git",
  methods: ["oauth_authorization_code", "oauth_pkce", "refresh_token", "webhook", "api_key"],
  identityKind: "user",
  supportsScopes: true,
  supportsRefresh: false,
  supportsWebhooks: true,
}

const APP_CAPABILITY: AuthorizationCapability = {
  provider: "github-com",
  family: "git",
  methods: ["app_installation", "oauth_authorization_code", "refresh_token", "webhook"],
  identityKind: "app_installation",
  supportsScopes: true,
  supportsRefresh: true,
  supportsWebhooks: true,
}

export class GitHubOAuthAdapter implements OAuthProviderAdapter {
  readonly capability: AuthorizationCapability
  private readonly clientId: string
  private readonly clientSecretProvider: (() => string | undefined) | undefined
  private readonly apiBase: string
  private readonly authorizeBase: string
  private readonly http: ProviderHttpClient

  constructor(options: GitHubOAuthAdapterOptions) {
    this.capability = options.identityKind === "app_installation" ? APP_CAPABILITY : USER_CAPABILITY
    this.clientId = options.clientId
    this.clientSecretProvider = options.clientSecretProvider
    this.apiBase = (options.apiBase ?? "https://api.github.com").replace(/\/$/, "")
    this.authorizeBase = (options.authorizeBase ?? "https://github.com").replace(/\/$/, "")
    this.http = options.http ?? new ProviderHttpClient({ allowHttp: false })
  }

  /** Build the authorize URL the client redirects to (state + PKCE bound). */
  buildAuthorizeUrl(state: string, redirectUri: string, codeChallenge: string | null, scopes: readonly string[]): string {
    const params = new URLSearchParams({ client_id: this.clientId, state, redirect_uri: redirectUri })
    if (codeChallenge) { params.set("code_challenge", codeChallenge); params.set("code_challenge_method", "S256") }
    if (scopes.length > 0) params.set("scope", scopes.join(" "))
    return `${this.authorizeBase}/login/oauth/authorize?${params.toString()}`
  }

  async exchange(request: ExchangeRequest): Promise<ExchangeResult> {
    const clientSecret = this.clientSecretProvider?.()
    const body: Record<string, string> = { client_id: this.clientId, code: request.code, redirect_uri: request.redirectUri }
    if (clientSecret) body.client_secret = clientSecret
    if (request.attempt.method === "oauth_pkce" && request.codeVerifier) {
      body.code_verifier = request.codeVerifier
    }
    const res = await this.http.request({
      method: "POST",
      url: `${this.authorizeBase}/login/oauth/access_token`,
      headers: { accept: "application/json", "user-agent": "vaulltcore", "content-type": "application/json" },
      body,
    } as Omit<ProviderHttpOptions, "url"> & { url: string })
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`github token exchange failed: ${res.status}`)
    }
    const tok = JSON.parse(res.body) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; token_type?: string }
    if (!tok.access_token) throw new Error("github token exchange returned no access_token")
    // Route the secret through the SecretProvider: only ref + fingerprint persist.
    const stored = await request.secrets.store(tok.access_token, {
      tenantId: request.attempt.tenantId, orgId: request.attempt.orgId, projectId: request.attempt.projectId,
      family: request.attempt.family, provider: request.attempt.provider,
    })
    const refreshStored = tok.refresh_token
      ? await request.secrets.store(tok.refresh_token, {
        tenantId: request.attempt.tenantId, orgId: request.attempt.orgId, projectId: request.attempt.projectId,
        family: request.attempt.family, provider: request.attempt.provider,
      })
      : null
    // Verify the provider identity BEFORE activation.
    const account = await this.verifyIdentity(tok.access_token)
    const expiresAt = tok.expires_in ? Date.now() + tok.expires_in * 1000 : null
    return {
      secretRef: stored.secretRef,
      secretFingerprint: stored.fingerprint,
      account,
      refreshSecretRef: refreshStored?.secretRef ?? null,
      expiresAt,
    }
  }

  /** Verify the token resolves to a valid GitHub identity (`GET /user`). */
  async verifyIdentity(accessToken: string): Promise<ProviderAccountIdentity> {
    const res = await this.http.request({
      method: "GET",
      url: `${this.apiBase}/user`,
      headers: { authorization: `Bearer ${accessToken}`, "user-agent": "vaulltcore", accept: "application/json" },
    } as Omit<ProviderHttpOptions, "url"> & { url: string })
    if (res.status < 200 || res.status >= 300) throw new Error(`github identity verification failed: ${res.status}`)
    const u = JSON.parse(res.body) as { id?: number | string; login?: string }
    const scopesHeader = res.headers["x-oauth-scopes"] ?? ""
    return {
      externalId: String(u.id ?? ""),
      displayName: u.login ?? null,
      scopes: scopesHeader.split(",").map((s) => s.trim()).filter(Boolean),
    }
  }
}

/** Helper: fingerprint a token before routing through the SecretProvider. */
export function fingerprintToken(token: string): string {
  return "sha256:" + createHash("sha256").update(token).digest("hex")
}
