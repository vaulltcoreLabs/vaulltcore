import { describe, it, expect, beforeEach } from "vitest"
import { createHmac } from "node:crypto"
import { PgliteDatabase, pgliteDialect } from "@vaulltcore/store-sql"
import { SqlAuditStore } from "@vaulltcore/audit"
import {
  ProviderRegistry,
  verifyHmacSha256,
  type IntegrationProvider,
  type ProviderKind,
  type RawWebhook,
  type WebhookVerifyResult,
} from "@vaulltcore/integration"
import { SqlWebhookStore, WebhookGateway, SubscriptionMatcher, globMatch, type WebhookRouteResolver } from "../src"

let db: PgliteDatabase
let store: SqlWebhookStore
let audit: SqlAuditStore

beforeEach(() => {
  db = new PgliteDatabase()
  store = new SqlWebhookStore(db, { dialect: pgliteDialect })
  audit = new SqlAuditStore(db, { dialect: pgliteDialect })
})

const KIND: ProviderKind = { family: "git", provider: "github-com", label: "GitHub", capabilities: ["repo:read", "repo:write", "webhook:verify"] }

/** A fake GitHub provider that verifies HMAC + normalizes a push event. */
class FakeGitHubProvider implements IntegrationProvider {
  readonly kind = KIND
  constructor(private readonly ts: () => number) {}
  async verifyIdentity() { return { externalId: "org-1", displayName: "acme", scopes: ["repo"] } }
  async verifyWebhook(raw: RawWebhook, options: { secret: string }): Promise<WebhookVerifyResult> {
    const sig = raw.headers["x-hub-signature-256"] ?? raw.headers["X-Hub-Signature-256"]
    if (!verifyHmacSha256(raw.rawBody, sig, options.secret)) {
      return { verified: false, reason: "signature mismatch", event: null }
    }
    let payload: any
    try { payload = JSON.parse(raw.rawBody) } catch { return { verified: false, reason: "bad json", event: null } }
    const delivery = raw.headers["x-github-delivery"] ?? raw.headers["X-GitHub-Delivery"] ?? "unknown"
    return {
      verified: true, reason: null,
      event: {
        provider: "github-com", providerEventId: String(delivery),
        kind: "repo.push", resource: `github:${payload.repository?.full_name ?? "unknown"}`,
        action: null, actor: { externalId: payload.sender?.login ?? "unknown", displayName: payload.sender?.login ?? null },
        payload, providerTimestamp: this.ts(),
      },
    }
  }
}

function sign(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex")
}

function routeResolver(secret = "wh-secret"): WebhookRouteResolver {
  return {
    async resolve(raw) {
      // In production this maps the path/secret to a tenant connection.
      if (raw.headers["x-route-secret"] === secret || raw.path.includes("/github")) {
        return { tenantId: "t1", orgId: "o1", projectId: "p1", connectionId: "conn_g", provider: "github-com", secret }
      }
      return null
    },
  }
}

function gateway(secret = "wh-secret") {
  const providers = new ProviderRegistry()
  providers.register(new FakeGitHubProvider(() => NOW))
  return new WebhookGateway({ store, providers, routeResolver: routeResolver(secret), audit, now: () => NOW })
}

let NOW = 1_700_000_000_000

