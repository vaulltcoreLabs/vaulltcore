import { describe, it, expect, beforeEach } from "vitest"
import {
  SqlCredentialStore,
  CredentialResolver,
  InMemorySecretProvider,
  CredentialError,
  toPublicView,
  type ProviderConnection,
} from "../src"
import type { SecretProvider, StoredSecret } from "../src"
import { NodeSqliteDatabase } from "@vaulltcore/store-sql"

/** A SecretProvider whose resolve() fails after N calls (transient fault tests). */
class FlakySecretProvider implements SecretProvider {
  private readonly inner = new InMemorySecretProvider()
  failNext = 0
  async store(secret: string, scope: { tenantId: string; orgId: string; projectId: string; family: string; provider: string }): Promise<StoredSecret> {
    return this.inner.store(secret, scope)
  }
  async resolve(secretRef: string): Promise<string | null> {
    if (this.failNext > 0) { this.failNext--; throw new Error("transient secret backend outage") }
    return this.inner.resolve(secretRef)
  }
  async delete(secretRef: string): Promise<void> { return this.inner.delete(secretRef) }
}

function createStore() {
  const db = NodeSqliteDatabase.memory()
  return new SqlCredentialStore(db)
}

async function createConnection(store: SqlCredentialStore, secrets: SecretProvider, tenantId = "t1", connectionId?: string) {
  const stored = await secrets.store("ghp_secret_value_1234567890", { tenantId, orgId: "o1", projectId: "p1", family: "git", provider: "github-com" })
  return store.create({
    tenantId, orgId: "o1", projectId: "p1", family: "git", provider: "github-com",
    account: { externalId: "inst-123", displayName: "acme", scopes: ["repo"] },
    capabilities: ["repo:read", "repo:write", "issue:read", "issue:write"],
    secretRef: stored.secretRef, secretFingerprint: stored.fingerprint,
  })
}

