/**
 * Phase 2D provider conformance harness.
 *
 * Separates three tiers (per the Phase 2D spec):
 *  - Tier A: deterministic local tests over fakes/PGlite. ALWAYS run.
 *  - Tier B: provider-neutral contract tests every adapter must satisfy.
 *  - Tier C: live vendor conformance, environment-gated and HONESTLY skipped
 *            when credentials/services are absent. A skipped live test is a
 *            SKIP, never a fake pass. Live tests use dedicated test resources
 *            and cleanup; they NEVER run destructive operations against
 *            arbitrary production resources.
 *
 * This file implements Tier A + Tier B (the neutral OAuth adapter contract).
 * Tier C live tests live alongside their adapter packages and gate on the
 * matching environment variable (see the skip policy table in
 * docs/phase2d.md).
 */

import { describe, it, expect } from "vitest"
import {
  OAuthAdapterRegistry,
  InMemorySecretProvider,
  type OAuthProviderAdapter,
  type AuthorizationCapability,
  type ExchangeRequest,
  type ExchangeResult,
  type ProviderAccountIdentity,
  type AuthorizationMethod,
} from "@vaulltcore/credentials"

/** A neutral fake adapter satisfying the {@link OAuthProviderAdapter} contract. */
function fakeAdapter(provider: string, methods: AuthorizationMethod[]): OAuthProviderAdapter {
  const capability: AuthorizationCapability = {
    provider, family: "git", methods, identityKind: "user",
    supportsScopes: true, supportsRefresh: methods.includes("refresh_token"),
    supportsWebhooks: methods.includes("webhook"),
  }
  return {
    capability,
    async exchange(req: ExchangeRequest): Promise<ExchangeResult> {
      const stored = await req.secrets.store(`tok_${req.code}`, {
        tenantId: req.attempt.tenantId, orgId: req.attempt.orgId, projectId: req.attempt.projectId,
        family: req.attempt.family, provider: req.attempt.provider,
      })
      const account: ProviderAccountIdentity = { externalId: `acct-${req.code}`, displayName: "test", scopes: [...req.attempt.scopes] }
      return { secretRef: stored.secretRef, secretFingerprint: stored.fingerprint, account, refreshSecretRef: null, expiresAt: null }
    },
  }
}

describe("Tier A + B — provider-neutral OAuth adapter contract", () => {
  it("an adapter registered in the registry is resolvable by provider", () => {
    const reg = new OAuthAdapterRegistry()
    reg.register(fakeAdapter("github-com", ["oauth_authorization_code", "oauth_pkce", "refresh_token", "webhook", "api_key"]))
    const adapter = reg.resolve("github-com")
    expect(adapter.capability.provider).toBe("github-com")
  })

  it("listCapabilities exposes capability metadata (methods, identityKind, supports*)", () => {
    const reg = new OAuthAdapterRegistry()
    reg.register(fakeAdapter("gitlab-com", ["oauth_authorization_code", "refresh_token"]))
    const caps = reg.listCapabilities()
    expect(caps).toHaveLength(1)
    expect(caps[0]!.methods).toContain("oauth_authorization_code")
    expect(caps[0]!.supportsRefresh).toBe(true)
    expect(caps[0]!.supportsWebhooks).toBe(false)
  })

  it("exchange routes the secret through the SecretProvider and returns only ref+fingerprint+account", async () => {
    const reg = new OAuthAdapterRegistry()
    reg.register(fakeAdapter("github-com", ["oauth_authorization_code"]))
    const adapter = reg.resolve("github-com")
    const secrets = new InMemorySecretProvider()
    const result = await adapter.exchange({
      attempt: {
        attemptId: "a1", state: "s1", tenantId: "t1", orgId: "o1", projectId: "p1", principalId: "u1",
        provider: "github-com", family: "git", method: "oauth_authorization_code",
        connectionId: null, codeChallenge: null, codeVerifier: null, scopes: ["repo"],
        redirectUri: "https://app/cb", createdAt: 0, expiresAt: 0, outcome: null, settledAt: null,
      },
      code: "code-1", codeVerifier: null, redirectUri: "https://app/cb", secrets,
    })
    expect(result.secretRef).toMatch(/mem:/)
    expect(result.secretFingerprint).toMatch(/^sha256:/)
    expect(result.account.externalId).toBe("acct-code-1")
    // The raw token never appears in the result.
    expect(JSON.stringify(result)).not.toContain("tok_code-1")
  })

  it("resolve throws for an unregistered provider (no silent fallback)", () => {
    const reg = new OAuthAdapterRegistry()
    expect(() => reg.resolve("unknown-provider")).toThrow()
  })
})
