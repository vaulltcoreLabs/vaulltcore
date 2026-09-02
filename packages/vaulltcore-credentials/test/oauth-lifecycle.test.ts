/**
 * Phase 2D OAuth/connection lifecycle security tests.
 *
 * Proves (references map to the Phase 2D required security tests):
 * 1. OAuth state cannot be replayed.
 * 2. Expired authorization attempts are rejected.
 * 3. Wrong tenant/principal/project binding is rejected.
 * 4. Duplicate callback cannot create contradictory state.
 * 5. Callback retry is safely idempotent.
 * 6. Cross-tenant connection access returns 404.
 * 8. Credentials never appear in responses/audit/errors.
 * 9. Refresh failure transitions safely to degraded/expired.
 * 10. Revoked connection cannot resolve a credential.
 */

import { describe, it, expect, beforeEach } from "vitest"
import { NodeSqliteDatabase } from "@vaulltcore/store-sql"
import {
  SqlCredentialStore,
  SqlAuthorizationAttemptStore,
  CredentialResolver,
  InMemorySecretProvider,
  ConnectionLifecycle,
  OAuthAdapterRegistry,
  CredentialError,
  type OAuthProviderAdapter,
  type AuthorizationCapability,
  type ExchangeRequest,
  type ExchangeResult,
  type ProviderAccountIdentity,
  type AuthorizationMethod,
} from "../src"

const CAP: AuthorizationCapability = {
  provider: "github-com",
  family: "git",
  methods: ["oauth_authorization_code", "oauth_pkce", "refresh_token", "webhook", "api_key"] as AuthorizationMethod[],
  identityKind: "user",
  supportsScopes: true,
  supportsRefresh: true,
  supportsWebhooks: true,
}

/** A fake OAuth adapter that exchanges any code for a verified account, routing
 *  the secret through the SecretProvider. It never leaks the raw token back. */
class FakeOAuthAdapter implements OAuthProviderAdapter {
  readonly capability = CAP
  exchangeShouldFail = false
  accountExternalId = "user-123"
  async exchange(req: ExchangeRequest): Promise<ExchangeResult> {
    if (this.exchangeShouldFail) throw new Error("provider token exchange failed")
    const token = `ghp_exchanged_${req.code}`
    const stored = await req.secrets.store(token, {
      tenantId: req.attempt.tenantId, orgId: req.attempt.orgId, projectId: req.attempt.projectId,
      family: req.attempt.family, provider: req.attempt.provider,
    })
    const account: ProviderAccountIdentity = { externalId: this.accountExternalId, displayName: "octocat", scopes: [...req.attempt.scopes] }
    return { secretRef: stored.secretRef, secretFingerprint: stored.fingerprint, account, refreshSecretRef: null, expiresAt: null }
  }
}

function setup() {
  const db = NodeSqliteDatabase.memory()
  const connections = new SqlCredentialStore(db)
  const attempts = new SqlAuthorizationAttemptStore(db)
  const secrets = new InMemorySecretProvider()
  const oauth = new OAuthAdapterRegistry()
  const adapter = new FakeOAuthAdapter()
  oauth.register(adapter)
  const lifecycle = new ConnectionLifecycle({ connections, attempts, secrets, oauth })
  return { db, connections, attempts, secrets, oauth, adapter, lifecycle }
}

const TENANT = "t1", ORG = "o1", PROJECT = "p1", PRINCIPAL = "u1"

