/**
 * CredentialResolver (Phase 2C).
 *
 * The single boundary where a usable secret crosses into an adapter. Given a
 * tenant + connectionId, the resolver:
 *  - loads the durable connection metadata (tenant-scoped),
 *  - enforces lifecycle (active + not expired; revoked/disconnected/expired
 *    resolve to null),
 *  - dereferences the opaque secretRef through the configured SecretProvider,
 *  - stamps last-used (best-effort, never an authorization source),
 *  - returns a {@link ResolvedCredential} carrying the secretRef + usable
 *    secret value for the adapter to consume transiently.
 *
 * The resolver NEVER logs the secret, NEVER puts it in audit/events/errors.
 * Adapters are expected to use the secret only for the duration of the call
 * and never persist it.
 *
 * Expiry is enforced authoritatively at resolve time (the connection STATE
 * gates access), not via the advisory lastUsedAt timestamp.
 */

import type { SqlCredentialStore } from "./store"
import type { SecretProvider } from "./secret-provider"
import { type ResolvedCredential, CredentialError } from "./contracts"

export interface CredentialResolverOptions {
  readonly store: SqlCredentialStore
  readonly secrets: SecretProvider
  /** Clock for expiry checks (tests). */
  readonly now?: () => number
}

export class CredentialResolver {
  constructor(private readonly options: CredentialResolverOptions) {}

  /**
   * Resolve a connection to a usable credential. Returns null if the
   * connection does not exist, is revoked/disconnected/expired, or the secret
   * is gone (so the caller treats it as unresolved, never as an auth error
   * that leaks existence).
   */
  async resolve(tenantId: string, connectionId: string): Promise<ResolvedCredential | null> {
    const now = (this.options.now ?? Date.now)()
    const conn = await this.options.store.get(tenantId, connectionId)
    if (!conn) return null
    if (conn.tenantId !== tenantId) return null
    if (conn.state !== "active") return null
    if (conn.expiresAt !== null && conn.expiresAt <= now) {
      // Expired while active: park as expired (idempotent), do not resolve.
      await this.options.store.markExpired(tenantId, connectionId).catch(() => {})
      return null
    }
    const secret = await this.options.secrets.resolve(conn.secretRef)
    if (secret === null) return null
    // Best-effort last-used; never blocks, never an authorization source.
    void this.options.store.touchLastUsed(tenantId, connectionId).catch(() => {})
    return {
      connectionId: conn.connectionId,
      tenantId: conn.tenantId,
      orgId: conn.orgId,
      projectId: conn.projectId,
      family: conn.family,
      provider: conn.provider,
      secretRef: conn.secretRef,
      account: conn.account,
      capabilities: conn.capabilities,
      secretFingerprint: conn.secretFingerprint,
      secret,
    }
  }

  /** Resolve and assert a capability is granted; throws if missing. */
  async resolveFor(
    tenantId: string,
    connectionId: string,
    capability: ResolvedCredential["capabilities"][number],
  ): Promise<ResolvedCredential> {
    const cred = await this.resolve(tenantId, connectionId)
    if (!cred) throw new CredentialError("CONNECTION_UNRESOLVED", "connection could not be resolved (missing, revoked, expired, or secret gone)", 401)
    if (!cred.capabilities.includes(capability)) {
      throw new CredentialError("CAPABILITY_NOT_GRANTED", `connection does not grant capability "${capability}"`, 403)
    }
    return cred
  }
}
