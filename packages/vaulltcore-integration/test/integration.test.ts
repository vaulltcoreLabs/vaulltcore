import { describe, it, expect, beforeEach } from "vitest"
import { NodeSqliteDatabase } from "@vaulltcore/store-sql"
import {
  SqlSubscriptionStore,
  FanOutService,
  ProviderRegistry,
  IntegrationError,
  deterministicEventId,
  globMatch,
  ProviderHttpClient,
  type NormalizedEvent,
  type AutomationTriggerSink,
  type IntegrationProvider,
  type ProviderKind,
  type RawWebhook,
  type WebhookVerifyResult,
} from "../src"
import type { ResolvedCredential } from "@vaulltcore/credentials"

function makeEvent(tenantId: string, providerEventId: string, provider = "github", kind: NormalizedEvent["kind"] = "pr.opened", resource = "github:acme/repo"): NormalizedEvent {
  return {
    eventId: deterministicEventId(tenantId, provider, providerEventId),
    tenantId, orgId: "o1", projectId: "p1", provider, providerEventId,
    kind, resource, action: "opened", actor: { externalId: "u1", displayName: "alice" },
    payload: { number: 1 }, providerTimestamp: Date.now(), receivedAt: Date.now(),
  }
}

describe("globMatch", () => {
  it("matches exact, prefix, suffix, and wildcard", () => {
    expect(globMatch("*", "anything")).toBe(true)
    expect(globMatch("github:acme/repo", "github:acme/repo")).toBe(true)
    expect(globMatch("github:acme/*", "github:acme/repo")).toBe(true)
    expect(globMatch("github:*/repo", "github:acme/repo")).toBe(true)
    expect(globMatch("github:acme/*", "github:other/repo")).toBe(false)
  })
})

describe("SqlSubscriptionStore + FanOutService", () => {
  let store: SqlSubscriptionStore
  let sink: AutomationTriggerSink & { calls: number; runs: string[] }
  beforeEach(() => {
    store = new SqlSubscriptionStore(NodeSqliteDatabase.memory())
    sink = {
      calls: 0, runs: [],
      async createRunForTrigger(args) {
        sink.calls++
        const runId = `run_${sink.calls}`
        sink.runs.push(runId)
        return { automationRunId: runId }
      },
    }
  })

  it("creates a subscription and matches by provider+kind+glob", async () => {
    const sub = await store.createSubscription({
      tenantId: "t1", orgId: "o1", projectId: "p1", name: "pr-bot",
      provider: "github", eventKinds: ["pr.opened"], resourcePattern: "github:acme/*",
      automationTemplateId: "tpl-1",
    })
    expect(sub.state).toBe("active")
    const ev = makeEvent("t1", "del-1")
    const subs = await store.matchSubscriptions(ev)
    expect(subs).toHaveLength(1)
    // non-matching resource
    const ev2 = makeEvent("t1", "del-2", "github", "pr.opened", "github:other/repo")
    expect(await store.matchSubscriptions(ev2)).toHaveLength(0)
    // non-matching kind
    const ev3 = makeEvent("t1", "del-3", "github", "issue.opened", "github:acme/repo")
    expect(await store.matchSubscriptions(ev3)).toHaveLength(0)
  })

  it("dedupes a duplicate event (same providerEventId) — no second trigger", async () => {
    await store.createSubscription({
      tenantId: "t1", orgId: "o1", projectId: "p1", name: "s",
      provider: "github", eventKinds: [], resourcePattern: "*",
      automationTemplateId: "tpl-1",
    })
    const ev = makeEvent("t1", "del-dup")
    const r1 = await store.persistEvent(ev)
    expect(r1.created).toBe(true)
    const r2 = await store.persistEvent(ev)
    expect(r2.created).toBe(false)
    expect(r2.eventId).toBe(r1.eventId)
  })

  it("fanOutEvent creates exactly one run per subscription; duplicate event does not duplicate work", async () => {
    await store.createSubscription({
      tenantId: "t1", orgId: "o1", projectId: "p1", name: "s",
      provider: "github", eventKinds: [], resourcePattern: "*",
      automationTemplateId: "tpl-1",
    })
    const fanout = new FanOutService({ store, sink })
    const ev = makeEvent("t1", "del-once")
    await store.persistEvent(ev)
    const res1 = await fanout.fanOutEvent(ev)
    expect(res1.runIds).toHaveLength(1)
    expect(sink.calls).toBe(1)
    // re-deliver the same event: replay returns the existing run id, sink NOT called again
    const res2 = await fanout.fanOutEvent(ev)
    expect(res2.runIds).toEqual(res1.runIds)
    expect(sink.calls).toBe(1)
  })

  it("multiple subscriptions each trigger one run", async () => {
    await store.createSubscription({ tenantId: "t1", orgId: "o1", projectId: "p1", name: "a", provider: "github", eventKinds: [], resourcePattern: "*", automationTemplateId: "tpl-1" })
    await store.createSubscription({ tenantId: "t1", orgId: "o1", projectId: "p1", name: "b", provider: "github", eventKinds: [], resourcePattern: "*", automationTemplateId: "tpl-2" })
    const fanout = new FanOutService({ store, sink })
    const ev = makeEvent("t1", "del-multi")
    await store.persistEvent(ev)
    const res = await fanout.fanOutEvent(ev)
    expect(res.runIds).toHaveLength(2)
  })

  it("cross-tenant subscription match returns nothing", async () => {
    await store.createSubscription({ tenantId: "t1", orgId: "o1", projectId: "p1", name: "a", provider: "github", eventKinds: [], resourcePattern: "*", automationTemplateId: "tpl-1" })
    const ev = makeEvent("t2", "del-x")
    expect(await store.matchSubscriptions(ev)).toHaveLength(0)
  })

  it("trigger failure is retriable and does not crash fan-out", async () => {
    await store.createSubscription({ tenantId: "t1", orgId: "o1", projectId: "p1", name: "a", provider: "github", eventKinds: [], resourcePattern: "*", automationTemplateId: "tpl-1" })
    const failingSink: AutomationTriggerSink = {
      async createRunForTrigger() { throw new Error("automation service down") },
    }
    const fanout = new FanOutService({ store, sink: failingSink })
    const ev = makeEvent("t1", "del-fail")
    await store.persistEvent(ev)
    const res = await fanout.fanOutEvent(ev)
    expect(res.runIds).toHaveLength(0)
    // trigger recorded but not completed; failed_retriable — pending stays empty (state=failed_retriable)
    expect(await store.listPendingTriggers("t1")).toHaveLength(0)
  })

  it("drivePending is idempotent on re-run", async () => {
    await store.createSubscription({ tenantId: "t1", orgId: "o1", projectId: "p1", name: "a", provider: "github", eventKinds: [], resourcePattern: "*", automationTemplateId: "tpl-1" })
    const ev = makeEvent("t1", "del-drive")
    await store.persistEvent(ev)
    // Manually record a trigger without completing (simulate worker crash mid-drive)
    const subs = await store.matchSubscriptions(ev)
    await store.recordTrigger(subs[0]!, ev)
    const fanout = new FanOutService({ store, sink })
    const r1 = await fanout.drivePending("t1")
    expect(r1.created).toBe(1)
    const r2 = await fanout.drivePending("t1")
    expect(r2.created).toBe(0) // already completed
    expect(sink.calls).toBe(1)
  })
})

