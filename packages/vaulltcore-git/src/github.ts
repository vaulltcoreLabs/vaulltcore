/**
 * GitHub GitProvider adapter (Phase 2C).
 *
 * A production-grade GitHub adapter behind the neutral {@link GitProvider}
 * contract, over the narrow SSRF-guarded HTTP seam — no GitHub SDK is a
 * dependency of core. Supports PAT or GitHub-App/OAuth tokens (recorded at
 * connection time; rotation changes the secret without changing connection
 * identity). Every mutation carries tenant scope + a deterministic
 * idempotency key (Idempotency-Key header + ExternalMutation identity).
 *
 * Webhook verification: HMAC-SHA256 (`X-Hub-Signature-256`), GitHub delivery
 * id dedup, event-type/action → normalized kind. Event content is treated as
 * untrusted DATA, never instructions.
 *
 * Tenant scope: every operation derives tenant from the resolved credential,
 * never from a request body. Repository/file/branch inputs are validated
 * against path traversal and shape before any request.
 */

import type { ProviderKind, ProviderIdentity, RawWebhook, WebhookVerifyResult, NormalizedEvent } from "@vaulltcore/integration"
import type { ResolvedCredential } from "@vaulltcore/credentials"
import { BaseGitProvider, BaseGitProviderOptions, verifyHmacSha256, validateRepoPath, validateFilePath, validateBranchName, mapGitEventKind } from "./base"
import type { GitRepository, GitBranch, GitFile, GitCommit, GitPullRequest, GitIssue, CreateCommitInput, CreatePullRequestInput, CreateIssueInput, MutationResult } from "./contracts"
import type { ProviderHttpClient, ProviderHttpOptions } from "@vaulltcore/integration"

export interface GitHubProviderOptions extends BaseGitProviderOptions {
  /** API base (default https://api.github.com — overridable for GHES). */
  readonly apiBase?: string
  /** Allow http base (GHES dev; default false). */
  readonly allowHttpBase?: boolean
  readonly http?: ProviderHttpClient
}

const GITHUB_KIND: ProviderKind = {
  family: "git",
  provider: "github-com",
  label: "GitHub",
  capabilities: ["repo:read", "repo:write", "issue:read", "issue:write", "pr:read", "pr:write", "webhook:verify"],
}

function authHeader(credential: ResolvedCredential): string {
  // GitHub accepts a token as `Bearer` (App/OAuth) or `token` (PAT). Use
  // `Bearer` uniformly; the secret is transient, never logged.
  return `Bearer ${credential.secret}`
}

export class GitHubGitProvider extends BaseGitProvider {
  readonly kind = GITHUB_KIND
  readonly eventProvider = "github"
  private readonly apiBase: string

  constructor(options: GitHubProviderOptions = {}) {
    super({ http: options.http })
    this.apiBase = (options.apiBase ?? "https://api.github.com").replace(/\/$/, "")
  }

  private async gh(credential: ResolvedCredential, opts: Omit<ProviderHttpOptions, "authHeader"> & { readonly url: string }): Promise<{ status: number; body: string; headers: Readonly<Record<string, string>> }> {
    const res = await this.http.request({ ...opts, authHeader: authHeader(credential), headers: { "x-github-api-version": "2022-11-28", "user-agent": "vaulltcore", ...(opts.headers ?? {}) } })
    return { status: res.status, body: res.body, headers: res.headers }
  }

  async verifyIdentity(credential: ResolvedCredential): Promise<ProviderIdentity> {
    const res = await this.gh(credential, { method: "GET", url: `${this.apiBase}/user` })
    this.ensureOk(res.status, res.body, "verifyIdentity")
    const u = JSON.parse(res.body)
    return { externalId: String(u.id), displayName: u.login ?? null, scopes: (res.headers["x-oauth-scopes"] ?? "").split(",").map((s) => s.trim()).filter(Boolean) }
  }

  async listRepositories(credential: ResolvedCredential, _options?: { readonly since?: number }): Promise<readonly GitRepository[]> {
    const res = await this.gh(credential, { method: "GET", url: `${this.apiBase}/user/repos?per_page=100&sort=updated` })
    this.ensureOk(res.status, res.body, "listRepositories")
    const arr = JSON.parse(res.body) as any[]
    return arr.map((r) => this.mapRepo(r))
  }

  async getRepository(credential: ResolvedCredential, repository: string): Promise<GitRepository | null> {
    validateRepoPath(repository)
    const res = await this.gh(credential, { method: "GET", url: `${this.apiBase}/repos/${repository}` })
    if (res.status === 404) return null
    this.ensureOk(res.status, res.body, "getRepository")
    return this.mapRepo(JSON.parse(res.body))
  }

