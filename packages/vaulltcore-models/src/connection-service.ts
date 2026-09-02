/**
 * Model connection activation service (Phase 2D).
 *
 * Finishes the deferred BYOK product path. A tenant/project registers a model
 * connection (family "model"), securely provides the credential through the
 * existing secret boundary, verifies connectivity WITHOUT leaking the secret,
 * and activates/deactivates/revokes the connection. Model restrictions
 * (allowedProviders/models, maxInput/outputTokens) are enforced by the
 * {@link ModelRegistry} at resolve time.
 *
 * The verify step performs a bounded, explicit connectivity probe (a minimal
 * one-token request) — NOT automatic model discovery that would make
 * uncontrolled provider calls. The secret crosses the resolver boundary only,
 * transitly, for the probe; it is never logged/returned/audited.
 *
 * Model selection continues through:
 *   ModelRegistry → CredentialResolver → ModelProviderAdapter → existing
 *   AgentEngine/ModelProvider seam. No second LLM abstraction.
 */

import type { CredentialResolver, SqlCredentialStore, ProviderConnection } from "@vaulltcore/credentials"
import { CredentialError } from "@vaulltcore/credentials"
import type { ModelRegistry } from "./registry"
import type { ModelDescriptor, ModelRestrictions, ResolvedModel } from "./contracts"
import type { SqlAuditStore } from "@vaulltcore/audit"
import { sanitizeMetadata } from "@vaulltcore/audit"

export interface ModelConnectionServiceOptions {
  readonly connections: SqlCredentialStore
  readonly resolver: CredentialResolver
  readonly registry: ModelRegistry
  readonly audit?: SqlAuditStore
}

/** Safe metadata for a model connection (no secret). */
export interface ModelConnectionView {
  readonly connectionId: string
  readonly tenantId: string
  readonly orgId: string
  readonly projectId: string
  readonly provider: string
  readonly state: string
  readonly version: number
  readonly lastUsedAt: number | null
  readonly expiresAt: number | null
  /** Available descriptors for this provider (registry catalog; no secrets). */
  readonly descriptors: readonly ModelDescriptor[]
}

export interface RegisterModelConnectionInput {
  readonly tenantId: string
  readonly orgId: string
  readonly projectId: string
  readonly principalId: string
  readonly provider: string
  readonly accountExternalId: string
  readonly accountDisplayName: string | null
  /** Opaque secret ref + fingerprint (caller routed the API key through the
   *  SecretProvider). The raw key never enters this service. */
  readonly secretRef: string
  readonly secretFingerprint: string
  readonly expiresAt?: number | null
}

export interface VerifyConnectivityResult {
  readonly ok: boolean
  readonly reason: string | null
  /** Descriptors the registry exposes for this provider (no secrets). */
  readonly descriptors: readonly ModelDescriptor[]
}

export class ModelConnectionService {
  private readonly connections: SqlCredentialStore
  private readonly resolver: CredentialResolver
  private readonly registry: ModelRegistry
  private readonly audit?: SqlAuditStore

  constructor(options: ModelConnectionServiceOptions) {
    this.connections = options.connections
    this.resolver = options.resolver
    this.registry = options.registry
    this.audit = options.audit
  }

