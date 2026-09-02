/**
 * GitLab GitProvider adapter (Phase 2C).
 *
 * Same neutral {@link GitProvider} contract as GitHub, implemented over the
 * GitLab REST API (v4) via the SSRF-guarded HTTP seam. OAuth/PAT token
 * recorded at connection time; rotation without identity change. GitHub-
 * specific types do NOT leak into this adapter. Webhook verification uses
 * GitLab's `X-Gitlab-Token` shared-secret (HMAC is not GitLab's default) and
 * event normalization maps to the same neutral kinds.
 */

import type { ProviderKind, ProviderIdentity, RawWebhook, WebhookVerifyResult, NormalizedEvent } from "@vaulltcore/integration"
import type { ProviderHttpClient, ProviderHttpOptions } from "@vaulltcore/integration"
import type { ResolvedCredential } from "@vaulltcore/credentials"
import { BaseGitProvider, BaseGitProviderOptions, validateRepoPath, validateFilePath, validateBranchName, mapGitEventKind } from "./base"
import type { GitRepository, GitBranch, GitFile, GitCommit, GitPullRequest, GitIssue, CreateCommitInput, CreatePullRequestInput, CreateIssueInput, MutationResult } from "./contracts"

export interface GitLabProviderOptions extends BaseGitProviderOptions {
  readonly apiBase?: string
  readonly allowHttpBase?: boolean
  readonly http?: ProviderHttpClient
}

const GITLAB_KIND: ProviderKind = {
  family: "git",
  provider: "gitlab-com",
  label: "GitLab",
  capabilities: ["repo:read", "repo:write", "issue:read", "issue:write", "pr:read", "pr:write", "webhook:verify"],
}

function authHeader(credential: ResolvedCredential): string {
  return `Bearer ${credential.secret}`
}

/** URL-encode a GitLab project path ("group/subgroup/name"). */
function projectEncoded(repository: string): string {
  return encodeURIComponent(repository)
}

export class GitLabGitProvider extends BaseGitProvider {
  readonly kind = GITLAB_KIND
  readonly eventProvider = "gitlab"
  private readonly apiBase: string

  constructor(options: GitLabProviderOptions = {}) {
    super({ http: options.http })
    this.apiBase = (options.apiBase ?? "https://gitlab.com/api/v4").replace(/\/$/, "")
  }

  private async gl(credential: ResolvedCredential, opts: Omit<ProviderHttpOptions, "authHeader"> & { readonly url: string }): Promise<{ status: number; body: string; headers: Readonly<Record<string, string>> }> {
    const res = await this.http.request({ ...opts, authHeader: authHeader(credential), headers: { "user-agent": "vaulltcore", ...(opts.headers ?? {}) } })
    return { status: res.status, body: res.body, headers: res.headers }
  }

  async verifyIdentity(credential: ResolvedCredential): Promise<ProviderIdentity> {
    const res = await this.gl(credential, { method: "GET", url: `${this.apiBase}/user` })
    this.ensureOk(res.status, res.body, "verifyIdentity")
    const u = JSON.parse(res.body)
    return { externalId: String(u.id), displayName: u.username ?? null, scopes: (u.scopes ?? []) as string[] }
  }

  async listRepositories(credential: ResolvedCredential, _options?: { readonly since?: number }): Promise<readonly GitRepository[]> {
    const res = await this.gl(credential, { method: "GET", url: `${this.apiBase}/projects?membership=true&per_page=100&order_by=updated_at` })
    this.ensureOk(res.status, res.body, "listRepositories")
    const arr = JSON.parse(res.body) as any[]
    return arr.map((r) => this.mapRepo(r))
  }

  async getRepository(credential: ResolvedCredential, repository: string): Promise<GitRepository | null> {
    validateRepoPath(repository)
    const res = await this.gl(credential, { method: "GET", url: `${this.apiBase}/projects/${projectEncoded(repository)}` })
    if (res.status === 404) return null
    this.ensureOk(res.status, res.body, "getRepository")
    return this.mapRepo(JSON.parse(res.body))
  }

  async listBranches(credential: ResolvedCredential, repository: string): Promise<readonly GitBranch[]> {
    validateRepoPath(repository)
    const res = await this.gl(credential, { method: "GET", url: `${this.apiBase}/projects/${projectEncoded(repository)}/repository/branches?per_page=100` })
    this.ensureOk(res.status, res.body, "listBranches")
    const arr = JSON.parse(res.body) as any[]
    return arr.map((b) => ({ name: b.name, sha: b.commit?.id ?? "", protected: !!b.protected }))
  }

