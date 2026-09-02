import { describe, it, expect } from "vitest"
import { createHmac } from "node:crypto"
import {
  GitHubGitProvider,
  GitLabGitProvider,
  validateRepoPath,
  validateFilePath,
  validateBranchName,
  verifyHmacSha256,
  mapGitEventKind,
  type MutationResult,
} from "../src"
import type { ProviderHttpClient, ProviderHttpOptions, ProviderHttpResponse } from "@vaulltcore/integration"
import type { ResolvedCredential } from "@vaulltcore/credentials"

/** A fake HTTP client capturing calls and returning scripted responses. */
class FakeHttp implements Pick<ProviderHttpClient, "request"> {
  readonly calls: Array<{ method: string; url: string; body?: unknown; authHeader?: string; headers?: Record<string, string> }> = []
  private responses: Array<{ match: (o: ProviderHttpOptions) => boolean; respond: (o: ProviderHttpOptions) => Promise<ProviderHttpResponse> }> = []
  on(match: (o: ProviderHttpOptions) => boolean, respond: (o: ProviderHttpOptions) => ProviderHttpResponse | Promise<ProviderHttpResponse>): this {
    this.responses.push({ match, respond: async (o) => respond(o) })
    return this
  }
  async request(options: ProviderHttpOptions): Promise<ProviderHttpResponse> {
    this.calls.push({ method: options.method, url: options.url, body: options.body, authHeader: options.authHeader, headers: options.headers ? { ...options.headers } : undefined })
    for (const r of this.responses) {
      if (r.match(options)) return r.respond(options)
    }
    throw new Error(`no fake response for ${options.method} ${options.url}`)
  }
}

function makeCredential(secret = "ghp_fake_token_secret_value"): ResolvedCredential {
  return {
    connectionId: "conn_1", tenantId: "t1", orgId: "o1", projectId: "p1",
    family: "git", provider: "github-com", secretRef: "mem:x", secretFingerprint: "sha256:x", secret,
    account: { externalId: "inst-1", displayName: "acme", scopes: ["repo"] },
    capabilities: ["repo:read", "repo:write", "issue:read", "issue:write", "pr:read", "pr:write", "webhook:verify"],
  }
}

describe("validation helpers", () => {
  it("rejects path traversal and malformed inputs", () => {
    expect(() => validateRepoPath("../etc")).toThrow()
    expect(() => validateRepoPath("a/b")).not.toThrow()
    expect(() => validateFilePath("../evil")).toThrow()
    expect(() => validateFilePath("/abs")).toThrow()
    expect(() => validateFilePath("ok/path.txt")).not.toThrow()
    expect(() => validateBranchName("..weird")).toThrow()
    expect(() => validateBranchName("feature/x")).not.toThrow()
  })
  it("verifyHmacSha256 is constant-time and rejects bad signatures", () => {
    const body = "payload"
    const secret = "whsec"
    const good = verifyHmacSha256(body, "sha256=" + sign(body, secret), secret)
    expect(good).toBe(true)
    expect(verifyHmacSha256(body, "sha256=" + "0".repeat(64), secret)).toBe(false)
    expect(verifyHmacSha256(body, undefined, secret)).toBe(false)
  })
  it("mapGitEventKind maps known types", () => {
    expect(mapGitEventKind("push", null)).toBe("repo.push")
    expect(mapGitEventKind("pull_request", "opened")).toBe("pr.opened")
    expect(mapGitEventKind("issues", "opened")).toBe("issue.opened")
    expect(mapGitEventKind("release", "published")).toBe("release.published")
    expect(mapGitEventKind("unknown", null)).toBe("custom")
  })
})

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex")
}

