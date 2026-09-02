/**
 * Linear project-management connector (Phase 2C).
 *
 * Implements {@link ProjectManagementProvider} over the Linear GraphQL API via
 * the SSRF-guarded HTTP seam. No Linear SDK is a dependency. API key
 * (recorded at connection time; rotation without identity change) flows only
 * through the resolved credential. Every mutation carries a deterministic
 * idempotency boundary. Webhook verification uses Linear's HMAC signature
 * header; event content is untrusted data.
 *
 * Tenant scope: tenant from resolved credential, never request body.
 */

import { ProviderHttpClient, classifyResponse, IntegrationError, verifyHmacSha256, type ProviderKind, type ProviderIdentity, type ExternalMutation, type RawWebhook, type WebhookVerifyResult, type NormalizedEvent, type ProviderHttpOptions, type ProviderHttpClient as ProviderHttpClientType } from "@vaulltcore/integration"
import type { ResolvedCredential } from "@vaulltcore/credentials"
import type { ProjectManagementProvider, PmTeam, PmIssue, CreatePmIssueInput, PmMutationResult } from "./pm"

const LINEAR_KIND: ProviderKind = {
  family: "project",
  provider: "linear",
  label: "Linear",
  capabilities: ["issue:read", "issue:write", "webhook:verify"],
}

export interface LinearProviderOptions {
  readonly http?: ProviderHttpClient
  readonly apiBase?: string
}

interface GqlResponse {
  readonly data?: Record<string, unknown>
  readonly errors?: Array<{ readonly message: string }>
}

export class LinearProvider implements ProjectManagementProvider {
  readonly kind = LINEAR_KIND
  readonly eventProvider = "linear"
  private readonly http: ProviderHttpClientType
  private readonly apiBase: string

  constructor(options: LinearProviderOptions = {}) {
    this.http = options.http ?? new ProviderHttpClient({ allowHttp: true })
    this.apiBase = options.apiBase ?? "https://api.linear.app/graphql"
  }

  private async gql(credential: ResolvedCredential, query: string, variables?: Record<string, unknown>): Promise<GqlResponse> {
    let res
    try {
      res = await this.http.request({
        method: "POST", url: this.apiBase, authHeader: credential.secret,
        headers: { "content-type": "application/json" },
        body: { query, variables },
      } as ProviderHttpOptions)
    } catch (e) {
      throw new IntegrationError("LINEAR_HTTP_ERROR", "linear request error", "transient", 502)
    }
    if (res.status === 401) throw new IntegrationError("LINEAR_UNAUTHORIZED", "linear unauthorized", "auth_config", 401)
    if (res.status === 429) throw new IntegrationError("LINEAR_RATE_LIMITED", "linear rate limited", "rate_limited", 429)
    if (res.status < 200 || res.status >= 300) throw classifyResponse(res.status, `linear query failed: ${res.status}`)
    let parsed: GqlResponse
    try { parsed = JSON.parse(res.body) } catch { throw new IntegrationError("LINEAR_BAD_RESPONSE", "linear returned non-JSON", "transient", 502) }
    if (parsed.errors && parsed.errors.length) throw new IntegrationError("LINEAR_GRAPHQL_ERROR", parsed.errors[0]!.message, "permanent_validation", 422)
    return parsed
  }

  async verifyIdentity(credential: ResolvedCredential): Promise<ProviderIdentity> {
    const r = await this.gql(credential, `query { viewer { id name email } }`)
    const v = r.data?.["viewer"] as { id: string; name: string; email: string } | undefined
    if (!v) throw new IntegrationError("LINEAR_NO_VIEWER", "linear returned no viewer", "transient", 502)
    return { externalId: v.id, displayName: v.name, scopes: ["read", "write"] }
  }

  async listTeams(credential: ResolvedCredential): Promise<readonly PmTeam[]> {
    const r = await this.gql(credential, `query { teams { nodes { id name key url } } }`)
    const nodes = ((r.data?.["teams"] as { nodes: any[] } | undefined)?.nodes) ?? []
    return nodes.map((t) => ({ id: t.id, name: t.name, key: t.key ?? null, url: t.url ?? null }))
  }

  async getIssue(credential: ResolvedCredential, issueId: string): Promise<PmIssue | null> {
    const r = await this.gql(credential, `query($id: String!) { issue(id: $id) { id identifier title url description priority state { name type } labels { nodes { name } } } }`, { id: issueId })
    const i = r.data?.["issue"] as any
    if (!i) return null
    return this.mapIssue(i)
  }

