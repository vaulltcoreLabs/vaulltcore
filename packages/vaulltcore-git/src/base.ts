/**
 * Shared base for git providers (Phase 2C).
 *
 * Common helpers: HMAC webhook verification, deterministic mutation identity,
 * repository-URL/path validation (SSRF + path traversal), GitHub-agnostic event
 * kind mapping helpers. Concrete adapters (github.ts, gitlab.ts) extend this.
 */

import {
  ProviderHttpClient,
  classifyResponse,
  verifyHmacSha256,
  type ExternalMutation,
  type NormalizedEventKind,
  type ProviderKind,
  type ProviderIdentity,
  type RawWebhook,
  type WebhookVerifyResult,
  type NormalizedEvent,
  type IntegrationProvider,
  IntegrationError,
} from "@vaulltcore/integration"
import type { ResolvedCredential } from "@vaulltcore/credentials"
import type { GitProvider, MutationResult, GitRepository, GitBranch, GitFile, GitCommit, GitPullRequest, GitIssue, CreateCommitInput, CreatePullRequestInput, CreateIssueInput } from "./contracts"

// Re-export the shared webhook verifier so callers can use it from the git
// package without depending on the integration package directly.
export { verifyHmacSha256 } from "@vaulltcore/integration"

/** Validate a repository path against path traversal and basic shape.
 *  A repo is "owner/name" (GitHub) or "group/subgroup/name" (GitLab). */
export function validateRepoPath(repository: string): void {
  if (!/^[A-Za-z0-9._\-/]+$/.test(repository)) {
    throw new IntegrationError("INVALID_REPOSITORY", "repository path contains disallowed characters", "permanent_validation", 422)
  }
  if (repository.includes("..") || repository.startsWith("/") || repository.endsWith("/")) {
    throw new IntegrationError("INVALID_REPOSITORY", "repository path is malformed", "permanent_validation", 422)
  }
}

/** Validate a file path: no absolute, no traversal, no NUL. */
export function validateFilePath(path: string): void {
  if (path.length === 0 || path.startsWith("/") || path.includes("..") || path.includes("\0")) {
    throw new IntegrationError("INVALID_PATH", "file path is malformed", "permanent_validation", 422)
  }
}

/** Validate a branch name (git ref rules: no .., no spaces, no leading .). */
export function validateBranchName(branch: string): void {
  if (!/^[A-Za-z0-9._\-/]+$/.test(branch) || branch.includes("..") || branch.startsWith(".")) {
    throw new IntegrationError("INVALID_BRANCH", "branch name is malformed", "permanent_validation", 422)
  }
}

export interface BaseGitProviderOptions {
  /** Injectable HTTP client (tests / fakes). */
  readonly http?: ProviderHttpClient
}

/** Abstract base providing webhook verify + mutation identity + validation. */
export abstract class BaseGitProvider implements GitProvider {
  abstract readonly kind: ProviderKind
  abstract readonly eventProvider: string
  protected readonly http: ProviderHttpClient

  constructor(options: BaseGitProviderOptions = {}) {
    this.http = options.http ?? new ProviderHttpClient({ allowHttp: true })
  }

  abstract verifyIdentity(credential: ResolvedCredential): Promise<ProviderIdentity>
  abstract verifyWebhook(raw: RawWebhook, options: { secret: string }): Promise<WebhookVerifyResult>
  abstract normalizeEvent(raw: RawWebhook): Omit<NormalizedEvent, "eventId" | "tenantId" | "orgId" | "projectId" | "receivedAt"> | null
  abstract listRepositories(credential: ResolvedCredential, options?: { readonly since?: number }): Promise<readonly GitRepository[]>
  abstract getRepository(credential: ResolvedCredential, repository: string): Promise<GitRepository | null>
  abstract listBranches(credential: ResolvedCredential, repository: string): Promise<readonly GitBranch[]>
  abstract readFile(credential: ResolvedCredential, repository: string, path: string, ref: string): Promise<GitFile | null>
  abstract createCommit(credential: ResolvedCredential, input: CreateCommitInput): Promise<MutationResult<GitCommit>>
  abstract createBranch(credential: ResolvedCredential, repository: string, branch: string, fromRef: string, operationId: string): Promise<MutationResult<GitBranch>>
  abstract createPullRequest(credential: ResolvedCredential, input: CreatePullRequestInput): Promise<MutationResult<GitPullRequest>>
  abstract getPullRequest(credential: ResolvedCredential, repository: string, number: number): Promise<GitPullRequest | null>
  abstract createIssue(credential: ResolvedCredential, input: CreateIssueInput): Promise<MutationResult<GitIssue>>
  abstract getIssue(credential: ResolvedCredential, repository: string, number: number): Promise<GitIssue | null>
  abstract updateIssue(credential: ResolvedCredential, repository: string, number: number, update: { readonly state?: "open" | "closed"; readonly labels?: readonly string[] }, operationId: string): Promise<MutationResult<GitIssue>>

  mutationIdentity(credential: ResolvedCredential, operationId: string): ExternalMutation {
    return { tenantId: credential.tenantId, connectionId: credential.connectionId, operationId }
  }

  /** Helper for subclasses: classify an HTTP response into a typed error. */
  protected ensureOk(status: number, _body: string, context: string): void {
    if (status >= 200 && status < 300) return
    throw classifyResponse(status, `${context} failed: provider returned ${status}`)
  }
}

/** Map a GitHub-style event type/action to a neutral kind. */
export function mapGitEventKind(eventType: string, action: string | null): NormalizedEventKind {
  switch (eventType) {
    case "push": return "repo.push"
    case "pull_request":
      if (action === "opened" || action === "reopened") return "pr.opened"
      if (action === "closed") return "pr.closed"
      if (action === "edited" || action === "synchronize" || action === "ready_for_review") return "pr.updated"
      return "pr.updated"
    case "pull_request_review": return "review.submitted"
    case "issues":
      if (action === "opened") return "issue.opened"
      if (action === "closed") return "issue.closed"
      if (action === "edited" || action === "labeled" || action === "assigned") return "issue.updated"
      return "issue.updated"
    case "issue_comment": return "issue.commented"
    case "release": return "release.published"
    default: return "custom"
  }
}
