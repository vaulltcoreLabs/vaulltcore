/**
 * Provider-neutral OAuth adapter seam (Phase 2D).
 *
 * An {@link OAuthProviderAdapter} performs token exchange + provider identity
 * verification for a concrete provider, behind the existing neutral provider
 * seams. It receives the durable attempt's bound scope (tenant/org/project/
 * principal/provider) and the callback's `code`/`state` — NEVER trust scope
 * from the callback body alone. It returns the opaque secret ref + fingerprint
 * (by routing the exchanged secret through the {@link SecretProvider}) plus the
 * verified external account identity. The raw token never crosses back into the
 * core; activation only happens after verification succeeds.
 *
 * No provider SDK is a core dependency. Adapters use the narrow SSRF-guarded
 * HTTP seam. GitHub/GitLab app-installation identity stays distinguishable
 * from user OAuth identity via the capability's `identityKind`.
 */

import type { AuthorizationCapability, ProviderAccountIdentity, AuthorizationMethod } from "./contracts"
import type { SecretProvider } from "./secret-provider"
import type { AuthorizationAttempt } from "./contracts"

/** Result of exchanging an authorization code + verifying identity. The raw
 *  secret has ALREADY been routed through the SecretProvider; only the opaque
 *  ref + fingerprint + verified account are returned. */
export interface ExchangeResult {
  readonly secretRef: string
  readonly secretFingerprint: string
  readonly account: ProviderAccountIdentity
  /** Refresh-token secret ref when the provider supports refresh; null otherwise. */
  readonly refreshSecretRef: string | null
  /** Absolute expiry of the access credential (ms epoch); null = no expiry. */
  readonly expiresAt: number | null
}

/** Parameters handed to an OAuth adapter for token exchange. The scope comes
 *  from the durable attempt (bound before redirect), never from the callback. */
export interface ExchangeRequest {
  readonly attempt: AuthorizationAttempt
  readonly code: string
  readonly codeVerifier: string | null
  readonly redirectUri: string
  readonly secrets: SecretProvider
}

/**
 * Neutral OAuth adapter: exchange an authorization code for a credential,
 * route the secret through the SecretProvider, and verify the provider
 * identity — all behind the existing capability/secret seams. Activation of
 * the connection happens ONLY after this succeeds.
 */
export interface OAuthProviderAdapter {
  readonly capability: AuthorizationCapability
  /** Exchange a code (from a validated callback) for a verified credential. */
  exchange(request: ExchangeRequest): Promise<ExchangeResult>
}

/**
 * Registry of OAuth adapters keyed by provider. The control plane resolves an
 * adapter by provider capability (never provider-name conditionals). Adding a
 * provider never touches the registry's callers.
 */
export class OAuthAdapterRegistry {
  private readonly adapters = new Map<string, OAuthProviderAdapter>()

  register(adapter: OAuthProviderAdapter): void {
    const key = adapter.capability.provider
    if (this.adapters.has(key)) throw new Error(`oauth adapter already registered for ${key}`)
    this.adapters.set(key, adapter)
  }

  resolve(provider: string): OAuthProviderAdapter {
    const a = this.adapters.get(provider)
    if (!a) throw new Error(`no oauth adapter registered for ${provider}`)
    return a
  }

  /** List declared authorization capabilities (the control plane exposes these
   *  so the client chooses a flow by capability, not by provider name). */
  listCapabilities(): AuthorizationCapability[] {
    return [...this.adapters.values()].map((a) => a.capability)
  }
}

/** Convenience: whether a method is an OAuth code flow (PKCE or plain). */
export function isOAuthCodeFlow(method: AuthorizationMethod): boolean {
  return method === "oauth_authorization_code" || method === "oauth_pkce"
}
