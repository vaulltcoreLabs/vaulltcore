/**
 * Durable B2B identity security store (Phase 2G). Reuses the
 * {@link SqlStoreBase} transaction/dialect seam; every mutation is
 * transaction-safe and all migrations are additive with globally unique names.
 *
 * Persisted authorities (Vaulltcore-owned):
 * - user_identities: the durable bridge from a Better Auth user id to a
 *   Vaulltcore principal, including the disabled lifecycle.
 * - service_identities: machine principals scoped to exactly one tenant+org
 *   with an explicit, bounded permission set.
 * - machine_credentials: credential METADATA only (lookup prefix + SHA-256
 *   fingerprint). Plaintext secrets are never persisted.
 * - session_registry: Vaulltcore's session revocation/audit ledger. Only the
 *   session token fingerprint is stored — never the token.
 *
 * Better Auth's own tables (user/session/account/verification) are owned and
 * migrated by Better Auth itself in its own database; they are NOT duplicated
 * here.
 */

import { createHash, randomBytes } from "node:crypto"
import { SqlStoreBase, isUniqueViolation, type Migration, type SqlDialect } from "@vaulltcore/store-sql"
import {
  AuthError,
  type MachineCredential,
  type Permission,
  type ServiceIdentity,
  type ServiceIdentityStatus,
  type SessionRecord,
  type UserIdentity,
  type UserIdentityStatus,
  isPermission,
} from "./contracts"

export const B2B_AUTH_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "b2b_identity_core",
    statements: [
      `CREATE TABLE user_identities (
        user_id      TEXT PRIMARY KEY,
        display_name TEXT,
        status       TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        disabled_at  INTEGER
      )`,
      `CREATE TABLE service_identities (
        service_identity_id TEXT PRIMARY KEY,
        tenant_id           TEXT NOT NULL,
        org_id              TEXT NOT NULL,
        name                TEXT NOT NULL,
        status              TEXT NOT NULL,
        permissions         TEXT NOT NULL,
        created_by          TEXT,
        created_at          INTEGER NOT NULL,
        disabled_at         INTEGER,
        revoked_at          INTEGER,
        UNIQUE (tenant_id, org_id, name)
      )`,
      `CREATE INDEX service_identities_scope_idx ON service_identities (tenant_id, org_id)`,
      `CREATE TABLE machine_credentials (
        credential_id       TEXT PRIMARY KEY,
        service_identity_id TEXT NOT NULL,
        tenant_id           TEXT NOT NULL,
        org_id              TEXT NOT NULL,
        prefix              TEXT NOT NULL,
        fingerprint         TEXT NOT NULL,
        created_at          INTEGER NOT NULL,
        revoked_at          INTEGER,
        expires_at          INTEGER,
        last_used_at        INTEGER
      )`,
      `CREATE INDEX machine_credentials_identity_idx ON machine_credentials (service_identity_id)`,
      `CREATE TABLE session_registry (
        fingerprint           TEXT PRIMARY KEY,
        user_id               TEXT NOT NULL,
        better_auth_session_id TEXT NOT NULL,
        created_at            INTEGER NOT NULL,
        expires_at            INTEGER NOT NULL,
        revoked_at            INTEGER,
        last_seen_at          INTEGER
      )`,
      `CREATE INDEX session_registry_user_idx ON session_registry (user_id)`,
    ],
  },
]

interface UserIdentityRow {
  user_id: string
  display_name: string | null
  status: string
  created_at: number
  disabled_at: number | null
}
interface ServiceIdentityRow {
  service_identity_id: string
  tenant_id: string
  org_id: string
  name: string
  status: string
  permissions: string
  created_by: string | null
  created_at: number
  disabled_at: number | null
  revoked_at: number | null
}
interface MachineCredentialRow {
  credential_id: string
  service_identity_id: string
  tenant_id: string
  org_id: string
  prefix: string
  fingerprint: string
  created_at: number
  revoked_at: number | null
  expires_at: number | null
  last_used_at: number | null
}
interface SessionRow {
  fingerprint: string
  user_id: string
  better_auth_session_id: string
  created_at: number
  expires_at: number
  revoked_at: number | null
  last_seen_at: number | null
}

