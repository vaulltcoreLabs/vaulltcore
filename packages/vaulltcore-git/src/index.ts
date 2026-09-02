/**
 * Vaulltcore Git Providers (Phase 2C).
 *
 * Neutral {@link GitProvider} contract implemented by GitHub and GitLab
 * adapters over the SSRF-guarded HTTP seam. No provider SDK is a dependency.
 * Every operation is tenant-scoped via the resolved credential; mutations
 * carry deterministic idempotency identity; webhook verification + event
 * normalization are provider-specific but map to neutral kinds.
 *
 * Dependency direction: git → {integration, credentials}. Never depends on
 * the runner, a provider SDK, or the control plane. No vendor is a dependency.
 */

export type {
  GitProvider,
  GitRepository,
  GitBranch,
  GitFile,
  GitCommit,
  GitPullRequest,
  GitIssue,
  CreateCommitInput,
  CreatePullRequestInput,
  CreateIssueInput,
  MutationResult,
} from "./contracts"
export {
  BaseGitProvider,
  type BaseGitProviderOptions,
  validateRepoPath,
  validateFilePath,
  validateBranchName,
  verifyHmacSha256,
  mapGitEventKind,
} from "./base"
export { GitHubGitProvider, type GitHubProviderOptions } from "./github"
export { GitLabGitProvider, type GitLabProviderOptions } from "./gitlab"
// Phase 2D: OAuth authorization adapters (neutral OAuthProviderAdapter seam).
export { GitHubOAuthAdapter, type GitHubOAuthAdapterOptions, fingerprintToken } from "./github-oauth"
export { GitLabOAuthAdapter, type GitLabOAuthAdapterOptions } from "./gitlab-oauth"
