import { describe, it, expect } from "vitest"
import { createHmac } from "node:crypto"
import { LinearProvider, SlackConnector } from "../src"
import type { ProviderHttpClient, ProviderHttpResponse, ProviderHttpOptions } from "@vaulltcore/integration"
import type { ResolvedCredential } from "@vaulltcore/credentials"

class FakeHttp implements Pick<ProviderHttpClient, "request"> {
  readonly calls: Array<{ method: string; url: string; body?: unknown; authHeader?: string }> = []
  private responses: Array<{ match: (o: ProviderHttpOptions) => boolean; respond: (o: ProviderHttpOptions) => ProviderHttpResponse }> = []
  on(match: (o: ProviderHttpOptions) => boolean, respond: (o: ProviderHttpOptions) => ProviderHttpResponse): this {
    this.responses.push({ match, respond })
    return this
  }
  async request(options: ProviderHttpOptions): Promise<ProviderHttpResponse> {
    this.calls.push({ method: options.method, url: options.url, body: options.body, authHeader: options.authHeader })
    for (const r of this.responses) if (r.match(options)) return r.respond(options)
    throw new Error(`no fake response for ${options.method} ${options.url}`)
  }
}

function pmCred(secret = "lin_api_fake_secret_value"): ResolvedCredential {
  return {
    connectionId: "conn_pm", tenantId: "t1", orgId: "o1", projectId: "p1",
    family: "project", provider: "linear", secretRef: "mem:x", secretFingerprint: "sha256:x", secret,
    account: { externalId: "w1", displayName: "acme", scopes: ["read", "write"] },
    capabilities: ["issue:read", "issue:write", "webhook:verify"],
  }
}
function slackCred(secret = "xoxb-fake-bot-token-secret"): ResolvedCredential {
  return {
    connectionId: "conn_sl", tenantId: "t1", orgId: "o1", projectId: "p1",
    family: "notification", provider: "slack", secretRef: "mem:y", secretFingerprint: "sha256:y", secret,
    account: { externalId: "T1", displayName: "acme", scopes: ["chat:write"] },
    capabilities: ["message:send", "webhook:verify"],
  }
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex")
}

describe("LinearProvider conformance", () => {
  it("verifyIdentity maps viewer and sends api key as auth header", async () => {
    const http = new FakeHttp().on(() => true, () => ({ status: 200, headers: {}, body: JSON.stringify({ data: { viewer: { id: "U1", name: "Alice", email: "a@x" } } }) }))
    const lin = new LinearProvider({ http: http as unknown as ProviderHttpClient })
    const id = await lin.verifyIdentity(pmCred())
    expect(id.externalId).toBe("U1")
    expect(http.calls[0]!.authHeader).toBe("lin_api_fake_secret_value")
  })

  it("listTeams maps teams nodes", async () => {
    const http = new FakeHttp().on(() => true, () => ({ status: 200, headers: {}, body: JSON.stringify({ data: { teams: { nodes: [{ id: "T1", name: "Eng", key: "ENG", url: "u" }] } } }) }))
    const lin = new LinearProvider({ http: http as unknown as ProviderHttpClient })
    const teams = await lin.listTeams(pmCred())
    expect(teams).toHaveLength(1)
    expect(teams[0]!.key).toBe("ENG")
  })

  it("createIssue returns created issue with idempotency identity", async () => {
    const http = new FakeHttp().on(() => true, () => ({ status: 200, headers: {}, body: JSON.stringify({ data: { issueCreate: { success: true, issue: { id: "I1", identifier: "ENG-1", title: "T", state: { name: "Backlog", type: "backlog" }, priority: 2, url: "u", description: "d", labels: { nodes: [{ name: "bug" }] } } } } }) }))
    const lin = new LinearProvider({ http: http as unknown as ProviderHttpClient })
    const res = await lin.createIssue(pmCred(), { teamId: "T1", title: "T", description: "d", priority: 2, operationId: "op-i" })
    expect(res.created).toBe(true)
    expect(res.result.identifier).toBe("ENG-1")
    expect(res.result.labels).toEqual(["bug"])
    const m = lin.mutationIdentity(pmCred(), "op-i")
    expect(m.operationId).toBe("op-i")
  })

  it("getIssue returns null when not found (no existence leak)", async () => {
    const http = new FakeHttp().on(() => true, () => ({ status: 200, headers: {}, body: JSON.stringify({ data: { issue: null } }) }))
    const lin = new LinearProvider({ http: http as unknown as ProviderHttpClient })
    expect(await lin.getIssue(pmCred(), "I-missing")).toBeNull()
  })

  it("401 surfaces as auth_config error", async () => {
    const http = new FakeHttp().on(() => true, () => ({ status: 401, headers: {}, body: "{}" }))
    const lin = new LinearProvider({ http: http as unknown as ProviderHttpClient })
    await expect(lin.verifyIdentity(pmCred("bad"))).rejects.toMatchObject({ code: "LINEAR_UNAUTHORIZED", retryClass: "auth_config" })
  })

  it("verifyWebhook accepts valid HMAC and rejects forged", async () => {
    const http = new FakeHttp()
    const lin = new LinearProvider({ http: http as unknown as ProviderHttpClient })
    const secret = "lin_whsec"
    const body = JSON.stringify({ type: "Issue", action: "create", data: { identifier: "ENG-5", title: "T", team: { key: "ENG" } }, user: { name: "bob", id: 9 } })
    const sig = "sha256=" + sign(body, secret)
    const ok = await lin.verifyWebhook({ provider: "linear", headers: { "linear-signature": sig }, rawBody: body, path: "/" }, { secret })
    expect(ok.verified).toBe(true)
    expect(ok.event?.kind).toBe("issue.opened")
    expect(ok.event?.resource).toBe("linear:ENG-5")
    const bad = await lin.verifyWebhook({ provider: "linear", headers: { "linear-signature": "sha256=" + "0".repeat(64) }, rawBody: body, path: "/" }, { secret })
    expect(bad.verified).toBe(false)
  })
})