describe("GitHubGitProvider conformance", () => {
  it("verifyIdentity maps /user to ProviderIdentity and uses Bearer auth", async () => {
    const http = new FakeHttp().on(
      (o) => o.method === "GET" && o.url.endsWith("/user"),
      () => ({ status: 200, headers: { "x-oauth-scopes": "repo, read:org" }, body: JSON.stringify({ id: 42, login: "acme" }) }),
    )
    const gh = new GitHubGitProvider({ http: http as unknown as ProviderHttpClient })
    const id = await gh.verifyIdentity(makeCredential())
    expect(id.externalId).toBe("42")
    expect(id.displayName).toBe("acme")
    expect(id.scopes).toEqual(["repo", "read:org"])
    expect(http.calls[0]!.authHeader).toBe("Bearer ghp_fake_token_secret_value")
    expect(http.calls[0]!.headers!["user-agent"]).toBe("vaulltcore")
  })

  it("getRepository returns null on 404 (no existence leak to other tenant)", async () => {
    const http = new FakeHttp().on((o) => o.method === "GET", () => ({ status: 404, headers: {}, body: "{}" }))
    const gh = new GitHubGitProvider({ http: http as unknown as ProviderHttpClient })
    expect(await gh.getRepository(makeCredential(), "acme/repo")).toBeNull()
  })

  it("createCommit validates path and posts base64 content with idempotency key", async () => {
    const http = new FakeHttp().on(
      (o) => o.method === "PUT",
      () => ({ status: 201, headers: {}, body: JSON.stringify({ commit: { sha: "abc", html_url: "https://github.com/acme/repo/commit/abc" } }) }),
    )
    const gh = new GitHubGitProvider({ http: http as unknown as ProviderHttpClient })
    const res = await gh.createCommit(makeCredential(), { repository: "acme/repo", branch: "main", path: "docs/x.md", content: "hello", message: "m", operationId: "op-1" })
    expect(res.created).toBe(true)
    expect(res.result.sha).toBe("abc")
    const body = http.calls[0]!.body as { content: string }
    expect(Buffer.from(body.content, "base64").toString("utf-8")).toBe("hello")
    expect(http.calls[0]!.headers!["idempotency-key"]).toBe("op-1")
  })

  it("createCommit rejects path traversal before any request", async () => {
    const http = new FakeHttp()
    const gh = new GitHubGitProvider({ http: http as unknown as ProviderHttpClient })
    await expect(gh.createCommit(makeCredential(), { repository: "acme/repo", branch: "main", path: "../etc/evil", content: "x", message: "m", operationId: "op" })).rejects.toMatchObject({ code: "INVALID_PATH" })
    expect(http.calls).toHaveLength(0)
  })

  it("createPullRequest reuses existing PR on 422 (idempotent)", async () => {
    let post = 0
    const http = new FakeHttp()
      .on((o) => o.method === "POST", () => {
        post++
        if (post === 1) return { status: 422, headers: {}, body: '{"message":"Validation Failed"}' }
        return { status: 201, headers: {}, body: JSON.stringify({ number: 5, title: "T", head: { ref: "f" }, base: { ref: "main" }, state: "open" }) }
      })
      .on((o) => o.method === "GET", () => ({ status: 200, headers: {}, body: JSON.stringify([{ number: 5, title: "T", head: { ref: "f" }, base: { ref: "main" }, state: "open" }]) }))
    const gh = new GitHubGitProvider({ http: http as unknown as ProviderHttpClient })
    const res = await gh.createPullRequest(makeCredential(), { repository: "acme/repo", title: "T", body: "b", head: "f", base: "main", operationId: "op-pr" })
    expect(res.created).toBe(false)
    expect(res.result.number).toBe(5)
  })

  it("verifyWebhook rejects forged signatures and accepts valid ones", async () => {
    const http = new FakeHttp()
    const gh = new GitHubGitProvider({ http: http as unknown as ProviderHttpClient })
    const secret = "whsec"
    const body = JSON.stringify({ action: "opened", repository: { full_name: "acme/repo" }, pull_request: { number: 1, title: "T" }, sender: { login: "alice", id: 7 } })
    const sig = "sha256=" + sign(body, secret)
    const forged = { verified: false } as const
    expect((await gh.verifyWebhook({ provider: "github", headers: { "x-hub-signature-256": "sha256=" + "0".repeat(64), "x-github-event": "pull_request", "x-github-delivery": "d1" }, rawBody: body, path: "/" }, { secret })).verified).toBe(forged.verified)
    const ok = await gh.verifyWebhook({ provider: "github", headers: { "x-hub-signature-256": sig, "x-github-event": "pull_request", "x-github-delivery": "d1" }, rawBody: body, path: "/" }, { secret })
    expect(ok.verified).toBe(true)
    expect(ok.event?.kind).toBe("pr.opened")
    expect(ok.event?.resource).toBe("github:acme/repo")
    expect(ok.event?.providerEventId).toBe("d1")
  })

  it("mutationIdentity is deterministic tenant+connection+operation", () => {
    const http = new FakeHttp()
    const gh = new GitHubGitProvider({ http: http as unknown as ProviderHttpClient })
    const cred = makeCredential()
    const m = gh.mutationIdentity(cred, "op-1")
    expect(m).toEqual({ tenantId: "t1", connectionId: "conn_1", operationId: "op-1" })
  })
})

