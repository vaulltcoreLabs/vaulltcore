/**
 * SQL-backed identity store (Phase 1E). Reuses the {@link SqlStoreBase}
 * transaction/dialect seam so every mutation is race-free and rollback-safe.
 *
 * Security invariants:
 * - API keys are stored as a one-way verifier (`secretHash`) plus a lookup
 *   `keyPrefix`/`keyId`. The plaintext secret is returned exactly once at
 *   creation and never persisted or logged.
 * - Verification is constant-ish over rows selected by `keyId` (lookup), not a
 *   full-table scan, and the secret never leaves the verifier.
 * - Revocation sets `revoked_at`; a revoked key can never authenticate again.
 * - All reads are tenant-scoped: there is no list path that returns another
 *   tenant's orgs, projects, members or keys.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import type { JobIdentity } from "@vaulltcore/runner"
import { SqlStoreBase, isUniqueViolation, type Migration, type SqlDialect } from "@vaulltcore/store-sql"
import {
  ADMIN_ROLES,
  type ApiKeyRecord,
  type CreatedApiKey,
  type Organization,
  type OrganizationMember,
  type PrincipalKind,
  type Project,
  type ProjectGrant,
  type ResolvedPrincipal,
  type Role,
  type Tenant,
  IdentityError,
  ROLE_RANK,
} from "./contracts"

export const IDENTITY_MIGRATIONS: readonly Migration[] = [
  {
    version: 2,
    name: "identity_core",
    statements: [
      `CREATE TABLE tenants (
        tenant_id    TEXT PRIMARY KEY,
        created_at   INTEGER NOT NULL,
        created_by   TEXT,
        display_name TEXT
      )`,
      `CREATE TABLE organizations (
        org_id       TEXT PRIMARY KEY,
        tenant_id     TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        display_name  TEXT,
        UNIQUE (tenant_id, org_id)
      )`,
      `CREATE INDEX organizations_tenant_idx ON organizations (tenant_id)`,
      `CREATE TABLE org_members (
        tenant_id    TEXT NOT NULL,
        org_id       TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        role         TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, org_id, principal_id)
      )`,
      `CREATE TABLE projects (
        project_id   TEXT PRIMARY KEY,
        tenant_id     TEXT NOT NULL,
        org_id       TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        display_name  TEXT,
        UNIQUE (tenant_id, org_id, project_id)
      )`,
      `CREATE INDEX projects_tenant_idx ON projects (tenant_id, org_id)`,
      `CREATE TABLE project_grants (
        tenant_id    TEXT NOT NULL,
        org_id       TEXT NOT NULL,
        project_id   TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        role         TEXT NOT NULL,
        PRIMARY KEY (tenant_id, org_id, project_id, principal_id)
      )`,
      `CREATE TABLE principals (
        principal_id TEXT PRIMARY KEY,
        tenant_id    TEXT NOT NULL,
        kind         TEXT NOT NULL,
        created_at   INTEGER NOT NULL
      )`,
      `CREATE TABLE api_keys (
        key_id       TEXT PRIMARY KEY,
        tenant_id    TEXT NOT NULL,
        org_id       TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        name         TEXT NOT NULL,
        key_prefix   TEXT NOT NULL,
        secret_hash  TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        revoked_at   INTEGER,
        last_used_at INTEGER
      )`,
      `CREATE INDEX api_keys_lookup_idx ON api_keys (key_id, revoked_at)`,
      `CREATE INDEX api_keys_org_idx ON api_keys (tenant_id, org_id)`,
    ],
  },
  {
    // Phase 1F: API key operational lifecycle. Adds expiry, scope restrictions,
    // rotation linkage, and an overlap window. Expiry (`expires_at`) is checked
    // at authentication (an expired key is rejected exactly like a revoked key).
    // `scope` is a JSON array of allowed project ids (NULL = all projects the
    // principal is granted within the org). `rotated_from` links a replacement
    // key to the key it supersedes; `overlap_expires_at` bounds the controlled
    // overlap period during rotation. Authorization always uses authoritative
    // key state (revoked/expires/scope), never cached `last_used_at`.
    version: 12,
    name: "api_key_lifecycle",
    statements: [
      `ALTER TABLE api_keys ADD COLUMN expires_at INTEGER`,
      `ALTER TABLE api_keys ADD COLUMN scope TEXT`,
      `ALTER TABLE api_keys ADD COLUMN rotated_from TEXT`,
      `ALTER TABLE api_keys ADD COLUMN overlap_expires_at INTEGER`,
      `CREATE INDEX api_keys_rotated_from_idx ON api_keys (rotated_from)`,
    ],
  },
]

interface TenantRow {
  tenant_id: string
  created_at: number
  created_by: string | null
  display_name: string | null
}
interface OrgRow {
  org_id: string
  tenant_id: string
  created_at: number
  display_name: string | null
}
interface MemberRow {
  tenant_id: string
  org_id: string
  principal_id: string
  role: string
  created_at: number
}
interface ProjectRow {
  project_id: string
  tenant_id: string
  org_id: string
  created_at: number
  display_name: string | null
}
interface GrantRow {
  tenant_id: string
  org_id: string
  project_id: string
  principal_id: string
  role: string
}
interface PrincipalRow {
  principal_id: string
  tenant_id: string
  kind: string
  created_at: number
}
interface ApiKeyRow {
  key_id: string
  tenant_id: string
  org_id: string
  principal_id: string
  name: string
  key_prefix: string
  secret_hash: string
  created_at: number
  revoked_at: number | null
  last_used_at: number | null
  expires_at: number | null
  scope: string | null
  rotated_from: string | null
  overlap_expires_at: number | null
}

function toApiKeyRecord(row: ApiKeyRow): ApiKeyRecord {
  return {
    keyId: row.key_id,
    tenantId: row.tenant_id,
    orgId: row.org_id,
    principalId: row.principal_id,
    name: row.name,
    keyPrefix: row.key_prefix,
    secretHash: row.secret_hash,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    scope: row.scope ? (JSON.parse(row.scope) as string[]) : null,
    rotatedFrom: row.rotated_from,
    overlapExpiresAt: row.overlap_expires_at,
  }
}

function id(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`
}

/** One-way verifier for an API key secret. */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex")
}

