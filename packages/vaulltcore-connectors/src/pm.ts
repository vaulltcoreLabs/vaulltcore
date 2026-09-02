/**
 * Neutral project-management connector seam (Phase 2C).
 *
 * Implemented by Linear today; designed so Jira and other PM systems can be
 * added later without redesign. Same IntegrationProvider surface
 * (identity/webhook) plus PM-specific reads + scoped mutations, all carrying
 * tenant scope via the resolved credential and deterministic idempotency on
 * mutations. GitHub/GitLab types do NOT leak here.
 */

import type {
  IntegrationProvider,
  ProviderIdentity,
  ExternalMutation,
  RawWebhook,
  WebhookVerifyResult,
  NormalizedEvent,
} from "@vaulltcore/integration"
import type { ResolvedCredential } from "@vaulltcore/credentials"

/** A PM team/project. */
export interface PmTeam {
  readonly id: string
  readonly name: string
  readonly key: string | null
  readonly url: string | null
}

/** A PM issue. */
export interface PmIssue {
  readonly id: string
  readonly identifier: string | null
  readonly title: string
  readonly state: string
  readonly stateType: "backlog" | "unstarted" | "started" | "completed" | "canceled"
  readonly priority: number | null
  readonly url: string | null
  readonly description: string | null
  readonly labels: readonly string[]
}

/** Input to create a PM issue. Idempotent on operationId. */
export interface CreatePmIssueInput {
  readonly teamId: string
  readonly title: string
  readonly description: string
  readonly priority?: number
  readonly labels?: readonly string[]
  readonly operationId: string
}

/** Result of an idempotent mutation: created vs replayed. */
export interface PmMutationResult<T> {
  readonly result: T
  readonly created: boolean
  readonly operationId: string
}

/** Neutral project-management provider. */
export interface ProjectManagementProvider extends IntegrationProvider {
  listTeams(credential: ResolvedCredential): Promise<readonly PmTeam[]>
  getIssue(credential: ResolvedCredential, issueId: string): Promise<PmIssue | null>
  createIssue(credential: ResolvedCredential, input: CreatePmIssueInput): Promise<PmMutationResult<PmIssue>>
  updateIssue(credential: ResolvedCredential, issueId: string, update: { readonly stateId?: string; readonly priority?: number }, operationId: string): Promise<PmMutationResult<PmIssue>>
  addComment(credential: ResolvedCredential, issueId: string, body: string, operationId: string): Promise<PmMutationResult<{ readonly id: string }>>
  listLabels(credential: ResolvedCredential, teamId?: string): Promise<readonly { readonly id: string; readonly name: string }[]>
  mutationIdentity(credential: ResolvedCredential, operationId: string): ExternalMutation
  readonly eventProvider: string
  normalizeEvent(raw: RawWebhook): Omit<NormalizedEvent, "eventId" | "tenantId" | "orgId" | "projectId" | "receivedAt"> | null
}
