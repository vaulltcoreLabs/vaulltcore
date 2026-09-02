/**
 * GitLab OAuth authorization adapter (Phase 2D).
 *
 * Implements the neutral {@link OAuthProviderAdapter} seam for GitLab behind
 * the narrow SSRF-guarded HTTP seam — no GitLab SDK. Exchanges an authorization
 * code for an access token, routes the secret through the {@link SecretProvider},
 * and verifies the provider identity (`GET /api/v4/user`) BEFORE activation.
 */

import type {
  AuthorizationCapability,
  ProviderAccountIdentity,
} from "@vaulltcore/credentials"
import type { OAuthProviderAdapter, ExchangeRequest, ExchangeResult } from "@vaulltcore/credentials"
import { ProviderHttpClient, type ProviderHttpOptions } from "@vaulltcore/integration"

export interface GitLabOAuthAdapterOptions {
  readonly clientId: string
  readonly clientSecretProvider?: () => string | undefined
  readonly apiBase?: string
  readonly http?: ProviderHttpClient
}

const CAPABILITY: AuthorizationCapability = {
  provider: "gitlab-com",
  family: "git",
  methods: ["oauth_authorization_code", "oauth_pkce", "refresh_token", "webhook", "api_key"],
  identityKind: "user",
  supportsScopes: true,
  supportsRefresh: true,
  supportsWebhooks: true,
}

export class GitLabOAuthAdapter implements OAuthProviderAdapter {
  readonly capability = CAPABILITY
  private readonly clientId: string
  private readonly clientSecretProvider: (() => string | undefined) | undefined
  private readonly apiBase: string
  private readonly http: ProviderHttpClient

  constructor(options: GitLabOAuthAdapterOptions) {
    this.clientId = options.clientId
    this.clientSecretProvider = options.clientSecretProvider
    this.apiBase = (options.apiBase ?? "https://gitlab.com").replace(/\/$/, "")
    this.http = options.http ?? new ProviderHttpClient({ allowHttp: false })
  }

  buildAuthorizeUrl(state: string, redirectUri: string, codeChallenge: string | null, scopes: readonly string[]): string {
    const params = new URLSearchParams({ client_id: this.clientId, state, redirect_uri: redirectUri, response_type: "code" })
    if (codeChallenge) { params.set("code_challenge", codeChallenge); params.set("code_challenge_method", "S256") }
    if (scopes.length > 0) params.set("scope", scopes.join(" "))
    return `${this.apiBase}/oauth/authorize?${params.toString()}`
  }

  async exchange(request: ExchangeRequest): Promise<ExchangeResult> {
    const clientSecret = this.clientSecretProvider?.()
    const body: Record<string, string> = { client_id: this.clientId, code: request.code, grant_type: "authorization_code", redirect_uri: request.redirectUri }
    if (clientSecret) body.client_secret = clientSecret
    if (request.attempt.method === "oauth_pkce" && request.codeVerifier) body.code_verifier = request.codeVerifier
    const res = await this.http.request({
      method: "POST",
      url: `${this.apiBase}/oauth/token`,
      headers: { "content-type": "application/json", accept: "application/json" },
      body,
    } as Omit<ProviderHttpOptions, "url"> & { url: string })
    if (res.status < 200 || res.status >= 300) throw new Error(`gitlab token exchange failed: ${res.status}`)
    const tok = JSON.parse(res.body) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string }
    if (!tok.access_token) throw new Error("gitlab token exchange returned no access_token")
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
    const account = await this.verifyIdentity(tok.access_token)
    const expiresAt = tok.expires_in ? Date.now() + tok.expires_in * 1000 : null
    return { secretRef: stored.secretRef, secretFingerprint: stored.fingerprint, account, refreshSecretRef: refreshStored?.secretRef ?? null, expiresAt }
  }

  async verifyIdentity(accessToken: string): Promise<ProviderAccountIdentity> {
    const res = await this.http.request({
      method: "GET",
      url: `${this.apiBase}/api/v4/user`,
      headers: { authorization: `Bearer ${accessToken}` },
    } as Omit<ProviderHttpOptions, "url"> & { url: string })
    if (res.status < 200 || res.status >= 300) throw new Error(`gitlab identity verification failed: ${res.status}`)
    const u = JSON.parse(res.body) as { id?: number | string; username?: string }
    return { externalId: String(u.id ?? ""), displayName: u.username ?? null, scopes: [] }
  }
}