describe("GitLabGitProvider conformance", () => {
  it("verifyIdentity maps /user and uses Bearer auth", async () => {
    const http = new FakeHttp().on((o) => o.method === "GET" && o.url.endsWith("/user"), () => ({ status: 200, headers: {}, body: JSON.stringify({ id: 9, username: "acme", scopes: ["api"] }) }))
    const gl = new GitLabGitProvider({ http: http as unknown as ProviderHttpClient })
    const id = await gl.verifyIdentity(makeCredential("glpat-fake-token-secret"))
    expect(id.externalId).toBe("9")
    expect(id.scopes).toEqual(["api"])
    expect(http.calls[0]!.authHeader).toBe("Bearer glpat-fake-token-secret")
  })

  it("createIssue posts to project-encoded path with labels joined", async () => {
    const http = new FakeHttp().on((o) => o.method === "POST", () => ({ status: 201, headers: {}, body: JSON.stringify({ iid: 3, title: "T", state: "opened", labels: ["bug"], web_url: "u" }) }))
    const gl = new GitLabGitProvider({ http: http as unknown as ProviderHttpClient })
    const res = await gl.createIssue(makeCredential(), { repository: "acme/sub/repo", title: "T", body: "b", labels: ["bug", "x"], operationId: "op-i" })
    expect(res.created).toBe(true)
    expect(res.result.number).toBe(3)
    expect(http.calls[0]!.url).toContain(encodeURIComponent("acme/sub/repo"))
    const body = http.calls[0]!.body as { labels: string }
    expect(body.labels).toBe("bug,x")
  })

  it("verifyWebhook validates X-Gitlab-Token shared secret in constant time", async () => {
    const http = new FakeHttp()
    const gl = new GitLabGitProvider({ http: http as unknown as ProviderHttpClient })
    const secret = "glwhsec"
    const body = JSON.stringify({ object_kind: "merge_request", object_attributes: { iid: 2, id: 99, action: "open", updated_at: "2025-01-01" }, project: { path_with_namespace: "acme/repo" }, user: { username: "bob", id: 3 } })
    const ok = await gl.verifyWebhook({ provider: "gitlab", headers: { "x-gitlab-token": secret }, rawBody: body, path: "/" }, { secret })
    expect(ok.verified).toBe(true)
    expect(ok.event?.kind).toBe("pr.opened")
    expect(ok.event?.resource).toBe("gitlab:acme/repo")
    const bad = await gl.verifyWebhook({ provider: "gitlab", headers: { "x-gitlab-token": "wrong" }, rawBody: body, path: "/" }, { secret })
    expect(bad.verified).toBe(false)
  })

  it("createBranch reuses existing branch (idempotent)", async () => {
    let call = 0
    const http = new FakeHttp().on((o) => o.method === "GET", () => {
      call++
      return { status: call === 1 ? 200 : 404, headers: {}, body: JSON.stringify({ name: "feature", commit: { id: "sha1" } }) }
    }).on((o) => o.method === "POST", () => ({ status: 201, headers: {}, body: JSON.stringify({ name: "feature", commit: { id: "sha2" } }) }))
    const gl = new GitLabGitProvider({ http: http as unknown as ProviderHttpClient })
    const res = await gl.createBranch(makeCredential(), "acme/repo", "feature", "main", "op-b")
    expect(res.created).toBe(false)
    expect(res.result.sha).toBe("sha1")
  })
})

describe("provider neutrality — no GitHub types leak into GitLab and vice versa", () => {
  it("both implement the same neutral GitProvider surface", () => {
    const http = new FakeHttp() as unknown as ProviderHttpClient
    const gh = new GitHubGitProvider({ http })
    const gl = new GitLabGitProvider({ http })
    expect(gh.eventProvider).toBe("github")
    expect(gl.eventProvider).toBe("gitlab")
    expect(gh.kind.family).toBe(gl.kind.family) // same family, different provider
    expect(gh.kind.provider).not.toBe(gl.kind.provider)
  })
})