describe("WebhookGateway — ingestion", () => {
  it("verifies, persists, enqueues, audits a valid webhook", async () => {
    const g = gateway()
    const body = JSON.stringify({ repository: { full_name: "acme/widget" }, sender: { login: "alice" }, ref: "refs/heads/main" })
    const res = await g.ingest({
      provider: "github-com",
      headers: { "x-hub-signature-256": sign("wh-secret", body), "x-github-delivery": "del-1", "x-route-secret": "wh-secret" },
      rawBody: body, path: "/webhooks/github",
    })
    expect(res.status).toBe("accepted")
    expect(res.eventId).toBeTruthy()
    const rec = store.get("t1", res.eventId!)
    expect(rec?.state).toBe("accepted")
    expect(rec?.enqueuedAt).not.toBeNull()
  })

  it("rejects a forged signature (webhook forgery) with no existence leak", async () => {
    const g = gateway()
    const body = JSON.stringify({ repository: { full_name: "acme/widget" } })
    const res = await g.ingest({
      provider: "github-com",
      headers: { "x-hub-signature-256": "sha256=deadbeef", "x-github-delivery": "del-forged", "x-route-secret": "wh-secret" },
      rawBody: body, path: "/webhooks/github",
    })
    expect(res.status).toBe("unverified")
    expect(res.eventId).toBeNull()
    // No event persisted for a forged webhook.
    expect(store.listPending("t1")).toHaveLength(0)
  })

  it("deduplicates a replayed webhook (never re-enqueues, no duplicate work)", async () => {
    const g = gateway()
    const body = JSON.stringify({ repository: { full_name: "acme/widget" }, sender: { login: "alice" } })
    const raw: RawWebhook = {
      provider: "github-com",
      headers: { "x-hub-signature-256": sign("wh-secret", body), "x-github-delivery": "del-replay", "x-route-secret": "wh-secret" },
      rawBody: body, path: "/webhooks/github",
    }
    const r1 = await g.ingest(raw)
    expect(r1.status).toBe("accepted")
    const r2 = await g.ingest(raw)
    expect(r2.status).toBe("duplicate")
    expect(r2.eventId).toBe(r1.eventId)
    // Only one event persisted.
    expect(store.listPending("t1")).toHaveLength(0) // already enqueued
  })

  it("rejects an unresolvable route (no tenant leak)", async () => {
    const g = gateway("wh-secret")
    const body = JSON.stringify({})
    const res = await g.ingest({
      provider: "github-com",
      headers: { "x-hub-signature-256": sign("wh-secret", body), "x-github-delivery": "del-x" },
      rawBody: body, path: "/webhooks/unknown",
    })
    expect(res.status).toBe("unresolvable")
    expect(res.eventId).toBeNull()
  })

  it("rejects a stale event (replay protection via timestamp)", async () => {
    NOW = 1_700_000_000_000
    const g = gateway()
    const oldTs = NOW - 1000 * 60 * 60 * 24 * 30 // 30 days old
    const body = JSON.stringify({ repository: { full_name: "acme/widget" }, sender: { login: "alice" } })
    // providerTimestamp comes from the fake provider as Date.now(); override by
    // constructing a provider that returns a stale ts.
    const providers = new ProviderRegistry()
    providers.register({
      kind: KIND,
      async verifyIdentity() { return { externalId: "x", displayName: null, scopes: [] } },
      async verifyWebhook(): Promise<WebhookVerifyResult> {
        return { verified: true, reason: null, event: { provider: "github-com", providerEventId: "del-stale", kind: "repo.push", resource: "github:acme/widget", action: null, actor: null, payload: {}, providerTimestamp: oldTs } }
      },
    })
    const g2 = new WebhookGateway({ store, providers, routeResolver: routeResolver(), audit, now: () => NOW })
    const res = await g2.ingest({ provider: "github-com", headers: { "x-route-secret": "wh-secret" }, rawBody: "{}", path: "/webhooks/github" })
    expect(res.status).toBe("rejected")
    expect(res.reason).toContain("old")
  })

  it("audit records accepted + rejected (no secrets)", async () => {
    const g = gateway()
    const body = JSON.stringify({ repository: { full_name: "acme/widget" }, sender: { login: "alice" } })
    await g.ingest({
      provider: "github-com",
      headers: { "x-hub-signature-256": sign("wh-secret", body), "x-github-delivery": "del-aud", "x-route-secret": "wh-secret" },
      rawBody: body, path: "/webhooks/github",
    })
    await g.ingest({
      provider: "github-com",
      headers: { "x-hub-signature-256": "sha256=bogus", "x-github-delivery": "del-aud2", "x-route-secret": "wh-secret" },
      rawBody: body, path: "/webhooks/github",
    })
    const events = await audit.list({ tenantId: "t1" })
    const accepted = events.filter((e) => e.type === "webhook_accepted")
    const rejected = events.filter((e) => e.type === "webhook_rejected")
    expect(accepted.length).toBeGreaterThanOrEqual(1)
    expect(rejected.length).toBeGreaterThanOrEqual(1)
    // No secret material in audit metadata.
    expect(JSON.stringify(events)).not.toContain("wh-secret")
  })
})