function toUserIdentity(row: UserIdentityRow): UserIdentity {
  return {
    userId: row.user_id,
    displayName: row.display_name,
    status: row.status as UserIdentityStatus,
    createdAt: row.created_at,
    disabledAt: row.disabled_at,
  }
}

function toServiceIdentity(row: ServiceIdentityRow): ServiceIdentity {
  return {
    serviceIdentityId: row.service_identity_id,
    tenantId: row.tenant_id,
    orgId: row.org_id,
    name: row.name,
    status: row.status as ServiceIdentityStatus,
    permissions: JSON.parse(row.permissions) as Permission[],
    createdBy: row.created_by,
    createdAt: row.created_at,
    disabledAt: row.disabled_at,
    revokedAt: row.revoked_at,
  }
}

function toMachineCredential(row: MachineCredentialRow): MachineCredential {
  return {
    credentialId: row.credential_id,
    serviceIdentityId: row.service_identity_id,
    tenantId: row.tenant_id,
    orgId: row.org_id,
    prefix: row.prefix,
    fingerprint: row.fingerprint,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
  }
}

function toSessionRecord(row: SessionRow): SessionRecord {
  return {
    fingerprint: row.fingerprint,
    userId: row.user_id,
    betterAuthSessionId: row.better_auth_session_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastSeenAt: row.last_seen_at,
  }
}

/** One-way fingerprint for any secret material (session tokens, machine
 *  credential secrets). Fingerprints are safe to store/audit. */