  async createIssue(credential: ResolvedCredential, input: CreatePmIssueInput): Promise<PmMutationResult<PmIssue>> {
    const r = await this.gql(credential, `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier title state { name type } priority url description labels { nodes { name } } } } }`, { input: { teamId: input.teamId, title: input.title, description: input.description, priority: input.priority, labelIds: [] } })
    const ic = (r.data?.["issueCreate"] as { success: boolean; issue: any } | undefined)
    if (!ic?.success || !ic.issue) throw new IntegrationError("LINEAR_CREATE_FAILED", "linear issueCreate failed", "permanent_validation", 422)
    return { result: this.mapIssue(ic.issue), created: true, operationId: input.operationId }
  }

  async updateIssue(credential: ResolvedCredential, issueId: string, update: { readonly stateId?: string; readonly priority?: number }, operationId: string): Promise<PmMutationResult<PmIssue>> {
    const r = await this.gql(credential, `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id identifier title state { name type } priority url description labels { nodes { name } } } } }`, { id: issueId, input: { ...(update.stateId ? { stateId: update.stateId } : {}), ...(update.priority !== undefined ? { priority: update.priority } : {}) } })
    const iu = (r.data?.["issueUpdate"] as { success: boolean; issue: any } | undefined)
    if (!iu?.success || !iu.issue) throw new IntegrationError("LINEAR_UPDATE_FAILED", "linear issueUpdate failed", "permanent_validation", 422)
    return { result: this.mapIssue(iu.issue), created: true, operationId }
  }

  async addComment(credential: ResolvedCredential, issueId: string, body: string, operationId: string): Promise<PmMutationResult<{ readonly id: string }>> {
    const r = await this.gql(credential, `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }`, { input: { issueId, body } })
    const cc = (r.data?.["commentCreate"] as { success: boolean; comment: { id: string } } | undefined)
    if (!cc?.success || !cc.comment) throw new IntegrationError("LINEAR_COMMENT_FAILED", "linear commentCreate failed", "permanent_validation", 422)
    return { result: { id: cc.comment.id }, created: true, operationId }
  }

  async listLabels(credential: ResolvedCredential, _teamId?: string): Promise<readonly { readonly id: string; readonly name: string }[]> {
    const r = await this.gql(credential, `query { issueLabels { nodes { id name } } }`)
    const nodes = ((r.data?.["issueLabels"] as { nodes: any[] } | undefined)?.nodes) ?? []
    return nodes.map((l) => ({ id: l.id, name: l.name }))
  }

  mutationIdentity(credential: ResolvedCredential, operationId: string): ExternalMutation {
    return { tenantId: credential.tenantId, connectionId: credential.connectionId, operationId }
  }

  async verifyWebhook(raw: RawWebhook, options: { secret: string }): Promise<WebhookVerifyResult> {
    // Linear signs with HMAC over the raw body, header "Linear-Signature" or
    // "lin_..." — accept the standard HMAC SHA256 form.
    const sig = raw.headers["linear-signature"] ?? raw.headers["x-linear-signature"]
    if (!verifyHmacSha256(raw.rawBody, sig, options.secret)) {
      return { verified: false, reason: "invalid signature", event: null }
    }
    return { verified: true, reason: null, event: this.normalizeEvent(raw) }
  }

  normalizeEvent(raw: RawWebhook): Omit<NormalizedEvent, "eventId" | "tenantId" | "orgId" | "projectId" | "receivedAt"> | null {
    let parsed: any
    try { parsed = JSON.parse(raw.rawBody) } catch { return null }
    const type = parsed.type ?? parsed.event ?? null
    if (!type) return null
    const action = parsed.action ?? null
    const data = parsed.data ?? parsed.payload ?? {}
    const team = data.team?.key ?? null
    const identifier = data.identifier ?? data.id ?? null
    return {
      provider: this.eventProvider,
      providerEventId: `${type}:${identifier ?? "unknown"}`,
      kind: type === "Issue" ? (action === "create" ? "issue.opened" : action === "update" ? "issue.updated" : action === "remove" ? "issue.closed" : "issue.updated") : "custom",
      resource: identifier ? `linear:${identifier}` : `linear:${type}`,
      action,
      actor: parsed.user ? { externalId: String(parsed.user.id ?? parsed.user.name ?? ""), displayName: parsed.user.name ?? null } : null,
      payload: { type, action, identifier, team, title: data.title },
      providerTimestamp: data.updatedAt ?? data.updated_at ?? null,
    }
  }

  private mapIssue(i: any): PmIssue {
    return {
      id: i.id, identifier: i.identifier ?? null, title: i.title, state: i.state?.name ?? "", stateType: i.state?.type ?? "unstarted",
      priority: i.priority ?? null, url: i.url ?? null, description: i.description ?? null,
      labels: ((i.labels?.nodes ?? []) as any[]).map((l) => l.name),
    }
  }
}