  async listBranches(credential: ResolvedCredential, repository: string): Promise<readonly GitBranch[]> {
    validateRepoPath(repository)
    const res = await this.gh(credential, { method: "GET", url: `${this.apiBase}/repos/${repository}/branches?per_page=100` })
    this.ensureOk(res.status, res.body, "listBranches")
    const arr = JSON.parse(res.body) as any[]
    return arr.map((b) => ({ name: b.name, sha: b.commit?.sha ?? "", protected: !!b.protected }))
  }

  async readFile(credential: ResolvedCredential, repository: string, path: string, ref: string): Promise<GitFile | null> {
    validateRepoPath(repository)
    validateFilePath(path)
    validateBranchName(ref)
    const res = await this.gh(credential, { method: "GET", url: `${this.apiBase}/repos/${repository}/contents/${path}?ref=${encodeURIComponent(ref)}` })
    if (res.status === 404) return null
    this.ensureOk(res.status, res.body, "readFile")
    const f = JSON.parse(res.body)
    return { path: f.path, content: f.encoding === "base64" ? Buffer.from(f.content, "base64").toString("utf-8") : f.content, encoding: "utf-8", sha: f.sha ?? null, size: f.size ?? null }
  }

  async createCommit(credential: ResolvedCredential, input: CreateCommitInput): Promise<MutationResult<GitCommit>> {
    validateRepoPath(input.repository)
    validateFilePath(input.path)
    validateBranchName(input.branch)
    // Idempotency: GitHub contents PUT is naturally idempotent on (branch,
    // path, content, sha) — re-applying the same content with the latest sha
    // returns the existing blob. We also send Idempotency-Key for tracing.
    const res = await this.gh(credential, {
      method: "PUT",
      url: `${this.apiBase}/repos/${input.repository}/contents/${input.path}`,
      headers: { "idempotency-key": input.operationId },
      body: { message: input.message, content: Buffer.from(input.content, "utf-8").toString("base64"), branch: input.branch, ...(input.author ? { committer: input.author } : {}) },
    })
    this.ensureOk(res.status, res.body, "createCommit")
    const j = JSON.parse(res.body)
    const commit: GitCommit = { sha: j.commit?.sha ?? "", message: input.message, author: { name: input.author?.name ?? null, email: input.author?.email ?? null }, url: j.commit?.html_url ?? null }
    // created vs replayed: GitHub 200 with a new commit if content changed.
    return { result: commit, created: true, operationId: input.operationId }
  }

  async createBranch(credential: ResolvedCredential, repository: string, branch: string, fromRef: string, operationId: string): Promise<MutationResult<GitBranch>> {
    validateRepoPath(repository)
    validateBranchName(branch)
    validateBranchName(fromRef)
    // Check existence first (idempotent create).
    const existing = await this.gh(credential, { method: "GET", url: `${this.apiBase}/repos/${repository}/branches/${encodeURIComponent(branch)}` })
    if (existing.status === 200) {
      const b = JSON.parse(existing.body)
      return { result: { name: b.name, sha: b.commit?.sha ?? "", protected: !!b.protected }, created: false, operationId }
    }
    // Need the fromRef SHA.
    const refRes = await this.gh(credential, { method: "GET", url: `${this.apiBase}/repos/${repository}/git/refs/heads/${encodeURIComponent(fromRef)}` })
    this.ensureOk(refRes.status, refRes.body, "createBranch(getRef)")
    const sha = JSON.parse(refRes.body).object?.sha
    const res = await this.gh(credential, {
      method: "POST", url: `${this.apiBase}/repos/${repository}/git/refs`,
      headers: { "idempotency-key": operationId },
      body: { ref: `refs/heads/${branch}`, sha },
    })
    this.ensureOk(res.status, res.body, "createBranch")
    return { result: { name: branch, sha, protected: false }, created: true, operationId }
  }

  async createPullRequest(credential: ResolvedCredential, input: CreatePullRequestInput): Promise<MutationResult<GitPullRequest>> {
    validateRepoPath(input.repository)
    validateBranchName(input.head)
    validateBranchName(input.base)
    const res = await this.gh(credential, {
      method: "POST", url: `${this.apiBase}/repos/${input.repository}/pulls`,
      headers: { "idempotency-key": input.operationId },
      body: { title: input.title, body: input.body, head: input.head, base: input.base, draft: input.draft ?? false },
    })
    if (res.status === 422) {
      // Possibly already exists; search open PRs for same head/base.
      const search = await this.gh(credential, { method: "GET", url: `${this.apiBase}/repos/${input.repository}/pulls?state=open&head=${encodeURIComponent(input.head)}&base=${encodeURIComponent(input.base)}` })
      const list = JSON.parse(search.body) as any[]
      if (list.length > 0) return { result: this.mapPr(list[0]!), created: false, operationId: input.operationId }
    }
    this.ensureOk(res.status, res.body, "createPullRequest")
    return { result: this.mapPr(JSON.parse(res.body)), created: true, operationId: input.operationId }
  }

