/**
 * Vaulltcore Connectors (Phase 2C).
 *
 * Neutral project-management + notification connector seams implemented by
 * Linear (GraphQL) and Slack (reuses Phase 2B delivery). No provider SDK is a
 * dependency. Every operation is tenant-scoped via the resolved credential;
 * mutations carry deterministic idempotency identity; webhook verification +
 * event normalization map to neutral kinds.
 *
 * Dependency direction: connectors → {integration, credentials, delivery}.
 * Never depends on the runner, a provider SDK, or the control plane.
 */

export type {
  ProjectManagementProvider,
  PmTeam,
  PmIssue,
  CreatePmIssueInput,
  PmMutationResult,
} from "./pm"
export { LinearProvider, type LinearProviderOptions } from "./linear"
export { SlackConnector, type SlackConnectorOptions, type ChannelMapping } from "./slack"
// Phase 2D: OAuth authorization adapters (neutral OAuthProviderAdapter seam).
export { LinearOAuthAdapter, type LinearOAuthAdapterOptions } from "./linear-oauth"
export { SlackOAuthAdapter, type SlackOAuthAdapterOptions } from "./slack-oauth"