  async readFile(credential: ResolvedCredential, repository: string, path: string, ref: string): Promise<GitFile | null> {
    validateRepoPath(repository)
    validateFilePath(path)
    validateBranchName(ref)
    const res = await this.gl(credential, { method: "GET", url: `${this.apiBase}/projects/${projectEncoded(repository)}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}` })
    if (res.status === 404) return null
    this.ensureOk(res.status, res.body, "readFile")
    return { path, content: res.body, encoding: "utf-8" as const, sha: null, size: null }
  }

  async createCommit(credential: ResolvedCredential, input: CreateCommitInput): Promise<MutationResult<GitCommit>> {
    validateRepoPath(input.repository)
    validateFilePath(input.path)
    validateBranchName(input.branch)
    // GitLab commits API is idempotent on (branch, action, content): re-running
    // with identical content is a no-op-ish new commit; we rely on the durable
    // ExternalMutation idempotency boundary above this adapter to dedupe.
    const res = await this.gl(credential, {
      method: "POST", url: `${this.apiBase}/projects/${projectEncoded(input.repository)}/repository/commits`,
      headers: { "idempotency-key": input.operationId },
      body: { branch: input.branch, commit_message: input.message, actions: [{ action: "create" as const, file_path: input.path, content: input.content }] },
    })
    this.ensureOk(res.status, res.body, "createCommit")
    const j = JSON.parse(res.body)
    const commit: GitCommit = { sha: j.id ?? "", message: input.message, author: { name: j.author_name ?? null, email: j.author_email ?? null }, url: j.web_url ?? null }
    return { result: commit, created: true, operationId: input.operationId }
  }

  async createBranch(credential: ResolvedCredential, repository: string, branch: string, fromRef: string, operationId: string): Promise<MutationResult<GitBranch>> {
    validateRepoPath(repository)
    validateBranchName(branch)
    validateBranchName(fromRef)
    const existing = await this.gl(credential, { method: "GET", url: `${this.apiBase}/projects/${projectEncoded(repository)}/repository/branches/${encodeURIComponent(branch)}` })
    if (existing.status === 200) {
      const b = JSON.parse(existing.body)
      return { result: { name: b.name, sha: b.commit?.id ?? "", protected: !!b.protected }, created: false, operationId }
    }
    const res = await this.gl(credential, {
      method: "POST", url: `${this.apiBase}/projects/${projectEncoded(repository)}/repository/branches`,
      headers: { "idempotency-key": operationId },
      body: { branch, ref: fromRef },
    })
    if (res.status === 400 || res.status === 409) {
      // already exists race
      const b2 = await this.gl(credential, { method: "GET", url: `${this.apiBase}/projects/${projectEncoded(repository)}/repository/branches/${encodeURIComponent(branch)}` })
      const bb = JSON.parse(b2.body)
      return { result: { name: bb.name, sha: bb.commit?.id ?? "", protected: !!bb.protected }, created: false, operationId }
    }
    this.ensureOk(res.status, res.body, "createBranch")
    const b = JSON.parse(res.body)
    return { result: { name: b.name, sha: b.commit?.id ?? "", protected: !!b.protected }, created: true, operationId }
  }

  async createPullRequest(credential: ResolvedCredential, input: CreatePullRequestInput): Promise<MutationResult<GitPullRequest>> {
    validateRepoPath(input.repository)
    validateBranchName(input.head)
    validateBranchName(input.base)
    const res = await this.gl(credential, {
      method: "POST", url: `${this.apiBase}/projects/${projectEncoded(input.repository)}/merge_requests`,
      headers: { "idempotency-key": input.operationId },
      body: { title: input.title, description: input.body, source_branch: input.head, target_branch: input.base, draft: input.draft ?? false },
    })
    this.ensureOk(res.status, res.body, "createPullRequest")
    return { result: this.mapMr(JSON.parse(res.body)), created: true, operationId: input.operationId }
  }

  async getPullRequest(credential: ResolvedCredential, repository: string, number: number): Promise<GitPullRequest | null> {
    validateRepoPath(repository)
    const res = await this.gl(credential, { method: "GET", url: `${this.apiBase}/projects/${projectEncoded(repository)}/merge_requests/${number}` })
    if (res.status === 404) return null
    this.ensureOk(res.status, res.body, "getPullRequest")
    return this.mapMr(JSON.parse(res.body))
  }

  async createIssue(credential: ResolvedCredential, input: CreateIssueInput): Promise<MutationResult<GitIssue>> {
    validateRepoPath(input.repository)
    const res = await this.gl(credential, {
      method: "POST", url: `${this.apiBase}/projects/${projectEncoded(input.repository)}/issues`,
      headers: { "idempotency-key": input.operationId },
      body: { title: input.title, description: input.body, labels: (input.labels ?? []).join(",") },
    })
    this.ensureOk(res.status, res.body, "createIssue")
    return { result: this.mapIssue(JSON.parse(res.body)), created: true, operationId: input.operationId }
  }

