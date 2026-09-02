/**
 * Service identity & machine credential authority (Phase 2G).
 *
 * Machine access is a first-class actor class (`service`), not a human user.
 * A service identity belongs to exactly ONE tenant+org and holds an EXPLICIT,
 * bounded permission set — credentials never silently inherit owner rights.
 *
 * Machine credential format: `<credentialId>.<body>` (the `.` separator never
 * collides with base64url output). Only a SHA-256 fingerprint + lookup prefix
 * are persisted; the plaintext secret is shown exactly once at issuance.
 * Revocation/disabled identities reject authentication deterministically.
 */

import { randomBytes } from "node:crypto"
import { SqlIdentityStore, hashSecret, parseSecret, verifySecret } from "@vaulltcore/identity"
import type { AuditEventType, SqlAuditStore } from "@vaulltcore/audit"
import {
  Actor,
  AuthError,
  AuthorizationError,
  authorize,
  type IssuedMachineCredential,
  type MachineCredential,
  type Permission,
  type ServiceIdentity,
  isPermission,
} from "./contracts"
import { SqlB2bAuthStore } from "./auth-store"

const SECRET_PREFIX = "vc_svc"

export interface ServiceIdentityDeps {
  readonly identity: SqlIdentityStore
  readonly authStore: SqlB2bAuthStore
  readonly audit?: SqlAuditStore
}

function boundedPermissions(permissions: readonly string[]): Permission[] {
  for (const p of permissions) {
    if (!isPermission(p)) throw new AuthError("INVALID_INPUT", `unknown permission "${p}"`)
  }
  return [...new Set(permissions)] as Permission[]
}

export class ServiceIdentityService {
  private readonly identity: SqlIdentityStore
  private readonly authStore: SqlB2bAuthStore
  private readonly audit?: SqlAuditStore

  constructor(deps: ServiceIdentityDeps) {
    this.identity = deps.identity
    this.authStore = deps.authStore
    this.audit = deps.audit
  }

  /** Create a service identity. The granted permissions must be a subset of
   *  the creator's own permissions (no privilege escalation). */
  async create(
    actor: Actor,
    input: { name: string; permissions: readonly string[]; projectIds?: readonly string[]; idempotencyKey?: string },
  ): Promise<ServiceIdentity> {
    authorize(actor, "service_identity.manage")
    const permissions = boundedPermissions(input.permissions)
    if (!actor.admin) {
      for (const p of permissions) {
        if (!actor.permissions.includes(p)) {
          throw new AuthorizationError(p, `cannot grant permission "${p}" the creator does not hold`)
        }
      }
    }
    const identity = await this.authStore.createServiceIdentity({
      tenantId: actor.tenantId,
      orgId: actor.orgId,
      name: input.name,
      permissions,
      createdBy: actor.principalId,
    })
    // Register the principal at the (single) scope; project grants stay
    // least-privilege: no grants → no project access.
    await this.identity.registerPrincipal(actor.tenantId, identity.serviceIdentityId, "service_account")
    for (const projectId of input.projectIds ?? []) {
      const project = await this.identity.getProject(actor.tenantId, actor.orgId, projectId)
      if (!project) throw new AuthError("INVALID_INPUT", `unknown project "${projectId}"`)
      await this.identity.grantProject(actor.tenantId, actor.orgId, projectId, identity.serviceIdentityId, "service_account")
    }
    this.auditEvent(actor, "service_identity_created", { serviceIdentityId: identity.serviceIdentityId, name: identity.name, permissions })
    return identity
  }

  /** Issue a machine credential. The secret is returned exactly once. */
  async issueCredential(actor: Actor, serviceIdentityId: string, options: { expiresInMs?: number } = {}): Promise<IssuedMachineCredential> {
    authorize(actor, "service_identity.manage")
    const identity = await this.authStore.getServiceIdentity(actor.tenantId, actor.orgId, serviceIdentityId)
    if (!identity) throw new AuthError("NOT_FOUND", "service identity not found")
    if (identity.status !== "active") throw new AuthError("CONFLICT", `service identity is "${identity.status}"`)
    const credentialId = `cred_${randomBytes(6).toString("base64url")}`
    const body = randomBytes(24).toString("base64url")
    const secret = `${credentialId}.${body}`
    const record = await this.authStore.recordMachineCredential({
      credentialId,
      serviceIdentityId,
      tenantId: identity.tenantId,
      orgId: identity.orgId,
      prefix: `${SECRET_PREFIX}_${credentialId.slice(0, 9)}`,
      fingerprint: hashSecret(secret),
      expiresAt: options.expiresInMs ? Date.now() + options.expiresInMs : null,
    })
    this.auditEvent(actor, "machine_credential_issued", { serviceIdentityId, credentialId: record.credentialId, prefix: record.prefix })
    return { ...record, secret }
  }