describe("SubscriptionMatcher — fan-out", () => {
  it("matches events to subscriptions by provider/kind/resource glob", () => {
    const m = new SubscriptionMatcher()
    m.upsert({ subscriptionId: "s1", tenantId: "t1", orgId: "o1", projectId: "p1", name: "prs", provider: "github-com", kinds: ["pr.opened"], resourceGlob: "github:acme/*", actions: ["opened"], automationId: "auto-1", enabled: true })
    m.upsert({ subscriptionId: "s2", tenantId: "t1", orgId: "o1", projectId: "p1", name: "all", provider: "github-com", kinds: ["*"], resourceGlob: "*", actions: null, automationId: "auto-2", enabled: true })
    m.upsert({ subscriptionId: "s3", tenantId: "t2", orgId: "o1", projectId: "p1", name: "other-tenant", provider: "github-com", kinds: ["*"], resourceGlob: "*", actions: null, automationId: "auto-3", enabled: true })
    m.upsert({ subscriptionId: "s4", tenantId: "t1", orgId: "o1", projectId: "p1", name: "disabled", provider: "github-com", kinds: ["*"], resourceGlob: "*", actions: null, automationId: "auto-4", enabled: false })

    const triggers = m.match({
      eventId: "e1", tenantId: "t1", orgId: "o1", projectId: "p1", provider: "github-com", providerEventId: "del",
      kind: "pr.opened", resource: "github:acme/widget", action: "opened", actor: null, payload: {}, providerTimestamp: null, receivedAt: 1,
    })
    expect(triggers.map((t) => t.subscriptionId).sort()).toEqual(["s1", "s2"])
    // Deterministic trigger key (no duplicate on re-drive).
    expect(triggers[0]!.triggerKey).toContain("t1")
    expect(triggers[0]!.triggerKey).toContain("e1")
  })

  it("globMatch: '*' matches all, prefix glob matches", () => {
    expect(globMatch("*", "anything")).toBe(true)
    expect(globMatch("github:acme/*", "github:acme/widget")).toBe(true)
    expect(globMatch("github:acme/*", "github:other/widget")).toBe(false)
    expect(globMatch("exact", "exact")).toBe(true)
  })
})

describe("SqlWebhookStore — tenant isolation + idempotency", () => {
  it("get returns null for wrong tenant (no existence leak)", () => {
    store.recordEvent({
      eventId: "evt-x", tenantId: "t1", orgId: "o1", projectId: "p1", provider: "github-com", providerEventId: "del",
      kind: "repo.push", resource: "github:acme/widget", action: null, actor: null, payload: {}, providerTimestamp: null, receivedAt: 1,
    } as const)
    expect(store.get("t2", "evt-x")).toBeNull()
    expect(store.get("t1", "evt-x")?.tenantId).toBe("t1")
  })

  it("recordEvent is idempotent on (tenant, eventId)", () => {
    const ev = { eventId: "evt-y", tenantId: "t1", orgId: "o1", projectId: "p1", provider: "github-com", providerEventId: "del", kind: "repo.push", resource: "r", action: null, actor: null, payload: {}, providerTimestamp: null, receivedAt: 1 } as const
    const r1 = store.recordEvent(ev)
    const r2 = store.recordEvent(ev)
    expect(r1.inserted).toBe(true)
    expect(r2.inserted).toBe(false)
    expect(r1.record.eventId).toBe(r2.record.eventId)
  })
})
