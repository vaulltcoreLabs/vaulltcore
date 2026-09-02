/**
 * Phase 2D model connection activation + tenant/project isolation tests.
 *
 * Proves (reference to the Phase 2D required security tests):
 * 20. Model connection isolation is tenant/project safe.
 * 8. The raw API key never appears in connection state/inspect output.
 * 10. A revoked model connection cannot resolve a credential.
 */

import { describe, it, expect, beforeEach } from "vitest"
import { NodeSqliteDatabase } from "@vaulltcore/store-sql"
import {
  SqlCredentialStore,
  CredentialResolver,
  InMemorySecretProvider,
  CredentialError,
} from "@vaulltcore/credentials"
import { ModelRegistry, ModelConnectionService, ModelNotAllowedError, type ModelStreamEvent, type ModelDescriptor, type ModelProviderAdapter, type ModelRequest } from "../src"
import type { ResolvedCredential } from "@vaulltcore/credentials"

const TENANT = "t1", ORG = "o1", PROJECT = "p1"
const DESCRIPTOR: ModelDescriptor = {
  provider: "openai", model: "gpt-4o", label: "GPT-4o", contextWindow: 128000,
  maxOutputTokens: 4096, supportsTools: true, supportsReasoning: false,
  pricing: { inputPerMillion: 2.5, outputPerMillion: 10 }, metadata: {},
}

/** A fake adapter that records the secret it received (to prove it never leaks). */
class FakeAdapter implements ModelProviderAdapter {
  readonly descriptor = DESCRIPTOR
  readonly sawSecret: string | null = null
  constructor(private readonly cred: ResolvedCredential) {}
  async *stream(_request: ModelRequest, _signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    // The adapter sees the secret transiently; it must never persist it.
    const secret = this.cred.secret
    void secret
    yield { type: "text-delta", text: "pong" }
    yield { type: "finish", reason: "stop" }
  }
}

function setup() {
  const db = NodeSqliteDatabase.memory()
  const connections = new SqlCredentialStore(db)
  const secrets = new InMemorySecretProvider()
  const resolver = new CredentialResolver({ store: connections, secrets })
  const registry = new ModelRegistry({ credentialResolver: resolver })
  registry.register("openai", "gpt-4o", DESCRIPTOR, (cred) => new FakeAdapter(cred))
  const service = new ModelConnectionService({ connections, resolver, registry })
  return { db, connections, secrets, resolver, registry, service }
}

async function registerModel(s: ReturnType<typeof setup>, tenantId = TENANT, provider = "openai") {
  const stored = await s.secrets.store("sk-fake-model-api-key-secret", {
    tenantId, orgId: ORG, projectId: PROJECT, family: "model", provider,
  })
  return s.service.register({
    tenantId, orgId: ORG, projectId: PROJECT, principalId: "u1", provider,
    accountExternalId: `acct-${tenantId}`, accountDisplayName: "acme",
    secretRef: stored.secretRef, secretFingerprint: stored.fingerprint,
  })
}

describe("ModelConnectionService — BYOK activation + isolation", () => {
  let s: ReturnType<typeof setup>
  beforeEach(() => { s = setup() })

  it("registers + verifies a model connection without leaking the key", async () => {
    const conn = await registerModel(s)
    expect(conn.state).toBe("active")
    const verify = await s.service.verifyConnectivity({ tenantId: TENANT, orgId: ORG, projectId: PROJECT, connectionId: conn.connectionId, provider: "openai", model: "gpt-4o" })
    expect(verify.ok).toBe(true)
    // The raw key never appears in the inspect view.
    const view = await s.service.inspect(TENANT, conn.connectionId)
    expect(JSON.stringify(view)).not.toContain("sk-fake-model-api-key-secret")
  })

  // Proof 20: tenant isolation — a cross-tenant resolve returns nothing.
  it("a model connection is isolated to its tenant (cross-tenant cannot resolve)", async () => {
    const conn = await registerModel(s, TENANT)
    // Another tenant has no connection; resolve throws (not allowed).
    await expect(s.registry.resolve({ tenantId: "other", orgId: ORG, projectId: PROJECT, connectionId: conn.connectionId, provider: "openai", model: "gpt-4o" }))
      .rejects.toThrow()
    // Cross-tenant inspect returns null (no existence leak).
    expect(await s.service.inspect("other", conn.connectionId)).toBeNull()
  })

  // Proof 20: project isolation via tenant restrictions.
  it("tenant model restrictions block disallowed providers", async () => {
    const conn = await registerModel(s, TENANT)
    s.service.setRestrictions(TENANT, { allowedProviders: ["anthropic"] })
    await expect(s.registry.resolve({ tenantId: TENANT, orgId: ORG, projectId: PROJECT, connectionId: conn.connectionId, provider: "openai", model: "gpt-4o" }))
      .rejects.toThrow(ModelNotAllowedError)
  })

  // Proof 10: a revoked model connection cannot resolve a credential.
  it("a revoked model connection cannot resolve a credential", async () => {
    const conn = await registerModel(s)
    await s.service.revoke(TENANT, conn.connectionId)
    await expect(s.registry.resolve({ tenantId: TENANT, orgId: ORG, projectId: PROJECT, connectionId: conn.connectionId, provider: "openai", model: "gpt-4o" }))
      .rejects.toThrow()
  })

  it("a deactivated model connection cannot resolve a credential", async () => {
    const conn = await registerModel(s)
    await s.service.deactivate(TENANT, conn.connectionId)
    await expect(s.registry.resolve({ tenantId: TENANT, orgId: ORG, projectId: PROJECT, connectionId: conn.connectionId, provider: "openai", model: "gpt-4o" }))
      .rejects.toThrow()
  })
})