  async getIssue(credential: ResolvedCredential, repository: string, number: number): Promise<GitIssue | null> {
    validateRepoPath(repository)
    const res = await this.gl(credential, { method: "GET", url: `${this.apiBase}/projects/${projectEncoded(repository)}/issues/${number}` })
    if (res.status === 404) return null
    this.ensureOk(res.status, res.body, "getIssue")
    return this.mapIssue(JSON.parse(res.body))
  }

  async updateIssue(credential: ResolvedCredential, repository: string, number: number, update: { readonly state?: "open" | "closed"; readonly labels?: readonly string[] }, operationId: string): Promise<MutationResult<GitIssue>> {
    validateRepoPath(repository)
    const res = await this.gl(credential, {
      method: "PUT", url: `${this.apiBase}/projects/${projectEncoded(repository)}/issues/${number}`,
      headers: { "idempotency-key": operationId },
      body: { ...(update.state ? { state_event: update.state === "closed" ? "close" : "reopen" } : {}), ...(update.labels ? { labels: update.labels.join(",") } : {}) },
    })
    this.ensureOk(res.status, res.body, "updateIssue")
    return { result: this.mapIssue(JSON.parse(res.body)), created: true, operationId }
  }

  async verifyWebhook(raw: RawWebhook, options: { secret: string }): Promise<WebhookVerifyResult> {
    // GitLab uses a shared secret token header (X-Gitlab-Token). Compare in
    // constant time to avoid timing leaks.
    const token = raw.headers["x-gitlab-token"]
    if (typeof token !== "string" || token.length !== options.secret.length || !timingSafeEqualStr(token, options.secret)) {
      return { verified: false, reason: "invalid token", event: null }
    }
    const event = this.normalizeEvent(raw)
    return { verified: true, reason: null, event }
  }

  normalizeEvent(raw: RawWebhook): Omit<NormalizedEvent, "eventId" | "tenantId" | "orgId" | "projectId" | "receivedAt"> | null {
    let parsed: any
    try { parsed = JSON.parse(raw.rawBody) } catch { return null }
    const kind = parsed.object_kind
    if (!kind) return null
    const action = parsed.object_attributes?.action ?? parsed.object_attributes?.state ?? null
    const proj = parsed.project?.path_with_namespace ?? null
    const number = parsed.object_attributes?.iid ?? parsed.object_attributes?.id ?? null
    // Map GitLab kinds to neutral kinds via the shared mapper where possible.
    const mapped: string = kind === "merge_request" ? "pull_request" : kind === "issue" ? "issues" : kind === "push" ? "push" : kind
    return {
      provider: this.eventProvider,
      providerEventId: parsed.object_attributes?.id ? `${kind}-${parsed.object_attributes.id}` : `${kind}-${proj ?? "unknown"}-${number ?? Date.now()}`,
      kind: mapGitEventKind(mapped, action === "open" ? "opened" : action === "close" ? "closed" : action),
      resource: proj ? `gitlab:${proj}` : `gitlab:${kind}`,
      action,
      actor: parsed.user ? { externalId: String(parsed.user.id ?? parsed.user.username ?? ""), displayName: parsed.user.username ?? null } : null,
      payload: { kind, action, repository: proj, number },
      providerTimestamp: parsed.object_attributes?.updated_at ?? null,
    }
  }

  private mapRepo(r: any): GitRepository {
    return {
      id: String(r.id), fullName: r.path_with_namespace, name: r.name, defaultBranch: r.default_branch ?? null,
      url: r.web_url ?? null, visibility: r.visibility ?? null, metadata: { private: r.visibility === "private", archived: r.archived },
    }
  }
  private mapMr(m: any): GitPullRequest {
    const state: GitPullRequest["state"] = m.merged_at ? "merged" : m.state === "closed" ? "closed" : "open"
    return { number: m.iid, title: m.title, state, head: m.source_branch ?? "", base: m.target_branch ?? "", draft: !!m.draft, url: m.web_url ?? null, body: m.description ?? null }
  }
  private mapIssue(i: any): GitIssue {
    return { number: i.iid, title: i.title, state: i.state === "closed" ? "closed" : "open", body: i.description ?? null, url: i.web_url ?? null, labels: (i.labels ?? []) as string[] }
  }
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8")
  const bb = Buffer.from(b, "utf8")
  if (ba.length !== bb.length) return false
  // constant-time compare
  let diff = 0
  for (let i = 0; i < ba.length; i++) diff |= ba[i]! ^ bb[i]!
  return diff === 0
}