describe("SqlCredentialStore", () => {
  let store: SqlCredentialStore
  let secrets: SecretProvider
  beforeEach(() => { store = createStore(); secrets = new InMemorySecretProvider() })

  it("creates a connection and lists it tenant-scoped", async () => {
    const c = await createConnection(store, secrets)
    expect(c.state).toBe("active")
    expect(c.version).toBe(1)
    const list = await store.list({ tenantId: "t1" })
    expect(list).toHaveLength(1)
    // cross-tenant list returns nothing
    expect(await store.list({ tenantId: "other" })).toHaveLength(0)
  })

  it("rejects duplicate (tenant, family, provider, account) with CONNECTION_EXISTS", async () => {
    await createConnection(store, secrets)
    await expect(createConnection(store, secrets)).rejects.toMatchObject({ code: "CONNECTION_EXISTS" })
  })

  it("get is tenant-scoped (cross-tenant returns null, no leak)", async () => {
    const c = await createConnection(store, secrets)
    expect(await store.get("t1", c.connectionId)).toBeTruthy()
    expect(await store.get("other", c.connectionId)).toBeNull()
  })

  it("rotates the secret without changing identity/scope, fenced by version", async () => {
    const c = await createConnection(store, secrets)
    const stored2 = await secrets.store("ghp_rotated_secret_9876543210", { tenantId: "t1", orgId: "o1", projectId: "p1", family: "git", provider: "github-com" })
    const rotated = await store.rotate("t1", c.connectionId, c.version, stored2.secretRef, stored2.fingerprint)
    expect(rotated.version).toBe(2)
    expect(rotated.connectionId).toBe(c.connectionId)
    expect(rotated.tenantId).toBe(c.tenantId)
    expect(rotated.secretFingerprint).toBe(stored2.fingerprint)
    // stale version cannot rotate again
    await expect(store.rotate("t1", c.connectionId, c.version, stored2.secretRef, stored2.fingerprint)).rejects.toMatchObject({ code: "VERSION_CONFLICT" })
  })

  it("revokes and disconnects; revoked resolves to null", async () => {
    const c = await createConnection(store, secrets)
    const revoked = await store.revoke("t1", c.connectionId, c.version)
    expect(revoked.state).toBe("revoked")
    expect(revoked.version).toBe(2)
    const resolver = new CredentialResolver({ store, secrets })
    expect(await resolver.resolve("t1", c.connectionId)).toBeNull()
  })

  it("expired connection resolves to null and is parked expired", async () => {
    const stored = await secrets.store("ghp_short_lived_1234567890", { tenantId: "t1", orgId: "o1", projectId: "p1", family: "git", provider: "github-com" })
    const c = await store.create({
      tenantId: "t1", orgId: "o1", projectId: "p1", family: "git", provider: "github-com",
      account: { externalId: "inst-exp", displayName: "acme", scopes: ["repo"] },
      capabilities: ["repo:read"], secretRef: stored.secretRef, secretFingerprint: stored.fingerprint,
      expiresAt: Date.now() - 1000,
    })
    const resolver = new CredentialResolver({ store, secrets })
    expect(await resolver.resolve("t1", c.connectionId)).toBeNull()
    const after = await store.get("t1", c.connectionId)
    expect(after?.state).toBe("expired")
  })

  it("markExpired is idempotent and does not touch revoked", async () => {
    const c = await createConnection(store, secrets)
    const r1 = await store.markExpired("t1", c.connectionId)
    expect(r1?.state).toBe("expired")
    const r2 = await store.markExpired("t1", c.connectionId)
    expect(r2?.state).toBe("expired")
  })

  it("resolveFor throws CAPABILITY_NOT_GRANTED for missing capability", async () => {
    const c = await createConnection(store, secrets)
    const resolver = new CredentialResolver({ store, secrets })
    await expect(resolver.resolveFor("t1", c.connectionId, "repo:read" as never)).resolves.toBeTruthy()
    await expect(resolver.resolveFor("t1", c.connectionId, "model:stream" as never)).rejects.toMatchObject({ code: "CAPABILITY_NOT_GRANTED" })
  })

  it("resolve returns null when secret is gone (no existence leak)", async () => {
    const c = await createConnection(store, secrets)
    await secrets.delete(c.secretRef)
    const resolver = new CredentialResolver({ store, secrets })
    expect(await resolver.resolve("t1", c.connectionId)).toBeNull()
  })

  it("touchLastUsed is best-effort and never throws for revoked connection", async () => {
    const c = await createConnection(store, secrets)
    await store.revoke("t1", c.connectionId, c.version)
    await expect(store.touchLastUsed("t1", c.connectionId)).resolves.toBeUndefined()
  })

  it("listExpiredActive finds only active+expired connections", async () => {
    const stored = await secrets.store("ghp_a_1234567890", { tenantId: "t1", orgId: "o1", projectId: "p1", family: "git", provider: "github-com" })
    await store.create({
      tenantId: "t1", orgId: "o1", projectId: "p1", family: "git", provider: "github-com",
      account: { externalId: "inst-a", displayName: "a", scopes: ["repo"] },
      capabilities: ["repo:read"], secretRef: stored.secretRef, secretFingerprint: stored.fingerprint,
      expiresAt: Date.now() - 1000,
    })
    const active = await createConnection(store, secrets)
    const expired = await store.listExpiredActive()
    expect(expired).toHaveLength(1)
    expect(expired[0]?.state).toBe("active")
    expect(active.state).toBe("active")
  })

  it("toPublicView never exposes secretRef or secret", () => {
    const c: ProviderConnection = {
      connectionId: "c1", tenantId: "t1", orgId: "o1", projectId: "p1", family: "git", provider: "github-com",
      account: { externalId: "i", displayName: "n", scopes: [] }, capabilities: ["repo:read"], state: "active",
      secretRef: "mem:supersecret", secretFingerprint: "sha256:abcdef1234567890abcdef1234567890", version: 1,
      createdAt: 1, updatedAt: 1, lastUsedAt: null, expiresAt: null, rotatedFrom: null,
    }
    const view = toPublicView(c)
    expect(JSON.stringify(view)).not.toContain("mem:supersecret")
    expect(view.secretFingerprintPrefix).toContain("…")
  })
})
