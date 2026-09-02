/**
 * Slack OAuth authorization adapter (Phase 2D).
 *
 * Implements the neutral {@link OAuthProviderAdapter} seam for Slack behind the
 * narrow SSRF-guarded HTTP seam — no Slack SDK. Exchanges an authorization code
 * for a bot/user token, routes the secret through the {@link SecretProvider},
 * and verifies the provider identity (`auth.test`) BEFORE activation. Slack
 * workspace identity (team id) is the durable external id.
 */

import type {
  AuthorizationCapability,
  ProviderAccountIdentity,
} from "@vaulltcore/credentials"
import type { OAuthProviderAdapter, ExchangeRequest, ExchangeResult } from "@vaulltcore/credentials"
import { ProviderHttpClient, type ProviderHttpOptions } from "@vaulltcore/integration"

export interface SlackOAuthAdapterOptions {
  readonly clientId: string
  readonly clientSecretProvider?: () => string | undefined
  readonly apiBase?: string
  readonly http?: ProviderHttpClient
}

const CAPABILITY: AuthorizationCapability = {
  provider: "slack",
  family: "notification",
  methods: ["oauth_authorization_code", "oauth_pkce", "webhook", "api_key"],
  identityKind: "user",
  supportsScopes: true,
  supportsRefresh: false,
  supportsWebhooks: true,
}

export class SlackOAuthAdapter implements OAuthProviderAdapter {
  readonly capability = CAPABILITY
  private readonly clientId: string
  private readonly clientSecretProvider: (() => string | undefined) | undefined
  private readonly apiBase: string
  private readonly http: ProviderHttpClient

  constructor(options: SlackOAuthAdapterOptions) {
    this.clientId = options.clientId
    this.clientSecretProvider = options.clientSecretProvider
    this.apiBase = (options.apiBase ?? "https://slack.com").replace(/\/$/, "")
    this.http = options.http ?? new ProviderHttpClient({ allowHttp: false })
  }

  buildAuthorizeUrl(state: string, redirectUri: string, _codeChallenge: string | null, scopes: readonly string[]): string {
    const params = new URLSearchParams({ client_id: this.clientId, state, redirect_uri: redirectUri, scope: scopes.join(" ") })
    return `${this.apiBase}/oauth/v2/authorize?${params.toString()}`
  }

  async exchange(request: ExchangeRequest): Promise<ExchangeResult> {
    const clientSecret = this.clientSecretProvider?.()
    const body: Record<string, string> = { client_id: this.clientId, code: request.code, redirect_uri: request.redirectUri, grant_type: "authorization_code" }
    if (clientSecret) body.client_secret = clientSecret
    const res = await this.http.request({
      method: "POST",
      url: `${this.apiBase}/api/oauth.v2.access`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    } as Omit<ProviderHttpOptions, "url"> & { url: string })
    if (res.status < 200 || res.status >= 300) throw new Error(`slack token exchange failed: ${res.status}`)
    const tok = JSON.parse(res.body) as { access_token?: string; authed_user?: { id?: string }; team?: { id?: string; name?: string }; scope?: string; token_type?: string }
    if (!tok.access_token) throw new Error("slack token exchange returned no access_token")
    const stored = await request.secrets.store(tok.access_token, {
      tenantId: request.attempt.tenantId, orgId: request.attempt.orgId, projectId: request.attempt.projectId,
      family: request.attempt.family, provider: request.attempt.provider,
    })
    const account = await this.verifyIdentity(tok.access_token)
    return { secretRef: stored.secretRef, secretFingerprint: stored.fingerprint, account, refreshSecretRef: null, expiresAt: null }
  }

  async verifyIdentity(accessToken: string): Promise<ProviderAccountIdentity> {
    const res = await this.http.request({
      method: "POST",
      url: `${this.apiBase}/api/auth.test`,
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/x-www-form-urlencoded" },
      body: "",
    } as Omit<ProviderHttpOptions, "url"> & { url: string })
    if (res.status < 200 || res.status >= 300) throw new Error(`slack identity verification failed: ${res.status}`)
    const j = JSON.parse(res.body) as { ok?: boolean; team_id?: string; team?: string; user?: string }
    if (!j.ok) throw new Error("slack auth.test returned not ok")
    return { externalId: j.team_id ?? "", displayName: j.team ?? null, scopes: [] }
  }
}
