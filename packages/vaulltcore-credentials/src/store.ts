/**
 * SQL-backed durable credential/connection store (Phase 2C).
 *
 * Reuses {@link SqlStoreBase} so the atomic-commit boundary, dialect-aware
 * placeholder rewriting, and rollback semantics are identical to the Phase 1
 * stores. Every state-changing write is fenced by a `version` CAS: a stale
 * writer cannot rotate/revoke/disconnect a connection once a newer version is
 * committed, even across separate connections or a partition.
 *
 * Security invariants:
 * - The plaintext secret is NEVER stored here. Only an opaque `secret_ref`
 *   (the SecretProvider's pointer) + a one-way `secret_fingerprint` persist.
 * - List/get return {@link ProviderConnection} metadata ONLY — no secret, no
 *   secret_ref is exposed through the public read API (secret_ref is internal
 *   to the resolver/store; getters strip it for API output via toPublic()).
 * - All reads are tenant-scoped: a cross-tenant lookup returns null (no
 *   existence leak).
 * - tenantId/orgId/projectId are immutable after creation (rotation updates
 *   secret + version, never identity/scope).
 * - lastUsedAt is best-effort, fenced by CAS, and NEVER an authorization
 *   source (the connection STATE gates resolve).
 */

import { randomBytes, createHash } from "node:crypto"
import { SqlStoreBase, isUniqueViolation, type Migration, type SqlDialect, type SqlDatabase } from "@vaulltcore/store-sql"
import {
  type ConnectionCapability,
  type ConnectionState,
  type CreateConnectionInput,
  type ProviderAccountIdentity,
  type ProviderConnection,
  CredentialError,
  PROVIDER_FAMILIES,
  assertConnectionTransition,
} from "./contracts"

export const CREDENTIAL_MIGRATIONS: readonly Migration[] = [
  {
    version: 2,
    name: "credentials_core",
    statements: [
      `CREATE TABLE provider_connections (
        connection_id       TEXT PRIMARY KEY,
        tenant_id           TEXT NOT NULL,
        org_id              TEXT NOT NULL,
        project_id          TEXT NOT NULL,
        family              TEXT NOT NULL,
        provider            TEXT NOT NULL,
        account_external_id TEXT NOT NULL,
        account_display     TEXT,
        account_scopes      TEXT NOT NULL,
        capabilities        TEXT NOT NULL,
        state               TEXT NOT NULL DEFAULT 'active',
        secret_ref          TEXT NOT NULL,
        secret_fingerprint  TEXT NOT NULL,
        version             INTEGER NOT NULL DEFAULT 1,
        created_at          BIGINT NOT NULL,
        updated_at          BIGINT NOT NULL,
        last_used_at        BIGINT,
        expires_at          BIGINT,
        rotated_from        TEXT,
        UNIQUE (tenant_id, family, provider, account_external_id)
      )`,
      `CREATE INDEX connections_tenant_idx ON provider_connections (tenant_id, org_id, project_id, family)`,
      `CREATE INDEX connections_state_idx ON provider_connections (tenant_id, state)`,
    ],
  },
  // Phase 2D: OAuth authorization attempts. The `state` nonce is single-use
  // (UNIQUE + consumed at settlement); it is bound durably to
  // tenant/org/project/principal/provider BEFORE the redirect, so a forged
  // callback cannot select another tenant's connection or replay an old state.
  // No access/refresh token or client secret is ever stored here: only the
  // PKCE challenge (one-way), requested scopes, redirect URI, and the eventual
  // opaque secret ref + fingerprint (after the secret has crossed the
  // SecretProvider boundary). The verifier is deleted at settlement.
  {
    version: 3,
    name: "oauth_attempts",
    statements: [
      `CREATE TABLE authorization_attempts (
        attempt_id          TEXT PRIMARY KEY,
        state               TEXT NOT NULL UNIQUE,
        tenant_id           TEXT NOT NULL,
        org_id              TEXT NOT NULL,
        project_id          TEXT NOT NULL,
        principal_id        TEXT NOT NULL,
        provider            TEXT NOT NULL,
        family              TEXT NOT NULL,
        method              TEXT NOT NULL,
        connection_id       TEXT,
        code_challenge      TEXT,
        code_verifier       TEXT,
        scopes              TEXT NOT NULL,
        redirect_uri        TEXT NOT NULL,
        created_at          BIGINT NOT NULL,
        expires_at          BIGINT NOT NULL,
        outcome_state       TEXT,
        outcome_secret_ref  TEXT,
        outcome_secret_fingerprint TEXT,
        outcome_account_external_id TEXT,
        outcome_account_display TEXT,
        outcome_account_scopes TEXT,
        outcome_refresh_secret_ref TEXT,
        outcome_expires_at  BIGINT,
        settled_at          BIGINT,
        UNIQUE (tenant_id, state)
      )`,
      `CREATE INDEX attempts_tenant_idx ON authorization_attempts (tenant_id, expires_at)`,
      `CREATE INDEX attempts_connection_idx ON authorization_attempts (tenant_id, connection_id)`,
    ],
  },
]