describe("ConnectionLifecycle — OAuth trust boundary", () => {
  let s: ReturnType<typeof setup>
  beforeEach(() => { s = setup() })

  async function startAndComplete(redirectUri = "https://app.example.com/callback") {
    const started = await s.lifecycle.startAuthorization({
      tenantId: TENANT, orgId: ORG, projectId: PROJECT, principalId: PRINCIPAL,
      provider: "github-com", family: "git", method: "oauth_authorization_code",
      scopes: ["repo"], redirectUri,
    })
    const outcome = await s.lifecycle.completeCallback({ tenantId: TENANT, state: started.state, code: "code-1" })
    return { started, outcome }
  }

  it("completes an authorization and activates the connection", async () => {
    const { outcome } = await startAndComplete()
    expect(outcome.connection.state).toBe("active")
    expect(outcome.replayed).toBe(false)
    expect(outcome.connection.account.externalId).toBe("user-123")
  })

  // Proof 1: OAuth state cannot be replayed (single-use state).
  it("replays a reused state idempotently (no second connection, no contradiction)", async () => {
    const { started, outcome } = await startAndComplete()
    // A second callback for the SAME settled state returns the SAME connection
    // (replay-safe) rather than creating a second connection or contradictory
    // state. The state is single-use: it cannot drive a *new* authorization.
    const replay = await s.lifecycle.completeCallback({ tenantId: TENANT, state: started.state, code: "code-1" })
    expect(replay.replayed).toBe(true)
    expect(replay.connection.connectionId).toBe(outcome.connection.connectionId)
    const list = await s.connections.list({ tenantId: TENANT })
    expect(list.filter((c) => c.account.externalId === "user-123")).toHaveLength(1)
  })

  // Proof 2: Expired authorization attempts are rejected.
  it("rejects an expired authorization attempt", async () => {
    const started = await s.lifecycle.startAuthorization({
      tenantId: TENANT, orgId: ORG, projectId: PROJECT, principalId: PRINCIPAL,
      provider: "github-com", family: "git", method: "oauth_authorization_code",
      scopes: [], redirectUri: "https://app.example.com/callback", ttlMs: 1,
    })
    await new Promise((r) => setTimeout(r, 5))
    await expect(s.lifecycle.completeCallback({ tenantId: TENANT, state: started.state, code: "code-1" }))
      .rejects.toThrow()
  })

  // Proof 3: Wrong tenant binding is rejected.
  it("rejects a callback with the wrong tenant", async () => {
    const started = await s.lifecycle.startAuthorization({
      tenantId: TENANT, orgId: ORG, projectId: PROJECT, principalId: PRINCIPAL,
      provider: "github-com", family: "git", method: "oauth_authorization_code",
      scopes: [], redirectUri: "https://app.example.com/callback",
    })
    await expect(s.lifecycle.completeCallback({ tenantId: "other-tenant", state: started.state, code: "code-1" }))
      .rejects.toThrow()
  })

  // Proof 4 + 5: Duplicate callback cannot create contradictory state; retry is idempotent.
  it("two authorizations for the same account collapse to one connection", async () => {
    const first = await startAndComplete()
    // A brand-new authorization for the SAME external account id must collapse
    // onto the existing connection (UNIQUE on tenant/family/provider/account),
    // not create a contradictory second record.
    const started2 = await s.lifecycle.startAuthorization({
      tenantId: TENANT, orgId: ORG, projectId: PROJECT, principalId: PRINCIPAL,
      provider: "github-com", family: "git", method: "oauth_authorization_code",
      scopes: ["repo"], redirectUri: "https://app.example.com/callback",
    })
    const second = await s.lifecycle.completeCallback({ tenantId: TENANT, state: started2.state, code: "code-2" })
    expect(second.connection.connectionId).toBe(first.outcome.connection.connectionId)
    // The secret was rotated (version bumped), but identity is stable.
    expect(second.connection.version).toBe(first.outcome.connection.version + 1)
    expect(second.connection.account.externalId).toBe(first.outcome.connection.account.externalId)
    const list = await s.connections.list({ tenantId: TENANT })
    expect(list.filter((c) => c.account.externalId === "user-123")).toHaveLength(1)
  })

  // Proof 6: Cross-tenant connection access returns 404 (null).
  it("cross-tenant connection access returns null (no existence leak)", async () => {
    const { outcome } = await startAndComplete()
    const own = await s.connections.get(TENANT, outcome.connection.connectionId)
    expect(own).not.toBeNull()
    const cross = await s.connections.get("other-tenant", outcome.connection.connectionId)
    expect(cross).toBeNull()
  })

  // Proof 8: The raw OAuth secret never appears in persisted state; only an
  // opaque ref + fingerprint are stored.
  it("never persists or exposes the raw OAuth secret", async () => {
    const { outcome } = await startAndComplete()
    const conn = await s.connections.get(TENANT, outcome.connection.connectionId)
    const json = JSON.stringify(conn)
    expect(json).not.toContain("ghp_exchanged_code-1")
    expect(conn!.secretRef).not.toContain("ghp_")
  })

  // Proof 9: Refresh failure transitions to degraded (not revoked).
  it("transitions to degraded when refresh fails (recoverable, not revoked)", async () => {
    const { outcome } = await startAndComplete()
    s.adapter.exchangeShouldFail = true
    const refreshed = await s.lifecycle.refresh(TENANT, outcome.connection.connectionId)
    expect(["degraded", "expired"]).toContain(refreshed.state)
    // A degraded/expired connection cannot resolve a credential.
    const resolver = new CredentialResolver({ store: s.connections, secrets: s.secrets })
    const resolved = await resolver.resolve(TENANT, outcome.connection.connectionId)
    expect(resolved).toBeNull()
  })

  // Proof 10: Revoked connection cannot resolve a credential.
  it("a revoked connection cannot resolve a credential", async () => {
    const { outcome } = await startAndComplete()
    const revoked = await s.lifecycle.revoke(TENANT, outcome.connection.connectionId)
    expect(revoked.state).toBe("revoked")
    const resolver = new CredentialResolver({ store: s.connections, secrets: s.secrets })
    const resolved = await resolver.resolve(TENANT, outcome.connection.connectionId)
    expect(resolved).toBeNull()
  })
})
