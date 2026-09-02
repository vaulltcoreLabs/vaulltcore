/**
 * Neutral GitProvider contract (Phase 2C).
 *
 * Implemented by GitHub and GitLab adapters (and future Bitbucket/Azure
 * DevOps). GitHub-specific types do NOT leak here; both adapters speak this
 * surface. Every operation carries tenant scope via the resolved credential
 * and an idempotency strategy where mutation occurs (deterministic
 * ExternalMutation identity).
 *
 * Security: the adapter receives a {@link ResolvedCredential} (never the raw
 * secret store); tenantId/orgId/projectId come from the credential, never
 * from a request body. Repository URLs are validated against SSRF + a
 * provider host allow-list; path traversal in file paths is rejected.
 */

import type {
  IntegrationProvider,
  ProviderIdentity,
  ExternalResource,
  ExternalMutation,
  RawWebhook,
  WebhookVerifyResult,
  NormalizedEventKind,
} from "@vaulltcore/integration"
import type { ResolvedCredential } from "@vaulltcore/credentials"

/** A git repository (neutral; no GitHub/GitLab fields). */
export interface GitRepository {
  readonly id: string
  readonly fullName: string
  readonly name: string
  readonly defaultBranch: string | null
  readonly url: string | null
  readonly visibility: "public" | "private" | "internal" | null
  readonly metadata: Readonly<Record<string, unknown>>
}

/** A branch ref. */
export interface GitBranch {
  readonly name: string
  readonly sha: string
  readonly protected: boolean
}

/** A file in a repo at a ref. */
export interface GitFile {
  readonly path: string
  readonly content: string
  readonly encoding: "utf-8" | "base64"
  readonly sha: string | null
  readonly size: number | null
}

/** A commit. */
export interface GitCommit {
  readonly sha: string
  readonly message: string
  readonly author: { readonly name: string | null; readonly email: string | null }
  readonly url: string | null
}

/** A pull/merge request (neutral). */
export interface GitPullRequest {
  readonly number: number
  readonly title: string
  readonly state: "open" | "closed" | "merged"
  readonly head: string
  readonly base: string
  readonly draft: boolean
  readonly url: string | null
  readonly body: string | null
}

/** A git issue (neutral). */
export interface GitIssue {
  readonly number: number
  readonly title: string
  readonly state: "open" | "closed"
  readonly body: string | null
  readonly url: string | null
  readonly labels: readonly string[]
}

/** Input to create a commit (file write). Idempotent on operationId. */
export interface CreateCommitInput {
  readonly repository: string
  readonly branch: string
  readonly path: string
  readonly content: string
  readonly message: string
  /** Stable operation id for idempotency; deterministic ExternalMutation. */
  readonly operationId: string
  readonly author?: { readonly name: string; readonly email: string }
  /** Create the branch from this ref if it does not exist. */
  readonly createBranchFrom?: string
}

/** Input to create a pull/merge request. Idempotent on operationId. */
export interface CreatePullRequestInput {
  readonly repository: string
  readonly title: string
  readonly body: string
  readonly head: string
  readonly base: string
  readonly operationId: string
  readonly draft?: boolean
}

/** Input to create an issue. Idempotent on operationId. */
export interface CreateIssueInput {
  readonly repository: string
  readonly title: string
  readonly body: string
  readonly labels?: readonly string[]
  readonly operationId: string
}

/** Result of an idempotent mutation: created vs replayed (existing). */
export interface MutationResult<T> {
  readonly result: T
  readonly created: boolean
  readonly operationId: string
}

/**
 * Neutral git provider. Adapters implement this + IntegrationProvider
 * (identity/webhook). No GitHub/GitLab types appear here.
 */
export interface GitProvider extends IntegrationProvider {
  listRepositories(credential: ResolvedCredential, options?: { readonly since?: number }): Promise<readonly GitRepository[]>
  getRepository(credential: ResolvedCredential, repository: string): Promise<GitRepository | null>
  listBranches(credential: ResolvedCredential, repository: string): Promise<readonly GitBranch[]>
  readFile(credential: ResolvedCredential, repository: string, path: string, ref: string): Promise<GitFile | null>
  createCommit(credential: ResolvedCredential, input: CreateCommitInput): Promise<MutationResult<GitCommit>>
  createBranch(credential: ResolvedCredential, repository: string, branch: string, fromRef: string, operationId: string): Promise<MutationResult<GitBranch>>
  createPullRequest(credential: ResolvedCredential, input: CreatePullRequestInput): Promise<MutationResult<GitPullRequest>>
  getPullRequest(credential: ResolvedCredential, repository: string, number: number): Promise<GitPullRequest | null>
  createIssue(credential: ResolvedCredential, input: CreateIssueInput): Promise<MutationResult<GitIssue>>
  getIssue(credential: ResolvedCredential, repository: string, number: number): Promise<GitIssue | null>
  updateIssue(credential: ResolvedCredential, repository: string, number: number, update: { readonly state?: "open" | "closed"; readonly labels?: readonly string[] }, operationId: string): Promise<MutationResult<GitIssue>>
  /** The mutation identity boundary this provider uses for a given op. */
  mutationIdentity(credential: ResolvedCredential, operationId: string): ExternalMutation
  /** Provider-specific kind label for normalized event resources. */
  readonly eventProvider: string
  /** Normalize a webhook into a NeutralEvent-ish partial (verifyWebhook delegates). */
  normalizeEvent(raw: RawWebhook): Omit<import("@vaulltcore/integration").NormalizedEvent, "eventId" | "tenantId" | "orgId" | "projectId" | "receivedAt"> | null
}