/** Verify a candidate secret against a stored verifier in constant time. */
export function verifySecret(candidate: string, hash: string): boolean {
  const candidateHash = hashSecret(candidate)
  const a = Buffer.from(candidateHash)
  const b = Buffer.from(hash)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Parse an API key secret into its lookup keyId and secret body.
 *
 * The secret format is `<keyId>.<body>`, using `.` as the separator because
 * `.` never appears in base64url output (unlike `_`, which both the keyId and
 * the body can contain). Splitting on the FIRST `.` is therefore unambiguous
 * regardless of the random bytes in either component. */
export function parseSecret(secret: string): { keyId: string; body: string } | null {
  const sep = secret.indexOf(".")
  if (sep < 0) return null
  const keyId = secret.slice(0, sep)
  const body = secret.slice(sep + 1)
  if (!keyId || !body) return null
  return { keyId, body }
}

export interface IdentityStoreOptions {
  readonly dialect?: SqlDialect
  readonly beforeCommit?: (op: string) => void
}

export class SqlIdentityStore extends SqlStoreBase {
  constructor(db: import("@vaulltcore/store-sql").SqlDatabase, options: IdentityStoreOptions = {}) {
    super(db, IDENTITY_MIGRATIONS, { ...(options.dialect ? { dialect: options.dialect } : {}), beforeCommit: options.beforeCommit })
  }

  // -------------------------------------------------------------------------
  // Tenants
  // -------------------------------------------------------------------------
  async createTenant(tenantId: string, createdBy: string | null = null, displayName: string | null = null): Promise<Tenant> {
    const now = Date.now()
    this.atomic("createTenant", () => {
      try {
        this.prepare("INSERT INTO tenants (tenant_id, created_at, created_by, display_name) VALUES (?, ?, ?, ?)").run(tenantId, now, createdBy, displayName)
      } catch (error) {
        if (isUniqueViolation(error)) throw new IdentityError("TENANT_EXISTS", `Tenant ${tenantId} already exists`)
        throw error
      }
    })
    return { tenantId, createdAt: now, createdBy, displayName }
  }

  async getTenant(tenantId: string): Promise<Tenant | null> {
    const row = this.prepare("SELECT * FROM tenants WHERE tenant_id = ?").get(tenantId) as unknown as TenantRow | undefined
    return row ? { tenantId: row.tenant_id, createdAt: row.created_at, createdBy: row.created_by, displayName: row.display_name } : null
  }

  // -------------------------------------------------------------------------
  // Organizations
  // -------------------------------------------------------------------------
  async createOrganization(tenantId: string, orgId: string, displayName: string | null = null): Promise<Organization> {
    if (!(await this.getTenant(tenantId))) throw new IdentityError("TENANT_NOT_FOUND", `Tenant ${tenantId} not found`)
    const now = Date.now()
    this.atomic("createOrganization", () => {
      try {
        this.prepare("INSERT INTO organizations (org_id, tenant_id, created_at, display_name) VALUES (?, ?, ?, ?)").run(orgId, tenantId, now, displayName)
      } catch (error) {
        if (isUniqueViolation(error)) throw new IdentityError("ORG_EXISTS", `Organization ${orgId} already exists`)
        throw error
      }
    })
    return { orgId, tenantId, createdAt: now, displayName }
  }

  async getOrganization(tenantId: string, orgId: string): Promise<Organization | null> {
    const row = this.prepare("SELECT * FROM organizations WHERE tenant_id = ? AND org_id = ?").get(tenantId, orgId) as unknown as OrgRow | undefined
    return row ? { orgId: row.org_id, tenantId: row.tenant_id, createdAt: row.created_at, displayName: row.display_name } : null
  }

  async listOrganizations(tenantId: string): Promise<Organization[]> {
    const rows = this.prepare("SELECT * FROM organizations WHERE tenant_id = ? ORDER BY created_at ASC").all(tenantId) as unknown as OrgRow[]
    return rows.map((row) => ({ orgId: row.org_id, tenantId: row.tenant_id, createdAt: row.created_at, displayName: row.display_name }))
  }

  // -------------------------------------------------------------------------
  // Members + grants
  // -------------------------------------------------------------------------
  async addMember(tenantId: string, orgId: string, principalId: string, role: Role): Promise<OrganizationMember> {
    if (!(await this.getOrganization(tenantId, orgId))) throw new IdentityError("ORG_NOT_FOUND", `Organization ${orgId} not found in tenant ${tenantId}`)
    const now = Date.now()
    this.atomic("addMember", () => {
      try {
        this.prepare("INSERT INTO org_members (tenant_id, org_id, principal_id, role, created_at) VALUES (?, ?, ?, ?, ?)").run(tenantId, orgId, principalId, role, now)
      } catch (error) {
        if (isUniqueViolation(error)) throw new IdentityError("MEMBER_EXISTS", `Principal ${principalId} is already a member of ${orgId}`)
        throw error
      }
    })
    return { tenantId, orgId, principalId, role, createdAt: now }
  }

  async setMemberRole(tenantId: string, orgId: string, principalId: string, role: Role): Promise<void> {
    const result = this.atomic("setMemberRole", () =>
      this.prepare("UPDATE org_members SET role = ? WHERE tenant_id = ? AND org_id = ? AND principal_id = ?").run(role, tenantId, orgId, principalId),
    )
    if (result.changes === 0) throw new IdentityError("MEMBER_NOT_FOUND", `Principal ${principalId} is not a member of ${orgId}`)
  }

  async removeMember(tenantId: string, orgId: string, principalId: string): Promise<void> {
    this.atomic("removeMember", () =>
      this.prepare("DELETE FROM org_members WHERE tenant_id = ? AND org_id = ? AND principal_id = ?").run(tenantId, orgId, principalId),
    )
  }

  async getMember(tenantId: string, orgId: string, principalId: string): Promise<OrganizationMember | null> {
    const row = this.prepare("SELECT * FROM org_members WHERE tenant_id = ? AND org_id = ? AND principal_id = ?").get(tenantId, orgId, principalId) as unknown as MemberRow | undefined
    return row ? { tenantId: row.tenant_id, orgId: row.org_id, principalId: row.principal_id, role: row.role as Role, createdAt: row.created_at } : null
  }

  async listMembers(tenantId: string, orgId: string): Promise<OrganizationMember[]> {
    const rows = this.prepare("SELECT * FROM org_members WHERE tenant_id = ? AND org_id = ? ORDER BY created_at ASC").all(tenantId, orgId) as unknown as MemberRow[]
    return rows.map((row) => ({ tenantId: row.tenant_id, orgId: row.org_id, principalId: row.principal_id, role: row.role as Role, createdAt: row.created_at }))
  }

  /**
   * Phase 2G: all organization memberships of one principal. Human session
   * resolution uses this to validate the explicit tenant context (client org
   * hints are validated against the returned set — never trusted directly).
   */
  async listMembershipsByPrincipal(principalId: string): Promise<OrganizationMember[]> {
    const rows = this.prepare("SELECT * FROM org_members WHERE principal_id = ? ORDER BY created_at ASC").all(principalId) as unknown as MemberRow[]
    return rows.map((row) => ({ tenantId: row.tenant_id, orgId: row.org_id, principalId: row.principal_id, role: row.role as Role, createdAt: row.created_at }))
  }

  async grantProject(tenantId: string, orgId: string, projectId: string, principalId: string, role: Role): Promise<ProjectGrant> {
    this.atomic("grantProject", () => {
      try {
        this.prepare("INSERT INTO project_grants (tenant_id, org_id, project_id, principal_id, role) VALUES (?, ?, ?, ?, ?)").run(tenantId, orgId, projectId, principalId, role)
      } catch (error) {
        if (isUniqueViolation(error)) throw new IdentityError("GRANT_EXISTS", `Grant already exists for ${principalId} on ${projectId}`)
        throw error
      }
    })
    return { tenantId, orgId, projectId, principalId, role }
  }

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------
  async createProject(tenantId: string, orgId: string, projectId: string, displayName: string | null = null): Promise<Project> {
    if (!(await this.getOrganization(tenantId, orgId))) throw new IdentityError("ORG_NOT_FOUND", `Organization ${orgId} not found in tenant ${tenantId}`)
    const now = Date.now()
    this.atomic("createProject", () => {
      try {
        this.prepare("INSERT INTO projects (project_id, tenant_id, org_id, created_at, display_name) VALUES (?, ?, ?, ?, ?)").run(projectId, tenantId, orgId, now, displayName)
      } catch (error) {
        if (isUniqueViolation(error)) throw new IdentityError("PROJECT_EXISTS", `Project ${projectId} already exists`)
        throw error
      }
    })
    return { projectId, tenantId, orgId, createdAt: now, displayName }
  }

  async getProject(tenantId: string, orgId: string, projectId: string): Promise<Project | null> {
    const row = this.prepare("SELECT * FROM projects WHERE tenant_id = ? AND org_id = ? AND project_id = ?").get(tenantId, orgId, projectId) as unknown as ProjectRow | undefined
    return row ? { projectId: row.project_id, tenantId: row.tenant_id, orgId: row.org_id, createdAt: row.created_at, displayName: row.display_name } : null
  }

  async listProjects(tenantId: string, orgId: string): Promise<Project[]> {
    const rows = this.prepare("SELECT * FROM projects WHERE tenant_id = ? AND org_id = ? ORDER BY created_at ASC").all(tenantId, orgId) as unknown as ProjectRow[]
    return rows.map((row) => ({ projectId: row.project_id, tenantId: row.tenant_id, orgId: row.org_id, createdAt: row.created_at, displayName: row.display_name }))
  }

  // -------------------------------------------------------------------------
  // Principals + API keys
  // -------------------------------------------------------------------------
  async registerPrincipal(tenantId: string, principalId: string, kind: PrincipalKind): Promise<void> {
    const now = Date.now()
    this.atomic("registerPrincipal", () => {
      try {
        this.prepare("INSERT INTO principals (principal_id, tenant_id, kind, created_at) VALUES (?, ?, ?, ?)").run(principalId, tenantId, kind, now)
      } catch (error) {
        if (isUniqueViolation(error)) throw new IdentityError("PRINCIPAL_EXISTS", `Principal ${principalId} already exists`)
        throw error
      }
    })
  }

  async getPrincipalTenant(principalId: string): Promise<string | null> {
    const row = this.prepare("SELECT tenant_id FROM principals WHERE principal_id = ?").get(principalId) as { tenant_id: string } | undefined
    return row?.tenant_id ?? null
  }

  /**
   * Create an API key. The plaintext secret is returned ONCE and never stored;
   * only a one-way verifier + lookup prefix are durable. The key id doubles as
   * the lookup identifier.
   */
  async createApiKey(
    tenantId: string,
    orgId: string,
    principalId: string,
    name: string,
    options: { expiresAt?: number; scope?: readonly string[]; rotatedFrom?: string; overlapExpiresAt?: number } = {},
  ): Promise<CreatedApiKey> {
    if (!(await this.getOrganization(tenantId, orgId))) throw new IdentityError("ORG_NOT_FOUND", `Organization ${orgId} not found in tenant ${tenantId}`)
    const keyId = id("vc_live")
    const body = randomBytes(24).toString("base64url")
    // `.` is the unambiguous separator (never present in base64url), so a
    // leaked database cannot mint secrets and the body's random `_` chars
    // never confuse parseSecret.
    const secret = `${keyId}.${body}`
    const keyPrefix = `${keyId.slice(0, 12)}…`
    const now = Date.now()
    const scopeJson = options.scope ? JSON.stringify([...options.scope]) : null
    this.atomic("createApiKey", () => {
      this.prepare(
        "INSERT INTO api_keys (key_id, tenant_id, org_id, principal_id, name, key_prefix, secret_hash, created_at, revoked_at, last_used_at, expires_at, scope, rotated_from, overlap_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)",
      ).run(keyId, tenantId, orgId, principalId, name, keyPrefix, hashSecret(secret), now, options.expiresAt ?? null, scopeJson, options.rotatedFrom ?? null, options.overlapExpiresAt ?? null)
    })
    return {
      keyId,
      tenantId,
      orgId,
      principalId,
      name,
      keyPrefix,
      secretHash: hashSecret(secret),
      createdAt: now,
      revokedAt: null,
      lastUsedAt: null,
      expiresAt: options.expiresAt ?? null,
      scope: options.scope ? [...options.scope] : null,
      rotatedFrom: options.rotatedFrom ?? null,
      overlapExpiresAt: options.overlapExpiresAt ?? null,
      secret,
    }
  }

  /** Read a single API key record (tenant-scoped). */
  async getApiKey(tenantId: string, keyId: string): Promise<ApiKeyRecord | null> {
    const row = this.prepare("SELECT * FROM api_keys WHERE key_id = ? AND tenant_id = ?").get(keyId, tenantId) as unknown as ApiKeyRow | undefined
    return row ? toApiKeyRecord(row) : null
  }

  async revokeApiKey(tenantId: string, keyId: string): Promise<void> {
    const now = Date.now()
    const result = this.atomic("revokeApiKey", () =>
      this.prepare("UPDATE api_keys SET revoked_at = ? WHERE key_id = ? AND tenant_id = ? AND revoked_at IS NULL").run(now, keyId, tenantId),
    )
    if (result.changes === 0) {
      const row = this.prepare("SELECT revoked_at FROM api_keys WHERE key_id = ? AND tenant_id = ?").get(keyId, tenantId) as { revoked_at: number | null } | undefined
      if (!row) throw new IdentityError("APIKEY_NOT_FOUND", `API key ${keyId} not found`)
      // already revoked — idempotent
    }
  }

  /**
   * Phase 1F: set an absolute expiry on a key (without revoking it immediately).
   * The key authenticates until `expiresAt`, then is rejected. Useful for
   * scheduled rotation without an explicit revoke call.
   */
  async expireApiKey(tenantId: string, keyId: string, expiresAt: number): Promise<void> {
    const result = this.atomic("expireApiKey", () =>
      this.prepare("UPDATE api_keys SET expires_at = ? WHERE key_id = ? AND tenant_id = ?").run(expiresAt, keyId, tenantId),
    )
    if (result.changes === 0) {
      const row = this.prepare("SELECT key_id FROM api_keys WHERE key_id = ? AND tenant_id = ?").get(keyId, tenantId) as { key_id: string } | undefined
      if (!row) throw new IdentityError("APIKEY_NOT_FOUND", `API key ${keyId} not found`)
    }
  }

  /**
   * Phase 1F: rotate an API key with a controlled overlap window.
   *
   *   old key valid → create replacement → controlled overlap → old expires/revokes
   *
   * Creates a replacement key linked (`rotated_from`) to the old key, and sets
   * the old key's `overlap_expires_at` to `now + overlapMs`. Until that time
   * BOTH keys authenticate (overlap); after it, {@link reapExpiredKeys} (or an
   * explicit {@link revokeApiKey}) retires the old key. The plaintext secret of
   * the replacement is returned exactly once; the old key's secret is never
   * re-exposed. The replacement inherits the old key's scope/expiry policy
   * unless overridden.
   *
   * Returns the replacement (with secret) and the updated old-key record.
   */
  async rotateApiKey(
    tenantId: string,
    oldKeyId: string,
    options: { overlapMs: number; name?: string; expiresAt?: number; scope?: readonly string[] },
  ): Promise<{ replacement: CreatedApiKey; oldKey: ApiKeyRecord }> {
    const old = await this.getApiKey(tenantId, oldKeyId)
    if (!old) throw new IdentityError("APIKEY_NOT_FOUND", `API key ${oldKeyId} not found`)
    if (old.revokedAt !== null) throw new IdentityError("APIKEY_REVOKED", `API key ${oldKeyId} is already revoked`)
    const now = Date.now()
    const overlapExpiresAt = now + options.overlapMs
    // Mark the old key's overlap window.
    this.atomic("rotateApiKey_setOverlap", () => {
      this.prepare("UPDATE api_keys SET overlap_expires_at = ? WHERE key_id = ? AND tenant_id = ?").run(overlapExpiresAt, oldKeyId, tenantId)
    })
    // Create the replacement, inheriting scope unless overridden.
    const replacement = await this.createApiKey(tenantId, old.orgId, old.principalId, options.name ?? `${old.name} (rotated)`, {
      expiresAt: options.expiresAt ?? old.expiresAt ?? undefined,
      scope: options.scope ?? old.scope ?? undefined,
      rotatedFrom: oldKeyId,
    })
    const updatedOld = await this.getApiKey(tenantId, oldKeyId)
    return { replacement, oldKey: updatedOld! }
  }

  /**
   * Phase 1F: reap keys whose overlap window has elapsed (auto-retire the old
   * key in a rotation) and keys whose absolute expiry has passed. Revokes them
   * (sets `revoked_at`) so they can no longer authenticate. Idempotent: a
   * already-revoked key is skipped. Returns the count of newly-revoked keys.
   */
  async reapExpiredKeys(now: number = Date.now()): Promise<number> {
    return this.atomic("reapExpiredKeys", (): number => {
      const expired = this.prepare(
        "SELECT key_id FROM api_keys WHERE revoked_at IS NULL AND ((overlap_expires_at IS NOT NULL AND overlap_expires_at <= ?) OR (expires_at IS NOT NULL AND expires_at <= ?))",
      ).all(now, now) as Array<{ key_id: string }>
      for (const row of expired) {
        this.prepare("UPDATE api_keys SET revoked_at = ? WHERE key_id = ? AND revoked_at IS NULL").run(now, row.key_id)
      }
      return expired.length
    })
  }

  async listApiKeys(tenantId: string, orgId: string): Promise<ApiKeyRecord[]> {
    const rows = this.prepare("SELECT * FROM api_keys WHERE tenant_id = ? AND org_id = ? ORDER BY created_at ASC").all(tenantId, orgId) as unknown as ApiKeyRow[]
    return rows.map(toApiKeyRecord)
  }

  /**
   * Verify an API key secret and resolve the principal it belongs to. A
   * revoked, expired, or unknown key rejects. Authorization uses the
   * authoritative key state (revoked/expires/scope), never cached
   * `last_used_at`. `last_used_at` is updated best-effort only on successful
   * authentication; it is metadata for ops, never an authz input, so its
   * async/lazy nature cannot become a bottleneck or race source.
   *
   * Phase 1F: enforces absolute expiry (`expires_at`) at authentication time —
   * an expired key is rejected exactly like a revoked key. Project scope
   * restrictions (`scope`) are enforced at {@link authorize} time.
   */
  async authenticateApiKey(secret: string): Promise<ResolvedPrincipal | null> {
    const parsed = parseSecret(secret)
    if (!parsed) return null
    const row = this.prepare("SELECT * FROM api_keys WHERE key_id = ?").get(parsed.keyId) as unknown as ApiKeyRow | undefined
    if (!row) return null
    if (row.revoked_at !== null) return null
    // Expiry: an expired key is rejected like a revoked key.
    if (row.expires_at !== null && row.expires_at <= Date.now()) return null
    if (!verifySecret(secret, row.secret_hash)) return null
    const member = await this.getMember(row.tenant_id, row.org_id, row.principal_id)
    if (!member) return null
    this.atomic("touchApiKey", () =>
      this.prepare("UPDATE api_keys SET last_used_at = ? WHERE key_id = ?").run(Date.now(), row.key_id),
    )
    const principal = await this.resolvePrincipal(row.principal_id, row.org_id, member.role)
    // Attach the key's project scope restriction so authorize can enforce it.
    return { ...principal, apiKeyScope: row.scope ? (JSON.parse(row.scope) as string[]) : null, apiKeyId: row.key_id }
  }

  // -------------------------------------------------------------------------
  // Authorization
  // -------------------------------------------------------------------------

  /** Resolve a human/service principal to its authorization scope. */
  async resolvePrincipal(principalId: string, orgId: string, fallbackRole: Role): Promise<ResolvedPrincipal> {
    const tenantId = await this.getPrincipalTenant(principalId)
    if (!tenantId) throw new IdentityError("PRINCIPAL_NOT_FOUND", `Principal ${principalId} not found`)
    const member = await this.getMember(tenantId, orgId, principalId)
    const role = member?.role ?? fallbackRole
    const grantRows = this.prepare("SELECT * FROM project_grants WHERE tenant_id = ? AND org_id = ? AND principal_id = ?").all(tenantId, orgId, principalId) as unknown as GrantRow[]
    // A principal with NO project grants has access to NO projects (least
    // privilege). The "*" wildcard is never synthesized from absence — it must
    // come from an explicit wildcard grant or the admin flag (checked in
    // authorize()). This prevents a freshly-added member with zero grants from
    // silently acting on every project in the org.
    const projectScope = grantRows.map((g) => g.project_id)
    const principalRow = this.prepare("SELECT kind FROM principals WHERE principal_id = ?").get(principalId) as { kind: string } | undefined
    const kind = (principalRow?.kind ?? "user") as PrincipalKind
    return { principalId, kind, tenantId, orgId, role, projectScope }
  }

  /**
   * Authorize a principal against an org/project scope. Throws {@link IdentityError}
   * on denial. Returns the resolved scope (validated org + project). Project
   * scope `"*"` is a wildcard the control plane uses for ad-hoc requests; it is
   * NOT authorized unless the principal's `projectScope` contains `"*"` or the
   * concrete project.
   */
  async authorize(principal: ResolvedPrincipal, scope: { orgId: string; projectId: string }): Promise<{ orgId: string; projectId: string }> {
    if (principal.admin) return scope
    if (principal.orgId !== scope.orgId) {
      throw new IdentityError("FORBIDDEN_ORG", `Principal not a member of organization ${scope.orgId}`)
    }
    if (scope.projectId !== "*") {
      if (!(await this.getOrganization(principal.tenantId, scope.orgId))) {
        throw new IdentityError("ORG_NOT_FOUND", `Organization ${scope.orgId} not found`)
      }
      if (!(await this.getProject(principal.tenantId, scope.orgId, scope.projectId))) {
        throw new IdentityError("PROJECT_NOT_FOUND", `Project ${scope.projectId} not found in ${scope.orgId}`)
      }
      const allowed = principal.projectScope.includes("*") || principal.projectScope.includes(scope.projectId)
      if (!allowed) throw new IdentityError("FORBIDDEN_PROJECT", `Principal not granted access to project ${scope.projectId}`)
    }
    // Phase 1F: enforce the authenticating API key's project scope restriction
    // (in addition to the principal's grants). A key scoped to a subset of
    // projects cannot act on projects outside that subset, even if the principal
    // is granted them. null/undefined = unrestricted (within grants).
    if (principal.apiKeyScope && scope.projectId !== "*") {
      if (!principal.apiKeyScope.includes(scope.projectId)) {
        throw new IdentityError("FORBIDDEN_APIKEY_SCOPE", `API key not scoped for project ${scope.projectId}`)
      }
    }
    return scope
  }

  /** Require the principal's role to be at least `minRole`. */
  static requireRole(principal: ResolvedPrincipal, minRole: Role): void {
    if (ROLE_RANK[principal.role] < ROLE_RANK[minRole]) {
      throw new IdentityError("FORBIDDEN_ROLE", `Role "${minRole}" or higher is required (have "${principal.role}")`)
    }
  }

  /** Require admin-level rights. */
  static requireAdmin(principal: ResolvedPrincipal): void {
    if (!ADMIN_ROLES.has(principal.role)) {
      throw new IdentityError("FORBIDDEN_ROLE", `Admin role required (have "${principal.role}")`)
    }
  }

  /**
   * Cross-validate a job's immutable tenant/org/project identity at creation
   * and recovery. The triple must exist and belong together; a job can never
   * run under a scope whose chain is broken or belongs to another tenant.
   */
  async validateJobIdentity(identity: JobIdentity): Promise<void> {
    const org = await this.getOrganization(identity.tenantId, identity.orgId)
    if (!org) throw new IdentityError("ORG_NOT_FOUND", `Organization ${identity.orgId} not found in tenant ${identity.tenantId}`)
    if (org.tenantId !== identity.tenantId) throw new IdentityError("IDENTITY_MISMATCH", `Organization ${identity.orgId} belongs to tenant ${org.tenantId}, not ${identity.tenantId}`)
    if (identity.projectId !== "*") {
      const project = await this.getProject(identity.tenantId, identity.orgId, identity.projectId)
      if (!project) throw new IdentityError("PROJECT_NOT_FOUND", `Project ${identity.projectId} not found in ${identity.orgId}`)
      if (project.tenantId !== identity.tenantId || project.orgId !== identity.orgId) {
        throw new IdentityError("IDENTITY_MISMATCH", `Project ${identity.projectId} does not belong to ${identity.tenantId}/${identity.orgId}`)
      }
    }
  }
}