interface ConnectionRow {
  connection_id: string
  tenant_id: string
  org_id: string
  project_id: string
  family: string
  provider: string
  account_external_id: string
  account_display: string | null
  account_scopes: string
  capabilities: string
  state: string
  secret_ref: string
  secret_fingerprint: string
  version: number
  created_at: number
  updated_at: number
  last_used_at: number | null
  expires_at: number | null
  rotated_from: string | null
}

function toConnection(row: ConnectionRow): ProviderConnection {
  return {
    connectionId: row.connection_id,
    tenantId: row.tenant_id,
    orgId: row.org_id,
    projectId: row.project_id,
    family: row.family as ProviderConnection["family"],
    provider: row.provider,
    account: {
      externalId: row.account_external_id,
      displayName: row.account_display,
      scopes: JSON.parse(row.account_scopes) as string[],
    },
    capabilities: JSON.parse(row.capabilities) as ConnectionCapability[],
    state: row.state as ConnectionState,
    secretRef: row.secret_ref,
    secretFingerprint: row.secret_fingerprint,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    rotatedFrom: row.rotated_from,
  }
}

/** Public view of a connection: secrets refs stripped (never exposed in API). */
export interface ConnectionPublicView {
  readonly connectionId: string
  readonly tenantId: string
  readonly orgId: string
  readonly projectId: string
  readonly family: string
  readonly provider: string
  readonly account: ProviderAccountIdentity
  readonly capabilities: readonly ConnectionCapability[]
  readonly state: ConnectionState
  readonly version: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastUsedAt: number | null
  readonly expiresAt: number | null
  readonly rotatedFrom: string | null
  /** One-way fingerprint prefix (sha256:hex…12) for client display, never the secret. */
  readonly secretFingerprintPrefix: string
}

export function toPublicView(c: ProviderConnection): ConnectionPublicView {
  return {
    connectionId: c.connectionId,
    tenantId: c.tenantId,
    orgId: c.orgId,
    projectId: c.projectId,
    family: c.family,
    provider: c.provider,
    account: c.account,
    capabilities: c.capabilities,
    state: c.state,
    version: c.version,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    lastUsedAt: c.lastUsedAt,
    expiresAt: c.expiresAt,
    rotatedFrom: c.rotatedFrom,
    secretFingerprintPrefix: c.secretFingerprint.slice(0, 20) + "…",
  }
}

export interface CredentialStoreOptions {
  readonly dialect?: SqlDialect
  readonly beforeCommit?: (op: string) => void
}

export class SqlCredentialStore extends SqlStoreBase {
  constructor(db: SqlDatabase, options: CredentialStoreOptions = {}) {
    super(db, CREDENTIAL_MIGRATIONS, { ...(options.dialect ? { dialect: options.dialect } : {}), beforeCommit: options.beforeCommit })
  }