describe("SlackConnector conformance", () => {
  it("verifyIdentity maps auth.test", async () => {
    const http = new FakeHttp().on(() => true, () => ({ status: 200, headers: {}, body: JSON.stringify({ ok: true, team_id: "T1", team: "acme", user: "bot", scopes: "chat:write,channels:read" }) }))
    const sl = new SlackConnector({ http: http as unknown as ProviderHttpClient })
    const id = await sl.verifyIdentity(slackCred())
    expect(id.externalId).toBe("T1")
    expect(id.scopes).toEqual(["chat:write", "channels:read"])
  })

  it("verifyWebhook enforces timestamp replay window + HMAC", async () => {
    const http = new FakeHttp()
    const sl = new SlackConnector({ http: http as unknown as ProviderHttpClient })
    const secret = "slack_whsec"
    const ts = String(Math.floor(Date.now() / 1000))
    const body = JSON.stringify({ event_id: "Ev1", event: { type: "message", channel: "C1", user: "U1", text: "hi", ts: "123.0" } })
    const base = `v0:${ts}:${body}`
    const sig = "v0=" + sign(base, secret)
    const ok = await sl.verifyWebhook({ provider: "slack", headers: { "x-slack-signature": sig, "x-slack-request-timestamp": ts }, rawBody: body, path: "/" }, { secret })
    expect(ok.verified).toBe(true)
    expect(ok.event?.kind).toBe("message.received")
    expect(ok.event?.resource).toBe("slack:C1")
    // old timestamp → replay rejected
    const oldTs = String(Math.floor(Date.now() / 1000) - 600)
    const oldBase = `v0:${oldTs}:${body}`
    const oldSig = "v0=" + sign(oldBase, secret)
    const replay = await sl.verifyWebhook({ provider: "slack", headers: { "x-slack-signature": oldSig, "x-slack-request-timestamp": oldTs }, rawBody: body, path: "/" }, { secret })
    expect(replay.verified).toBe(false)
    expect(replay.reason).toMatch(/replay|timestamp/)
  })

  it("listChannels maps conversations", async () => {
    const http = new FakeHttp().on(() => true, () => ({ status: 200, headers: {}, body: JSON.stringify({ ok: true, channels: [{ id: "C1", name: "general" }] }) }))
    const sl = new SlackConnector({ http: http as unknown as ProviderHttpClient })
    const ch = await sl.listChannels(slackCred())
    expect(ch[0]!.name).toBe("general")
  })

  it("sendMessage without delivery configured throws NO_DELIVERY (never bypasses delivery layer)", async () => {
    const http = new FakeHttp()
    const sl = new SlackConnector({ http: http as unknown as ProviderHttpClient })
    await expect(sl.sendMessage({ credential: slackCred(), channel: "C1", text: "hi", idempotencyKey: "k1" })).rejects.toMatchObject({ code: "NO_DELIVERY" })
  })
})