  /** Register a model connection (created active). The raw API key is routed
   *  through the SecretProvider by the caller; only the opaque ref + fingerprint
   *  persist. */
  async register(input: RegisterModelConnectionInput): Promise<ProviderConnection> {
    const conn = await this.connections.create({
      tenantId: input.tenantId,
      orgId: input.orgId,
      projectId: input.projectId,
      family: "model",
      provider: input.provider,
      account: { externalId: input.accountExternalId, displayName: input.accountDisplayName, scopes: [] },
      capabilities: ["model:stream"],
      secretRef: input.secretRef,
      secretFingerprint: input.secretFingerprint,
      ...(input.expiresAt !== null && input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    })
    await this.auditAppend(input.tenantId, input.orgId, input.projectId, "model_connection_activated", { provider: input.provider, connectionId: conn.connectionId })
    return conn
  }

  /**
   * Verify a model connection's connectivity WITHOUT leaking the secret.
   * Performs a bounded, explicit probe: resolve the credential (transient),
   * resolve a registered model adapter for the provider, and issue a minimal
   * one-token request. Never performs uncontrolled model discovery.
   */
  async verifyConnectivity(args: { tenantId: string; orgId: string; projectId: string; connectionId: string; provider: string; model: string }): Promise<VerifyConnectivityResult> {
    let resolved: ResolvedModel
    try {
      resolved = await this.registry.resolve({
        tenantId: args.tenantId, orgId: args.orgId, projectId: args.projectId,
        connectionId: args.connectionId, provider: args.provider, model: args.model,
      })
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "model not resolvable", descriptors: this.descriptorsFor(args.provider) }
    }
    // Bounded probe: a minimal one-token request. Abort after a short window.
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)
    try {
      let sawText = false
      let errored: string | null = null
      for await (const ev of resolved.adapter.stream({
        model: args.model,
        messages: [{ role: "user", content: "ping" }],
        maxTokens: 1,
      }, controller.signal)) {
        if (ev.type === "text-delta") sawText = true
        if (ev.type === "error") errored = ev.error.message
        if (ev.type === "finish" || ev.type === "error") break
      }
      if (errored) return { ok: false, reason: errored, descriptors: this.descriptorsFor(args.provider) }
      return { ok: true, reason: null, descriptors: this.descriptorsFor(args.provider) }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "probe failed", descriptors: this.descriptorsFor(args.provider) }
    } finally {
      clearTimeout(timeout)
    }
  }

  /** Deactivate (disable resolution) a model connection. Fenced by version. */
  async deactivate(tenantId: string, connectionId: string): Promise<ProviderConnection> {
    const conn = await this.connections.get(tenantId, connectionId)
    if (!conn) throw new CredentialError("CONNECTION_NOT_FOUND", "connection not found", 404)
    // active → degraded (a deactivated model connection cannot resolve).
    const updated = await this.connections.markDegraded(tenantId, connectionId, conn.version)
    await this.auditAppend(tenantId, conn.orgId, conn.projectId, "model_connection_deactivated", { provider: conn.provider, connectionId })
    return updated
  }

  /** Revoke a model connection (terminal). Fenced by version. */
  async revoke(tenantId: string, connectionId: string): Promise<ProviderConnection> {
    const conn = await this.connections.get(tenantId, connectionId)
    if (!conn) throw new CredentialError("CONNECTION_NOT_FOUND", "connection not found", 404)
    const updated = await this.connections.revoke(tenantId, connectionId, conn.version)
    await this.auditAppend(tenantId, conn.orgId, conn.projectId, "connection_revoked", { provider: conn.provider, connectionId })
    return updated
  }

  /** Reactivate a degraded model connection after re-verification. */
  async activate(tenantId: string, connectionId: string): Promise<ProviderConnection> {
    const conn = await this.connections.get(tenantId, connectionId)
    if (!conn) throw new CredentialError("CONNECTION_NOT_FOUND", "connection not found", 404)
    const updated = await this.connections.activate(tenantId, connectionId, conn.version)
    await this.auditAppend(tenantId, conn.orgId, conn.projectId, "model_connection_activated", { provider: conn.provider, connectionId })
    return updated
  }

  /** Set tenant model restrictions (enforced by the registry at resolve). */
  setRestrictions(tenantId: string, restrictions: ModelRestrictions): void {
    this.registry.setRestrictions(tenantId, restrictions)
  }

  /** Inspect safe model connection metadata + health (no secret). */
  async inspect(tenantId: string, connectionId: string): Promise<ModelConnectionView | null> {
    const conn = await this.connections.get(tenantId, connectionId)
    if (!conn) return null
    return {
      connectionId: conn.connectionId,
      tenantId: conn.tenantId,
      orgId: conn.orgId,
      projectId: conn.projectId,
      provider: conn.provider,
      state: conn.state,
      version: conn.version,
      lastUsedAt: conn.lastUsedAt,
      expiresAt: conn.expiresAt,
      descriptors: this.descriptorsFor(conn.provider),
    }
  }

  private descriptorsFor(provider: string): ModelDescriptor[] {
    return this.registry.listDescriptors().filter((d: ModelDescriptor) => d.provider === provider)
  }

  private async auditAppend(tenantId: string, orgId: string, projectId: string, type: string, metadata: Record<string, unknown>): Promise<void> {
    await this.audit?.append({
      actor: { principalId: "model-connection", kind: "service_account", tenantId },
      scope: { tenantId, orgId, projectId },
      type: type as never,
      metadata: sanitizeMetadata(metadata),
    }).catch(() => {})
  }
}
