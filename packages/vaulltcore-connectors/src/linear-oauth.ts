/**
 * Linear OAuth authorization adapter (Phase 2D).
 *
 * Implements the neutral {@link OAuthProviderAdapter} seam for Linear behind
 * the narrow SSRF-guarded HTTP seam — no Linear SDK. Exchanges an
 * authorization code for an API key, routes the secret through the
 * {@link SecretProvider}, and verifies the provider identity (the Linear
 * viewer) BEFORE activation. Linear uses API keys natively; OAuth is supported
 * where an OAuth-style lifecycle genuinely applies.
 */

import type {
  AuthorizationCapability,
  ProviderAccountIdentity,
} from "@vaulltcore/credentials"
import type { OAuthProviderAdapter, ExchangeRequest, ExchangeResult } from "@vaulltcore/credentials"
import { ProviderHttpClient, type ProviderHttpOptions } from "@vaulltcore/integration"

export interface LinearOAuthAdapterOptions {
  readonly clientId: string
  readonly clientSecretProvider?: () => string | undefined
  readonly apiBase?: string
  readonly http?: ProviderHttpClient
}

const CAPABILITY: AuthorizationCapability = {
  provider: "linear",
  family: "project",
  methods: ["oauth_authorization_code", "oauth_pkce", "api_key", "webhook"],
  identityKind: "user",
  supportsScopes: true,
  supportsRefresh: false,
  supportsWebhooks: true,
}

export class LinearOAuthAdapter implements OAuthProviderAdapter {
  readonly capability = CAPABILITY
  private readonly clientId: string
  private readonly clientSecretProvider: (() => string | undefined) | undefined
  private readonly apiBase: string
  private readonly http: ProviderHttpClient

  constructor(options: LinearOAuthAdapterOptions) {
    this.clientId = options.clientId
    this.clientSecretProvider = options.clientSecretProvider
    this.apiBase = (options.apiBase ?? "https://api.linear.app").replace(/\/$/, "")
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
    if (res.status < 200 || res.status >= 300) throw new Error(`linear token exchange failed: ${res.status}`)
    const tok = JSON.parse(res.body) as { access_token?: string }
    if (!tok.access_token) throw new Error("linear token exchange returned no access_token")
    const stored = await request.secrets.store(tok.access_token, {
      tenantId: request.attempt.tenantId, orgId: request.attempt.orgId, projectId: request.attempt.projectId,
      family: request.attempt.family, provider: request.attempt.provider,
    })
    const account = await this.verifyIdentity(tok.access_token)
    return { secretRef: stored.secretRef, secretFingerprint: stored.fingerprint, account, refreshSecretRef: null, expiresAt: null }
  }

  async verifyIdentity(apiKey: string): Promise<ProviderAccountIdentity> {
    const query = JSON.stringify({ query: "query { viewer { id name } }" })
    const res = await this.http.request({
      method: "POST",
      url: `${this.apiBase}/graphql`,
      headers: { authorization: apiKey, "content-type": "application/json", accept: "application/json" },
      body: query,
    } as Omit<ProviderHttpOptions, "url"> & { url: string })
    if (res.status < 200 || res.status >= 300) throw new Error(`linear identity verification failed: ${res.status}`)
    const j = JSON.parse(res.body) as { data?: { viewer?: { id?: string; name?: string } } }
    const viewer = j.data?.viewer
    return { externalId: viewer?.id ?? "", displayName: viewer?.name ?? null, scopes: [] }
  }
}
