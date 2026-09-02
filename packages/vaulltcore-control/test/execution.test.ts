/**
 * Phase 3A.1 proof: the production composition path
 *
 *     DurableAgentRunner → AgentEngine(OpenCodeEngine) → ModelProvider →
 *         ModelProviderAdapter (models/BYOK credential boundary)
 *
 * exercised end-to-end with the REAL credential-backed ModelRegistry stack
 * (SqlCredentialStore + CredentialResolver + InMemorySecretProvider), a real
 * OpenCode engine, and a deterministic fake model adapter (no network).
 * Proves public identifiers in engineOptions resolve the tenant's secret-based
 * adapter, and that secret material never leaks into any serialized output.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CredentialResolver, InMemorySecretProvider, SqlCredentialStore } from "@vaulltcore/credentials"
import { FileJobStore, LocalWorkspaceProvider, type ExecutionPolicy, type Tool } from "@vaulltcore/runner"
import { NodeSqliteDatabase } from "@vaulltcore/store-sql"
import { ModelConnectionService, ModelRegistry, type ModelDescriptor, type ModelProviderAdapter, type ModelRequest, type ModelStreamEvent } from "@vaulltcore/models"
import { buildOpenCodeRunner } from "../src/execution"

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vaulltcore-exec-"))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const TENANT = "tenant-e", ORG = "org-e", PROJECT = "project-e"
const SECRET = "sk-real-model-api-key-do-not-leak"
const DESCRIPTOR: ModelDescriptor = {
  provider: "openai",
  model: "gpt-4o",
  label: "GPT-4o",
  contextWindow: 128000,
  maxOutputTokens: 4096,
  supportsTools: true,
  supportsReasoning: false,
  pricing: { inputPerMillion: 2.5, outputPerMillion: 10 },
  metadata: {},
}

/** Deterministic adapter holding the transient secret (never persisted). */
class FakeAdapter implements ModelProviderAdapter {
  readonly descriptor = DESCRIPTOR
  constructor(private readonly cred: { readonly secret: string }) {}
  async *stream(_request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    const secret = this.cred.secret
    void secret
    yield { type: "step-start" }
    if (signal.aborted) {
      yield { type: "finish", reason: "stop" }
      return
    }
    yield { type: "text-delta", text: "pong" }
    yield { type: "step-finish" }
    yield { type: "finish", reason: "stop" }
  }
}

function echoTool(): { tool: Tool; executions: () => number } {
  let executions = 0
  return {
    executions: () => executions,
    tool: {
      definition: { name: "echo", description: "echo", parameters: { type: "object" } },
      async execute() {
        executions++
        return { ok: true }
      },
    },
  }
}

async function setUp(): Promise<{
  registry: ModelRegistry
  connectionId: string
  runner: ReturnType<typeof buildOpenCodeRunner>
}> {
  const db = NodeSqliteDatabase.memory()
  const connections = new SqlCredentialStore(db)
  const secrets = new InMemorySecretProvider()
  const resolver = new CredentialResolver({ store: connections, secrets })
  const registry = new ModelRegistry({ credentialResolver: resolver })
  registry.register("openai", "gpt-4o", DESCRIPTOR, (cred) => new FakeAdapter(cred))
  const service = new ModelConnectionService({ connections, resolver, registry })

  const stored = await secrets.store(SECRET, { tenantId: TENANT, orgId: ORG, projectId: PROJECT, family: "model", provider: "openai" })
  const conn = await service.register({
    tenantId: TENANT, orgId: ORG, projectId: PROJECT, principalId: "u1", provider: "openai",
    accountExternalId: "acct-e", accountDisplayName: "acme",
    secretRef: stored.secretRef, secretFingerprint: stored.fingerprint,
  })

  const store = new FileJobStore(path.join(root, "store"))
  const workspace = new LocalWorkspaceProvider(path.join(root, "ws"))
  const runner = buildOpenCodeRunner({ store, registry, tools: [echoTool().tool], workspace })
  return { registry, connectionId: conn.connectionId, runner }
}

const POLICY: Partial<ExecutionPolicy> = { allowedTools: ["echo"], idempotentTools: [] }

describe("production composition: buildOpenCodeRunner over the real models stack", () => {
  it("runs a real job end-to-end resolving the tenant's secret-backed adapter", async () => {
    const { runner, connectionId } = await setUp()
    const record = await runner.createJob({
      tenantId: TENANT, orgId: ORG, projectId: PROJECT,
      spec: { engine: "opencode", model: "gpt-4o", input: "hi", engineOptions: { connectionId, provider: "openai" } },
      policy: POLICY,
    })
    const events: string[] = []
    const stream = (async () => {
      for await (const e of runner.streamEvents(record.jobId, 0)) events.push(e.type)
    })()
    const state = await runner.runJob(record.jobId)
    await stream

    expect(state.status).toBe("completed")
    expect(state.usage.steps).toBe(1)
    expect(events).toContain("completed")
  })

  it("surfaces connection/config errors honestly (no fabricated run)", async () => {
    const { runner } = await setUp()
    // Missing provider key in engineOptions → fails at session creation.
    const record = await runner.createJob({
      tenantId: TENANT, orgId: ORG, projectId: PROJECT,
      spec: { engine: "opencode", model: "gpt-4o", input: "hi", engineOptions: { connectionId: "conn" } },
      policy: POLICY,
    })
    const state = await runner.runJob(record.jobId)
    expect(state.status).toBe("failed")
    const events = await runner.listEvents(record.jobId, 0)
    const err = events.find((e) => e.type === "error")
    const message = (err?.data as { message?: string }).message ?? ""
    expect(message).toMatch(/provider/)
    expect(JSON.stringify(events)).not.toContain(SECRET)
  })

  it("never leaks the credential across any serialized runner output", async () => {
    const { runner, connectionId } = await setUp()
    const record = await runner.createJob({
      tenantId: TENANT, orgId: ORG, projectId: PROJECT,
      spec: { engine: "opencode", model: "gpt-4o", input: "secret-check", engineOptions: { connectionId, provider: "openai" } },
      policy: POLICY,
    })
    const state = await runner.runJob(record.jobId)
    const events = await runner.listEvents(record.jobId, 0)
    const view = await runner.getJob(record.jobId)
    const serialized = JSON.stringify({ state, events, view })
    expect(serialized).not.toContain(SECRET)
  })
})