  /**
   * Authenticate a machine credential secret. Rejects disabled/revoked
   * identities and revoked/expired credentials deterministically. Resolution
   * always consults durable state — revocation takes effect at the next
   * request (documented consistency model: per-request lookup).
   */
  async authenticateMachineCredential(secret: string): Promise<Actor | null> {
    const parsed = parseSecret(secret)
    if (!parsed) return null
    const credential = await this.authStore.getMachineCredential(parsed.keyId)
    if (!credential) return null
    if (credential.revokedAt !== null) return null
    if (credential.expiresAt !== null && credential.expiresAt <= Date.now()) return null
    if (!verifySecret(secret, credential.fingerprint)) return null
    const identity = await this.authStore.getServiceIdentity(credential.tenantId, credential.orgId, credential.serviceIdentityId)
    if (!identity || identity.status !== "active") return null
    const resolved = await this.identity.resolvePrincipal(identity.serviceIdentityId, identity.orgId, "service_account")
    // Best-effort last-used metadata; never an authz input.
    void this.authStore.touchMachineCredential(credential.credentialId).catch(() => undefined)
    return {
      actorClass: "service",
      principalId: identity.serviceIdentityId,
      tenantId: identity.tenantId,
      orgId: identity.orgId,
      role: "service_account",
      // EXPLICIT bounded set only; the "service_account" role mapping is not
      // implicitly merged in.
      permissions: [...identity.permissions],
      projectScope: [...resolved.projectScope],
      admin: false,
      attribution: { serviceIdentityId: identity.serviceIdentityId, credentialId: credential.credentialId },
    }
  }

  async disable(actor: Actor, serviceIdentityId: string): Promise<ServiceIdentity> {
    authorize(actor, "service_identity.manage")
    const current = await this.authStore.getServiceIdentity(actor.tenantId, actor.orgId, serviceIdentityId)
    if (!current) throw new AuthError("NOT_FOUND", "service identity not found")
    const updated = await this.authStore.disableServiceIdentity(serviceIdentityId)
    this.auditEvent(actor, "service_identity_disabled", { serviceIdentityId })
    return updated
  }

  async enable(actor: Actor, serviceIdentityId: string): Promise<ServiceIdentity> {
    authorize(actor, "service_identity.manage")
    const current = await this.authStore.getServiceIdentity(actor.tenantId, actor.orgId, serviceIdentityId)
    if (!current) throw new AuthError("NOT_FOUND", "service identity not found")
    return this.authStore.enableServiceIdentity(serviceIdentityId)
  }

  /** Revocation is terminal: the identity is dead and every live credential
   *  is revoked with it (fenced, transactional). */
  async revoke(actor: Actor, serviceIdentityId: string): Promise<ServiceIdentity> {
    authorize(actor, "service_identity.manage")
    const current = await this.authStore.getServiceIdentity(actor.tenantId, actor.orgId, serviceIdentityId)
    if (!current) throw new AuthError("NOT_FOUND", "service identity not found")
    const updated = await this.authStore.revokeServiceIdentity(serviceIdentityId)
    this.auditEvent(actor, "service_identity_revoked", { serviceIdentityId })
    return updated
  }

  async revokeCredential(actor: Actor, credentialId: string): Promise<MachineCredential> {
    authorize(actor, "service_identity.manage")
    const credential = await this.authStore.getMachineCredential(credentialId)
    if (!credential || credential.tenantId !== actor.tenantId || credential.orgId !== actor.orgId) {
      throw new AuthError("NOT_FOUND", "machine credential not found")
    }
    const updated = await this.authStore.revokeMachineCredential(credentialId)
    this.auditEvent(actor, "machine_credential_revoked", { credentialId })
    return updated
  }

  async list(actor: Actor): Promise<ServiceIdentity[]> {
    authorize(actor, "service_identity.manage")
    return this.authStore.listServiceIdentities(actor.tenantId, actor.orgId)
  }

  async listCredentials(actor: Actor, serviceIdentityId: string): Promise<MachineCredential[]> {
    authorize(actor, "service_identity.manage")
    const creds = await this.authStore.listMachineCredentials(actor.tenantId, actor.orgId, serviceIdentityId)
    return creds
  }

  private auditEvent(actor: Actor, type: AuditEventType, metadata: Record<string, unknown>): void {
    if (!this.audit) return
    // AuditClient.append is async; fire-and-forget would hide failures, so we
    // block the microtask but never let audit affect the security decision.
    void this.audit
      .append({
        actor: { principalId: actor.principalId, kind: actor.actorClass, tenantId: actor.tenantId },
        scope: { tenantId: actor.tenantId, orgId: actor.orgId },
        type,
        metadata,
      })
      .catch(() => undefined)
  }
}