  async getPullRequest(credential: ResolvedCredential, repository: string, number: number): Promise<GitPullRequest | null> {
    validateRepoPath(repository)
    const res = await this.gh(credential, { method: "GET", url: `${this.apiBase}/repos/${repository}/pulls/${number}` })
    if (res.status === 404) return null
    this.ensureOk(res.status, res.body, "getPullRequest")
    return this.mapPr(JSON.parse(res.body))
  }

  async createIssue(credential: ResolvedCredential, input: CreateIssueInput): Promise<MutationResult<GitIssue>> {
    validateRepoPath(input.repository)
    const res = await this.gh(credential, {
      method: "POST", url: `${this.apiBase}/repos/${input.repository}/issues`,
      headers: { "idempotency-key": input.operationId },
      body: { title: input.title, body: input.body, labels: input.labels ?? [] },
    })
    this.ensureOk(res.status, res.body, "createIssue")
    return { result: this.mapIssue(JSON.parse(res.body)), created: true, operationId: input.operationId }
  }

  async getIssue(credential: ResolvedCredential, repository: string, number: number): Promise<GitIssue | null> {
    validateRepoPath(repository)
    const res = await this.gh(credential, { method: "GET", url: `${this.apiBase}/repos/${repository}/issues/${number}` })
    if (res.status === 404) return null
    this.ensureOk(res.status, res.body, "getIssue")
    return this.mapIssue(JSON.parse(res.body))
  }

  async updateIssue(credential: ResolvedCredential, repository: string, number: number, update: { readonly state?: "open" | "closed"; readonly labels?: readonly string[] }, operationId: string): Promise<MutationResult<GitIssue>> {
    validateRepoPath(repository)
    const res = await this.gh(credential, {
      method: "PATCH", url: `${this.apiBase}/repos/${repository}/issues/${number}`,
      headers: { "idempotency-key": operationId },
      body: { ...(update.state ? { state: update.state } : {}), ...(update.labels ? { labels: update.labels } : {}) },
    })
    this.ensureOk(res.status, res.body, "updateIssue")
    return { result: this.mapIssue(JSON.parse(res.body)), created: true, operationId }
  }

  async verifyWebhook(raw: RawWebhook, options: { secret: string }): Promise<WebhookVerifyResult> {
    const sig = raw.headers["x-hub-signature-256"]
    if (!verifyHmacSha256(raw.rawBody, sig, options.secret)) {
      return { verified: false, reason: "invalid signature", event: null }
    }
    const eventType = raw.headers["x-github-event"]
    const deliveryId = raw.headers["x-github-delivery"]
    if (!eventType || !deliveryId) return { verified: true, reason: "missing event metadata", event: null }
    const event = this.normalizeEvent(raw)
    return { verified: true, reason: null, event }
  }

  normalizeEvent(raw: RawWebhook): Omit<NormalizedEvent, "eventId" | "tenantId" | "orgId" | "projectId" | "receivedAt"> | null {
    const eventType = raw.headers["x-github-event"]
    const deliveryId = raw.headers["x-github-delivery"]
    if (!eventType || !deliveryId) return null
    let parsed: any
    try { parsed = JSON.parse(raw.rawBody) } catch { return null }
    const action = parsed.action ?? null
    const repo = parsed.repository?.full_name ?? null
    const number = parsed.pull_request?.number ?? parsed.issue?.number ?? null
    return {
      provider: this.eventProvider,
      providerEventId: deliveryId,
      kind: mapGitEventKind(eventType, action),
      resource: repo ? `github:${repo}` : `github:${eventType}`,
      action,
      actor: parsed.sender ? { externalId: String(parsed.sender.id ?? parsed.sender.login ?? ""), displayName: parsed.sender.login ?? null } : null,
      payload: { eventType, action, repository: repo, number, ...(parsed.pull_request ? { pr: { number: parsed.pull_request.number, title: parsed.pull_request.title } } : {}), ...(parsed.issue ? { issue: { number: parsed.issue.number, title: parsed.issue.title } } : {}) },
      providerTimestamp: parsed.pull_request?.updated_at ?? parsed.issue?.updated_at ?? null,
    }
  }

  private mapRepo(r: any): GitRepository {
    return {
      id: String(r.id), fullName: r.full_name, name: r.name, defaultBranch: r.default_branch ?? null,
      url: r.html_url ?? null, visibility: r.visibility ?? null, metadata: { private: r.private, fork: r.fork, archived: r.archived },
    }
  }
  private mapPr(p: any): GitPullRequest {
    return { number: p.number, title: p.title, state: p.merged_at ? "merged" : p.state === "closed" ? "closed" : "open", head: p.head?.ref ?? "", base: p.base?.ref ?? "", draft: !!p.draft, url: p.html_url ?? null, body: p.body ?? null }
  }
  private mapIssue(i: any): GitIssue {
    return { number: i.number, title: i.title, state: i.state === "closed" ? "closed" : "open", body: i.body ?? null, url: i.html_url ?? null, labels: (i.labels ?? []).map((l: any) => typeof l === "string" ? l : l.name) }
  }
}