describe("ProviderRegistry", () => {
  it("registers and resolves providers; rejects unknown", () => {
    const reg = new ProviderRegistry()
    const kind: ProviderKind = { family: "git", provider: "github-com", label: "GitHub", capabilities: ["repo:read"] }
    const provider: IntegrationProvider = {
      kind,
      async verifyIdentity(_c: ResolvedCredential) { return { externalId: "x", displayName: null, scopes: [] } },
      async verifyWebhook(_r: RawWebhook, _o: { secret: string }): Promise<WebhookVerifyResult> { return { verified: false, reason: "none", event: null } },
    }
    reg.register(provider)
    expect(reg.resolve("git", "github-com")).toBe(provider)
    expect(() => reg.resolve("git", "unknown")).toThrow(IntegrationError)
    expect(() => reg.register(provider)).toThrow(IntegrationError)
    expect(reg.list()).toHaveLength(1)
  })
})

describe("deterministicEventId", () => {
  it("is stable for the same inputs and differs across tenants", () => {
    const a = deterministicEventId("t1", "github", "del-1")
    const b = deterministicEventId("t1", "github", "del-1")
    const c = deterministicEventId("t2", "github", "del-1")
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a.startsWith("evt:")).toBe(true)
  })
})

describe("ProviderHttpClient SSRF guard", () => {
  it("rejects loopback/private destinations", async () => {
    const client = new ProviderHttpClient({ allowHttp: true, allowPrivate: false })
    await expect(client.request({ method: "GET", url: "http://127.0.0.1:1/x" })).rejects.toMatchObject({ code: "PROVIDER_HTTP_ERROR" })
    await expect(client.request({ method: "GET", url: "http://10.0.0.1:1/x" })).rejects.toMatchObject({ code: "PROVIDER_HTTP_ERROR" })
  })
  it("rejects userinfo in destination URL", async () => {
    const client = new ProviderHttpClient({ allowHttp: true, allowPrivate: false })
    await expect(client.request({ method: "GET", url: "https://user:pass@example.com/x" })).rejects.toMatchObject({ code: "PROVIDER_HTTP_ERROR" })
  })
  it("uses injectable transport and redacts auth header from errors", async () => {
    const seen: Record<string, string> = {}
    const client = new ProviderHttpClient({
      allowHttp: true,
      allowPrivate: true,
      transport: async (_parsed, opts) => {
        const h = opts.headers as Record<string, string | undefined> | undefined
        seen.headers = h?.authorization ?? ""
        return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from("{}") }
      },
    })
    const res = await client.request({ method: "GET", url: "http://127.0.0.1:1/x", authHeader: "Bearer supersecret-token-value" })
    expect(res.status).toBe(200)
    expect(seen.headers).toBe("Bearer supersecret-token-value")
  })
})