export function fingerprintSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex")
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`
}

export interface B2bAuthStoreOptions {
  readonly dialect?: SqlDialect
}

export class SqlB2bAuthStore extends SqlStoreBase {
  constructor(db: import("@vaulltcore/store-sql").SqlDatabase, options: B2bAuthStoreOptions = {}) {
    super(db, B2B_AUTH_MIGRATIONS, options.dialect ? { dialect: options.dialect } : {})
  }

  // -------------------------------------------------------------------------
  // User identities
  // -------------------------------------------------------------------------

  /** Idempotent provisioning: the first validated session for a Better Auth
   *  user creates the durable Vaulltcore user identity exactly once. */
  async provisionUserIdentity(userId: string, displayName: string | null): Promise<UserIdentity> {
    const existing = await this.getUserIdentity(userId)
    if (existing) return existing
    try {
      return await this.atomic("provisionUserIdentity", (): UserIdentity => {
        this.prepare("INSERT INTO user_identities (user_id, display_name, status, created_at, disabled_at) VALUES (?, ?, 'active', ?, NULL)")
          .run(userId, displayName, Date.now())
        return { userId, displayName, status: "active", createdAt: Date.now(), disabledAt: null }
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        const raced = await this.getUserIdentity(userId)
        if (raced) return raced
      }
      throw error
    }
  }

  async getUserIdentity(userId: string): Promise<UserIdentity | null> {
    const row = this.prepare("SELECT * FROM user_identities WHERE user_id = ?").get(userId) as unknown as UserIdentityRow | undefined
    return row ? toUserIdentity(row) : null
  }

  /** Disable a user. Idempotent: disabling an already-disabled user is a no-op. */
  async disableUserIdentity(userId: string): Promise<UserIdentity> {
    return this.atomic("disableUserIdentity", (): UserIdentity => {
      const row = this.prepare("SELECT * FROM user_identities WHERE user_id = ?").get(userId) as unknown as UserIdentityRow | undefined
      if (!row) throw new AuthError("NOT_FOUND", "user identity not found")
      if (row.status === "disabled") return toUserIdentity(row)
      this.prepare("UPDATE user_identities SET status = 'disabled', disabled_at = ? WHERE user_id = ? AND status = 'active'").run(Date.now(), userId)
      return { ...toUserIdentity(row), status: "disabled", disabledAt: Date.now() }
    })
  }

  // -------------------------------------------------------------------------
  // Service identities
  // -------------------------------------------------------------------------

  async createServiceIdentity(input: {
    tenantId: string
    orgId: string
    name: string
    permissions: readonly Permission[]
    createdBy: string | null
  }): Promise<ServiceIdentity> {
    if (!input.name || input.name.length > 128) throw new AuthError("INVALID_INPUT", "service identity name required (<=128 chars)")
    for (const p of input.permissions) {
      if (!isPermission(p)) throw new AuthError("INVALID_INPUT", `unknown permission "${String(p)}"`)
    }
    const id = newId("svc")
    try {
      return await this.atomic("createServiceIdentity", (): ServiceIdentity => {
        this.prepare(
          "INSERT INTO service_identities (service_identity_id, tenant_id, org_id, name, status, permissions, created_by, created_at, disabled_at, revoked_at) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, NULL, NULL)",
        ).run(id, input.tenantId, input.orgId, input.name, JSON.stringify([...new Set(input.permissions)]), input.createdBy, Date.now())
        return {
          serviceIdentityId: id,
          tenantId: input.tenantId,
          orgId: input.orgId,
          name: input.name,
          status: "active",
          permissions: [...new Set(input.permissions)],
          createdBy: input.createdBy,
          createdAt: Date.now(),
          disabledAt: null,
          revokedAt: null,
        }
      })
    } catch (error) {
      if (isUniqueViolation(error)) throw new AuthError("CONFLICT", `service identity "${input.name}" already exists in this organization`)
      throw error
    }
  }

  async getServiceIdentity(tenantId: string, orgId: string, serviceIdentityId: string): Promise<ServiceIdentity | null> {
    const row = this.prepare("SELECT * FROM service_identities WHERE service_identity_id = ?").get(serviceIdentityId) as unknown as ServiceIdentityRow | undefined
    if (!row) return null
    const identity = toServiceIdentity(row)
    // Cross-tenant isolation: never disclose another tenant's identity.
    if (identity.tenantId !== tenantId || identity.orgId !== orgId) return null
    return identity
  }

  async listServiceIdentities(tenantId: string, orgId: string): Promise<ServiceIdentity[]> {
    const rows = this.prepare("SELECT * FROM service_identities WHERE tenant_id = ? AND org_id = ? ORDER BY created_at ASC").all(tenantId, orgId) as unknown as ServiceIdentityRow[]
    return rows.map(toServiceIdentity)
  }

  /** Fenced lifecycle transition: only the expected current status may move. */
  private async transitionServiceIdentity(
    serviceIdentityId: string,
    from: ServiceIdentityStatus,
    to: ServiceIdentityStatus,
    column: "disabled_at" | "revoked_at",
  ): Promise<ServiceIdentity> {
    return this.atomic("transitionServiceIdentity", (): ServiceIdentity => {
      const row = this.prepare("SELECT * FROM service_identities WHERE service_identity_id = ?").get(serviceIdentityId) as unknown as ServiceIdentityRow | undefined
      if (!row) throw new AuthError("NOT_FOUND", "service identity not found")
      const current = toServiceIdentity(row)
      if (current.status === to) return current
      if (current.status !== from) throw new AuthError("CONFLICT", `cannot move service identity from "${current.status}" to "${to}"`)
      const changes = this.prepare(`UPDATE service_identities SET status = ?, ${column} = ? WHERE service_identity_id = ? AND status = ?`).run(to, Date.now(), serviceIdentityId, from).changes
      if (changes !== 1) throw new AuthError("CONFLICT", "service identity transition lost a race")
      return { ...current, status: to, [column === "disabled_at" ? "disabledAt" : "revokedAt"]: Date.now() }
    })
  }

  async disableServiceIdentity(serviceIdentityId: string): Promise<ServiceIdentity> {
    return this.transitionServiceIdentity(serviceIdentityId, "active", "disabled", "disabled_at")
  }

  /** Re-enable a disabled identity (revoked is terminal). */
  async enableServiceIdentity(serviceIdentityId: string): Promise<ServiceIdentity> {
    return this.atomic("enableServiceIdentity", (): ServiceIdentity => {
      const row = this.prepare("SELECT * FROM service_identities WHERE service_identity_id = ?").get(serviceIdentityId) as unknown as ServiceIdentityRow | undefined
      if (!row) throw new AuthError("NOT_FOUND", "service identity not found")
      const current = toServiceIdentity(row)
      if (current.status === "active") return current
      if (current.status !== "disabled") throw new AuthError("CONFLICT", `cannot enable a "${current.status}" service identity`)
      this.prepare("UPDATE service_identities SET status = 'active', disabled_at = NULL WHERE service_identity_id = ? AND status = 'disabled'").run(serviceIdentityId)
      return { ...current, status: "active", disabledAt: null }
    })
  }

  /** Revocation is terminal: a revoked identity can never authenticate again. */
  async revokeServiceIdentity(serviceIdentityId: string): Promise<ServiceIdentity> {
    return this.atomic("revokeServiceIdentity", (): ServiceIdentity => {
      const row = this.prepare("SELECT * FROM service_identities WHERE service_identity_id = ?").get(serviceIdentityId) as unknown as ServiceIdentityRow | undefined
      if (!row) throw new AuthError("NOT_FOUND", "service identity not found")
      const current = toServiceIdentity(row)
      if (current.status === "revoked") return current
      const changes = this.prepare("UPDATE service_identities SET status = 'revoked', revoked_at = ? WHERE service_identity_id = ? AND status != 'revoked'").run(Date.now(), serviceIdentityId).changes
      if (changes !== 1) throw new AuthError("CONFLICT", "service identity revocation lost a race")
      // Revoke all live credentials of the identity in the same transaction.
      this.prepare("UPDATE machine_credentials SET revoked_at = ? WHERE service_identity_id = ? AND revoked_at IS NULL").run(Date.now(), serviceIdentityId)
      return { ...current, status: "revoked", revokedAt: Date.now() }
    })
  }

  // -------------------------------------------------------------------------
  // Machine credentials (metadata only — never plaintext)
  // -------------------------------------------------------------------------

  async recordMachineCredential(input: {
    credentialId: string
    serviceIdentityId: string
    tenantId: string
    orgId: string
    prefix: string
    fingerprint: string
    expiresAt: number | null
  }): Promise<MachineCredential> {
    const id = input.credentialId
    return this.atomic("recordMachineCredential", (): MachineCredential => {
      this.prepare(
        "INSERT INTO machine_credentials (credential_id, service_identity_id, tenant_id, org_id, prefix, fingerprint, created_at, revoked_at, expires_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)",
      ).run(id, input.serviceIdentityId, input.tenantId, input.orgId, input.prefix, input.fingerprint, Date.now(), input.expiresAt)
      return {
        credentialId: id,
        serviceIdentityId: input.serviceIdentityId,
        tenantId: input.tenantId,
        orgId: input.orgId,
        prefix: input.prefix,
        fingerprint: input.fingerprint,
        createdAt: Date.now(),
        revokedAt: null,
        expiresAt: input.expiresAt,
        lastUsedAt: null,
      }
    })
  }

  async getMachineCredential(credentialId: string): Promise<MachineCredential | null> {
    const row = this.prepare("SELECT * FROM machine_credentials WHERE credential_id = ?").get(credentialId) as unknown as MachineCredentialRow | undefined
    return row ? toMachineCredential(row) : null
  }

  async listMachineCredentials(tenantId: string, orgId: string, serviceIdentityId: string): Promise<MachineCredential[]> {
    const rows = this.prepare("SELECT * FROM machine_credentials WHERE tenant_id = ? AND org_id = ? AND service_identity_id = ? ORDER BY created_at ASC")
      .all(tenantId, orgId, serviceIdentityId) as unknown as MachineCredentialRow[]
    return rows.map(toMachineCredential)
  }

  async revokeMachineCredential(credentialId: string): Promise<MachineCredential> {
    return this.atomic("revokeMachineCredential", (): MachineCredential => {
      const row = this.prepare("SELECT * FROM machine_credentials WHERE credential_id = ?").get(credentialId) as unknown as MachineCredentialRow | undefined
      if (!row) throw new AuthError("NOT_FOUND", "machine credential not found")
      const current = toMachineCredential(row)
      if (current.revokedAt !== null) return current
      this.prepare("UPDATE machine_credentials SET revoked_at = ? WHERE credential_id = ? AND revoked_at IS NULL").run(Date.now(), credentialId)
      return { ...current, revokedAt: Date.now() }
    })
  }

  /** Best-effort last-used touch. Metadata only — never an authz input. */
  async touchMachineCredential(credentialId: string): Promise<void> {
    await this.atomic("touchMachineCredential", () =>
      this.prepare("UPDATE machine_credentials SET last_used_at = ? WHERE credential_id = ?").run(Date.now(), credentialId),
    )
  }

  // -------------------------------------------------------------------------
  // Session registry (revocation + audit ledger; fingerprints only)
  // -------------------------------------------------------------------------

  async registerSession(input: { fingerprint: string; userId: string; betterAuthSessionId: string; expiresAt: number }): Promise<SessionRecord> {
    const existing = await this.getSession(input.fingerprint)
    if (existing) return existing
    try {
      return await this.atomic("registerSession", (): SessionRecord => {
        this.prepare(
          "INSERT INTO session_registry (fingerprint, user_id, better_auth_session_id, created_at, expires_at, revoked_at, last_seen_at) VALUES (?, ?, ?, ?, ?, NULL, NULL)",
        ).run(input.fingerprint, input.userId, input.betterAuthSessionId, Date.now(), input.expiresAt)
        return { fingerprint: input.fingerprint, userId: input.userId, betterAuthSessionId: input.betterAuthSessionId, createdAt: Date.now(), expiresAt: input.expiresAt, revokedAt: null, lastSeenAt: null }
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        const raced = await this.getSession(input.fingerprint)
        if (raced) return raced
      }
      throw error
    }
  }

  async getSession(fingerprint: string): Promise<SessionRecord | null> {
    const row = this.prepare("SELECT * FROM session_registry WHERE fingerprint = ?").get(fingerprint) as unknown as SessionRow | undefined
    return row ? toSessionRecord(row) : null
  }

  async listSessionsForUser(userId: string): Promise<SessionRecord[]> {
    const rows = this.prepare("SELECT * FROM session_registry WHERE user_id = ? ORDER BY created_at ASC").all(userId) as unknown as SessionRow[]
    return rows.map(toSessionRecord)
  }

  /** Revoke one session. Idempotent. */
  async revokeSession(fingerprint: string): Promise<SessionRecord | null> {
    return this.atomic("revokeSession", (): SessionRecord | null => {
      const row = this.prepare("SELECT * FROM session_registry WHERE fingerprint = ?").get(fingerprint) as unknown as SessionRow | undefined
      if (!row) return null
      const current = toSessionRecord(row)
      if (current.revokedAt !== null) return current
      this.prepare("UPDATE session_registry SET revoked_at = ? WHERE fingerprint = ? AND revoked_at IS NULL").run(Date.now(), fingerprint)
      return { ...current, revokedAt: Date.now() }
    })
  }

  /** Revoke every live session of a user (used on user disable). Returns count. */
  async revokeAllSessionsForUser(userId: string): Promise<number> {
    return this.atomic("revokeAllSessionsForUser", (): number =>
      this.prepare("UPDATE session_registry SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(Date.now(), userId).changes,
    )
  }

  /** Best-effort last-seen touch. Metadata only — never an authz input. */
  async touchSession(fingerprint: string): Promise<void> {
    await this.atomic("touchSession", () =>
      this.prepare("UPDATE session_registry SET last_seen_at = ? WHERE fingerprint = ?").run(Date.now(), fingerprint),
    )
  }
}