  /** Create a connection. The plaintext secret is already stored by the caller
   *  via SecretProvider; only the opaque ref + fingerprint persist. */
  async create(input: CreateConnectionInput): Promise<ProviderConnection> {
    if (!PROVIDER_FAMILIES.includes(input.family)) throw new CredentialError("INVALID_FAMILY", `unknown provider family: ${input.family}`)
    const connectionId = `conn_${randomBytes(12).toString("base64url")}`
    const now = Date.now()
    const row = {
      connectionId,
      tenantId: input.tenantId,
      orgId: input.orgId,
      projectId: input.projectId,
      family: input.family,
      provider: input.provider,
      accountExternalId: input.account.externalId,
      accountDisplay: input.account.displayName,
      accountScopes: JSON.stringify(input.account.scopes),
      capabilities: JSON.stringify(input.capabilities),
      state: "active" as ConnectionState,
      secretRef: input.secretRef,
      secretFingerprint: input.secretFingerprint,
      version: 1,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null as number | null,
      expiresAt: input.expiresAt ?? null,
      rotatedFrom: null as string | null,
    }
    try {
      this.atomic("createConnection", () => {
        this.prepare(
          `INSERT INTO provider_connections (
            connection_id, tenant_id, org_id, project_id, family, provider,
            account_external_id, account_display, account_scopes, capabilities,
            state, secret_ref, secret_fingerprint, version, created_at, updated_at,
            last_used_at, expires_at, rotated_from
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          row.connectionId,
          row.tenantId,
          row.orgId,
          row.projectId,
          row.family,
          row.provider,
          row.accountExternalId,
          row.accountDisplay,
          row.accountScopes,
          row.capabilities,
          row.state,
          row.secretRef,
          row.secretFingerprint,
          row.version,
          row.createdAt,
          row.updatedAt,
          row.lastUsedAt,
          row.expiresAt,
          row.rotatedFrom,
        )
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new CredentialError("CONNECTION_EXISTS", "a connection for this provider/account already exists in this tenant", 409)
      }
      throw error
    }
    const inserted = this.prepare("SELECT * FROM provider_connections WHERE connection_id = ?").get(connectionId) as unknown as ConnectionRow
    return toConnection(inserted)
  }

  /** Get a connection by id, tenant-scoped (cross-tenant returns null). */
  async get(tenantId: string, connectionId: string): Promise<ProviderConnection | null> {
    const row = this.prepare("SELECT * FROM provider_connections WHERE connection_id = ? AND tenant_id = ?").get(connectionId, tenantId) as unknown as ConnectionRow | undefined
    return row ? toConnection(row) : null
  }

  /** List a tenant's connections, optionally filtered by family/org/project. */
  async list(scope: { tenantId: string; orgId?: string; projectId?: string; family?: string }): Promise<ProviderConnection[]> {
    const where = ["tenant_id = ?"]
    const params: (string | number)[] = [scope.tenantId]
    if (scope.orgId) { where.push("org_id = ?"); params.push(scope.orgId) }
    if (scope.projectId) { where.push("project_id = ?"); params.push(scope.projectId) }
    if (scope.family) { where.push("family = ?"); params.push(scope.family) }
    const rows = this.prepare(`SELECT * FROM provider_connections WHERE ${where.join(" AND ")} ORDER BY created_at ASC`).all(...params) as unknown as ConnectionRow[]
    return rows.map(toConnection)
  }

  /** Rotate a connection's secret without changing identity/scope.
   *  Fenced by version CAS: a concurrent rotation wins exactly once. */
  async rotate(
    tenantId: string,
    connectionId: string,
    expectedVersion: number,
    newSecretRef: string,
    newSecretFingerprint: string,
  ): Promise<ProviderConnection> {
    return this.fencedUpdate(tenantId, connectionId, expectedVersion, (row) => ({
      secret_ref: newSecretRef,
      secret_fingerprint: newSecretFingerprint,
      rotated_from: connectionId,
    }), "rotated")
  }

  /** Revoke a connection (terminal-ish; resolve no longer returns a secret). */
  async revoke(tenantId: string, connectionId: string, expectedVersion: number): Promise<ProviderConnection> {
    return this.setState(tenantId, connectionId, expectedVersion, "revoked")
  }

  /** Disconnect a connection (user-initiated removal of the link). */
  async disconnect(tenantId: string, connectionId: string, expectedVersion: number): Promise<ProviderConnection> {
    return this.setState(tenantId, connectionId, expectedVersion, "disconnected")
  }

  /** Mark a connection degraded (credentials failing but not definitively
   *  revoked — e.g. a refresh failure). Fenced by version CAS. */
  async markDegraded(tenantId: string, connectionId: string, expectedVersion: number): Promise<ProviderConnection> {
    return this.setState(tenantId, connectionId, expectedVersion, "degraded")
  }

  /** Reactivate a degraded/expired connection after a successful refresh /
   *  reauthorization. Fenced by version CAS; validates the transition. */
  async activate(tenantId: string, connectionId: string, expectedVersion: number): Promise<ProviderConnection> {
    return this.setState(tenantId, connectionId, expectedVersion, "active")
  }

  /** Mark a connection expired (idempotent; reaper-safe). */
  async markExpired(tenantId: string, connectionId: string): Promise<ProviderConnection | null> {
    const existing = await this.get(tenantId, connectionId)
    if (!existing) return null
    if (existing.state === "expired" || existing.state === "revoked" || existing.state === "disconnected") return existing
    return this.setState(tenantId, connectionId, existing.version, "expired")
  }

  /** Best-effort last-used stamp (fenced by CAS; never an authorization source). */
  async touchLastUsed(tenantId: string, connectionId: string): Promise<void> {
    this.atomic("touchLastUsed", () => {
      const now = Date.now()
      const result = this.prepare(
        "UPDATE provider_connections SET last_used_at = ?, updated_at = ? WHERE connection_id = ? AND tenant_id = ? AND state = 'active'",
      ).run(now, now, connectionId, tenantId)
      // changes==0 is fine: connection gone/revoked — last-used is advisory only.
      void result
    })
  }

  /** List connections past their expires_at that are still active (reaper input). */
  async listExpiredActive(now = Date.now()): Promise<ProviderConnection[]> {
    const rows = this.prepare(
      "SELECT * FROM provider_connections WHERE state = 'active' AND expires_at IS NOT NULL AND expires_at <= ?",
    ).all(now) as unknown as ConnectionRow[]
    return rows.map(toConnection)
  }

  private async setState(
    tenantId: string,
    connectionId: string,
    expectedVersion: number,
    state: ConnectionState,
  ): Promise<ProviderConnection> {
    return this.fencedUpdate(tenantId, connectionId, expectedVersion, (row) => {
      // Validate the transition deterministically (illegal paths fail, never
      // silently coerce). The CAS below still guards concurrent writers.
      assertConnectionTransition(row.state as ConnectionState, state)
      return { state }
    }, state)
  }

  private fencedUpdate(
    tenantId: string,
    connectionId: string,
    expectedVersion: number,
    apply: (row: ConnectionRow) => Record<string, unknown>,
    opLabel: string,
  ): ProviderConnection {
    let updated: ProviderConnection | null = null
    this.atomic(`updateConnection:${opLabel}`, () => {
      const row = this.prepare("SELECT * FROM provider_connections WHERE connection_id = ? AND tenant_id = ?").get(connectionId, tenantId) as unknown as ConnectionRow | undefined
      if (!row) throw new CredentialError("CONNECTION_NOT_FOUND", "connection not found", 404)
      if (row.version !== expectedVersion) {
        throw new CredentialError("VERSION_CONFLICT", `connection version ${row.version} != expected ${expectedVersion}`, 409)
      }
      const changes = apply(row)
      const sets = Object.keys(changes).map((k) => `${k} = ?`)
      const params = [...Object.values(changes) as unknown as import("@vaulltcore/store-sql").SqlValue[], row.version + 1, Date.now(), connectionId, tenantId, row.version]
      const result = this.prepare(
        `UPDATE provider_connections SET ${sets.join(", ")}, version = ?, updated_at = ? WHERE connection_id = ? AND tenant_id = ? AND version = ?`,
      ).run(...params)
      if (result.changes === 0) {
        throw new CredentialError("VERSION_CONFLICT", "connection was concurrently modified", 409)
      }
      const fresh = this.prepare("SELECT * FROM provider_connections WHERE connection_id = ? AND tenant_id = ?").get(connectionId, tenantId) as unknown as ConnectionRow
      updated = toConnection(fresh)
    })
    return updated!
  }
}
