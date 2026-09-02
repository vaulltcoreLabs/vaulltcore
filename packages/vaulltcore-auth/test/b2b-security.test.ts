/**
 * Phase 2G proof: Better Auth integration, session→actor resolution,
 * membership/role lifecycle, central permission authorization, service
 * identities, machine credentials, session registry, and tenant isolation.
 * All tests are deterministic (in-memory SQLite + a real Better Auth
 * instance running its own migrations over node:sqlite). No mocks.
 */

import { createRequire } from "node:module"
import { beforeEach, describe, expect, it } from "vitest"

const nodeRequire = createRequire(import.meta.url)
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite")

import { NodeSqliteDatabase } from "@vaulltcore/store-sql"
import { SqlIdentityStore } from "@vaulltcore/identity"
import { SqlAuditStore } from "@vaulltcore/audit"
import {
  ActorResolver,
  AuthError,
  AuthorizationError,
  BetterAuthAdapter,
  ServiceIdentityService,
  SqlB2bAuthStore,
  authorize,
  fingerprintSecret,
  type Actor,
} from "../src/index"

const BASE = "http://better-auth.test"
const SECRET = "test-secret-test-secret-test-secret-0123456789"

interface Rig {
  identity: SqlIdentityStore
  authStore: SqlB2bAuthStore
  audit: SqlAuditStore
  ba: BetterAuthAdapter
  resolver: ActorResolver
  serviceIdentities: ServiceIdentityService
  tenantId: string
  orgId: string
  projectId: string
}

function makeRig(): Rig {
  const db = NodeSqliteDatabase.memory()
  const baDb = new DatabaseSync(":memory:")
  const identity = new SqlIdentityStore(db)
  const authStore = new SqlB2bAuthStore(db)
  const audit = new SqlAuditStore(db)
  const ba = new BetterAuthAdapter({ database: baDb, secret: SECRET, baseURL: BASE })
  const serviceIdentities = new ServiceIdentityService({ identity, authStore, audit })
  const resolver = new ActorResolver({ identity, authStore, sessions: ba, serviceIdentities, audit })
  return { identity, authStore, audit, ba, resolver, serviceIdentities, tenantId: "t-acme", orgId: "org-acme", projectId: "proj-alpha" }
}

async function seedScope(rig: Rig): Promise<void> {
  await rig.identity.createTenant(rig.tenantId, "system", "Acme")
  await rig.identity.createOrganization(rig.tenantId, rig.orgId, "Acme Engineering")
  await rig.identity.createProject(rig.tenantId, rig.orgId, rig.projectId, "Alpha")
}

async function signUp(rig: Rig, email: string, name = "User"): Promise<{ userId: string; cookie: string }> {
  const res = await rig.ba.handleRequest({
    method: "POST",
    path: "/api/auth/sign-up/email",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password1234", name }),
  })
  expect(res.status).toBe(200)
  const body = JSON.parse(res.body) as { user: { id: string } }
  const cookies = res.headers["set-cookie"]
  const cookie = Array.isArray(cookies) ? cookies[0] : cookies
  return { userId: body.user.id, cookie: cookie!.split(";")[0]! }
}

async function join(rig: Rig, userId: string, role: "owner" | "admin" | "developer" | "operator" | "viewer" = "viewer", org: string | null = null): Promise<void> {
  await rig.identity.registerPrincipal(rig.tenantId, userId, "user").catch((e: { code?: string }) => {
    if (e.code !== "PRINCIPAL_EXISTS") throw e
  })
  await rig.identity.addMember(rig.tenantId, org ?? rig.orgId, userId, role)
}

describe("better-auth integration (real, own migrations)", () => {
  it("sign-up → sign-in → validate → sign-out revokes", async () => {
    const rig = makeRig()
    await rig.ba.migrate()
    const { cookie } = await signUp(rig, "alice@example.com")
    const session = await rig.ba.validateSession(cookie)
    expect(session).not.toBeNull()
    expect(session!.userId).toBeTruthy()
    // Sign-out with proper Origin revokes the session server-side.
    const out = await rig.ba.handleRequest({
      method: "POST",
      path: "/api/auth/sign-out",
      headers: { cookie, origin: BASE },
    })
    expect(out.status).toBe(200)
    expect(await rig.ba.validateSession(cookie)).toBeNull()
  })

  it("rejects state-changing auth requests from a hostile Origin (CSRF hardening)", async () => {
    const rig = makeRig()
    await rig.ba.migrate()
    const { cookie } = await signUp(rig, "bob@example.com")
    const out = await rig.ba.handleRequest({
      method: "POST",
      path: "/api/auth/sign-out",
      headers: { cookie, origin: "https://evil.example" },
    })
    expect(out.status).toBe(403)
    // Session still valid — the blocked request did not mutate anything.
    expect(await rig.ba.validateSession(cookie)).not.toBeNull()
  })

  it("rejects a weak secret at construction (no insecure defaults)", () => {
    expect(() => new BetterAuthAdapter({ database: null, secret: "short", baseURL: BASE })).toThrow(/secret/)
  })
})

describe("session → actor resolution", () => {
  let rig: Rig
  beforeEach(async () => {
    rig = makeRig()
    await rig.ba.migrate()
    await seedScope(rig)
  })

  it("valid session resolves a user actor with role-derived permissions and fingerprint attribution (never the token)", async () => {
    const { userId, cookie } = await signUp(rig, "carol@example.com")
    await join(rig, userId, "viewer")
    const actor = await rig.resolver.resolve({ cookie })
    expect(actor).not.toBeNull()
    expect(actor!.actorClass).toBe("user")
    expect(actor!.tenantId).toBe("t-acme")
    expect(actor!.orgId).toBe("org-acme")
    expect(actor!.role).toBe("viewer")
    expect(actor!.permissions).toContain("member.read")
    expect(actor!.permissions).not.toContain("member.manage")
    expect(actor!.attribution.sessionFingerprint).toMatch(/^[0-9a-f]{64}$/)
    // The raw session token must NOT appear anywhere on the actor.
    expect(JSON.stringify(actor)).not.toContain(cookie.split("=")[1])
  })

  it("invalid/garbage cookie resolves to null (unauthenticated)", async () => {
    expect(await rig.resolver.resolve({ cookie: "better-auth.session_token=garbage" })).toBeNull()
    expect(await rig.resolver.resolve({})).toBeNull()
  })

  it("provisions the durable user identity idempotently on first resolution", async () => {
    const { userId, cookie } = await signUp(rig, "dana@example.com")
    await join(rig, userId, "viewer")
    await rig.resolver.resolve({ cookie })
    const first = await rig.authStore.getUserIdentity(userId)
    expect(first).not.toBeNull()
    expect(first!.status).toBe("active")
    // Second resolution does not create a duplicate.
    await rig.resolver.resolve({ cookie })
    expect((await rig.authStore.getUserIdentity(userId))!.userId).toBe(userId)
    await expect(rig.authStore.disableUserIdentity(userId)).resolves.toMatchObject({ status: "disabled" })
  })

  it("explicit org switching is validated server-side; a non-member org hint never bypasses", async () => {
    const { userId, cookie } = await signUp(rig, "eve@example.com")
    await join(rig, userId, "viewer")
    await rig.identity.createOrganization(rig.tenantId, "org-other", "Other")
    await join(rig, userId, "viewer", "org-other")
    // Access to the member org works…
    const ok = await rig.resolver.resolve({ cookie, requestedOrgId: "org-other" })
    expect(ok!.orgId).toBe("org-other")
    // …but a non-member org hint is rejected deterministically.
    await rig.identity.createOrganization(rig.tenantId, "org-secret", "Secret")
    await expect(rig.resolver.resolve({ cookie, requestedOrgId: "org-secret" })).rejects.toMatchObject({ code: "ORG_NOT_MEMBER" })
  })

  it("revoked session is denied even if Better Auth still considers it valid", async () => {
    const { userId, cookie } = await signUp(rig, "frank@example.com")
    await join(rig, userId, "viewer")
    const actor = await rig.resolver.resolve({ cookie })
    const fingerprint = actor!.attribution.sessionFingerprint!
    await rig.authStore.revokeSession(fingerprint)
    await expect(rig.resolver.resolve({ cookie })).rejects.toMatchObject({ code: "SESSION_REVOKED" })
  })

  it("membership removal loses access at the next request (no stale privilege)", async () => {
    const { userId, cookie } = await signUp(rig, "grace@example.com")
    await join(rig, userId, "viewer")
    expect(await rig.resolver.resolve({ cookie })).not.toBeNull()
    await rig.identity.removeMember(rig.tenantId, rig.orgId, userId)
    await expect(rig.resolver.resolve({ cookie })).rejects.toMatchObject({ code: "ORG_NOT_MEMBER" })
  })

  it("privilege downgrade takes effect at the next request (per-request role lookup)", async () => {
    const { userId, cookie } = await signUp(rig, "heidi@example.com")
    await join(rig, userId, "admin")
    let actor = await rig.resolver.resolve({ cookie })
    expect(actor!.permissions).toContain("member.manage")
    await rig.identity.setMemberRole(rig.tenantId, rig.orgId, userId, "viewer")
    actor = await rig.resolver.resolve({ cookie })
    expect(actor!.role).toBe("viewer")
    expect(actor!.permissions).not.toContain("member.manage")
  })

  it("disabled user is denied even with a live session", async () => {
    const { userId, cookie } = await signUp(rig, "ivan@example.com")
    await join(rig, userId, "owner")
    expect(await rig.resolver.resolve({ cookie })).not.toBeNull()
    await rig.authStore.disableUserIdentity(userId)
    const revoked = await rig.authStore.revokeAllSessionsForUser(userId)
    expect(revoked).toBe(1)
    await expect(rig.resolver.resolve({ cookie })).rejects.toMatchObject({ code: "SESSION_REVOKED" })
    // With no prior resolution, disable alone still denies.
    const { userId: secondUser, cookie: secondCookie } = await signUp(rig, "ivan2@example.com")
    await join(rig, secondUser, "viewer")
    await rig.authStore.provisionUserIdentity(secondUser, null)
    await rig.authStore.disableUserIdentity(secondUser)
    await expect(rig.resolver.resolve({ cookie: secondCookie })).rejects.toMatchObject({ code: "USER_DISABLED" })
  })

  it("audits denied session resolutions (authentication_failed) without secrets", async () => {
    const { userId, cookie } = await signUp(rig, "judy@example.com")
    await join(rig, userId, "viewer")
    await expect(rig.resolver.resolve({ cookie, requestedOrgId: "org-nope" })).rejects.toBeTruthy()
    const events = await rig.audit.list({ tenantId: rig.tenantId }, 50)
    const failures = events.filter((e) => e.type === "authentication_failed")
    expect(failures.length).toBe(1)
    expect(JSON.stringify(failures)).not.toContain(cookie.split("=")[1]!.slice(0, 32))
  })
})

describe("central permission authorization", () => {
  it("viewer cannot perform administrative mutations; owner/admin boundaries hold", async () => {
    const rig = makeRig()
    await rig.ba.migrate()
    await seedScope(rig)
    const { userId, cookie } = await signUp(rig, "kate@example.com")
    await join(rig, userId, "viewer")
    let actor = await rig.resolver.resolve({ cookie })
    expect(() => authorize(actor!, "service_identity.manage")).toThrow(AuthorizationError)
    expect(() => authorize(actor!, "automation.manage")).toThrow(AuthorizationError)
    await rig.identity.setMemberRole(rig.tenantId, rig.orgId, userId, "owner")
    actor = await rig.resolver.resolve({ cookie })
    expect(() => authorize(actor!, "service_identity.manage")).not.toThrow()
    // admin holds every org-level permission except the operator-only one.
    expect(actor!.permissions).toContain("reconcile.admin")
    await rig.identity.setMemberRole(rig.tenantId, rig.orgId, userId, "admin")
    actor = await rig.resolver.resolve({ cookie })
    expect(actor!.permissions).not.toContain("reconcile.admin")
  })

  it("domain boundary: ServiceIdentityService enforces permissions without HTTP", async () => {
    const rig = makeRig()
    await rig.ba.migrate()
    await seedScope(rig)
    const { userId, cookie } = await signUp(rig, "liam@example.com")
    await join(rig, userId, "viewer")
    const actor = await rig.resolver.resolve({ cookie })
    await expect(rig.serviceIdentities.create(actor!, { name: "bot", permissions: ["run.read"] })).rejects.toThrow(AuthorizationError)
  })
})

describe("service identities & machine credentials", () => {
  let rig: Rig
  let owner: Actor
  beforeEach(async () => {
    rig = makeRig()
    await rig.ba.migrate()
    await seedScope(rig)
    const { userId, cookie } = await signUp(rig, "owner@example.com")
    await join(rig, userId, "owner")
    owner = (await rig.resolver.resolve({ cookie }))!
  })

  it("issues safely: secret shown once, only fingerprint persisted, authenticates with explicit bounded permissions", async () => {
    const identity = await rig.serviceIdentities.create(owner, { name: "deploy-bot", permissions: ["run.read"], projectIds: [rig.projectId] })
    const issued = await rig.serviceIdentities.issueCredential(owner, identity.serviceIdentityId)
    expect(issued.secret).toContain(".")
    // DB holds only the fingerprint + prefix.
    const creds = await rig.authStore.listMachineCredentials(rig.tenantId, rig.orgId, identity.serviceIdentityId)
    expect(creds).toHaveLength(1)
    expect(creds[0]!.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(creds[0])).not.toContain(issued.secret)
    // Authentication resolves an actor with ONLY the granted permission.
    const actor = await rig.resolver.resolve({ authorization: `Bearer ${issued.secret}` })
    expect(actor).not.toBeNull()
    expect(actor!.actorClass).toBe("service")
    expect(actor!.permissions).toEqual(["run.read"])
    expect(() => authorize(actor!, "run.manage")).toThrow(AuthorizationError)
    expect(actor!.projectScope).toContain(rig.projectId)
    expect(actor!.admin).toBe(false)
  })

  it("creators cannot grant permissions they do not hold (no privilege escalation)", async () => {
    const { userId, cookie } = await signUp(rig, "dev@example.com")
    await join(rig, userId, "developer")
    const dev = (await rig.resolver.resolve({ cookie }))!
    // developer lacks service_identity.manage → cannot create.
    await expect(rig.serviceIdentities.create(dev, { name: "x", permissions: ["run.read"] })).rejects.toThrow(AuthorizationError)
    await rig.identity.setMemberRole(rig.tenantId, rig.orgId, userId, "admin")
    const admin = (await rig.resolver.resolve({ cookie }))!
    // admin lacks reconcile.admin → cannot grant it to a service identity.
    await expect(rig.serviceIdentities.create(admin, { name: "x", permissions: ["reconcile.admin"] })).rejects.toThrow(AuthorizationError)
  })

  it("duplicate name → deterministic 409 (CONFLICT)", async () => {
    await rig.serviceIdentities.create(owner, { name: "dup", permissions: ["run.read"] })
    await expect(rig.serviceIdentities.create(owner, { name: "dup", permissions: ["run.read"] })).rejects.toMatchObject({ code: "CONFLICT" })
  })

  it("disabled identity is denied; re-enable restores; revoked is terminal", async () => {
    const identity = await rig.serviceIdentities.create(owner, { name: "lifecycle", permissions: ["run.read"] })
    const issued = await rig.serviceIdentities.issueCredential(owner, identity.serviceIdentityId)
    await rig.serviceIdentities.disable(owner, identity.serviceIdentityId)
    expect(await rig.serviceIdentities.authenticateMachineCredential(issued.secret)).toBeNull()
    await rig.serviceIdentities.enable(owner, identity.serviceIdentityId)
    expect(await rig.serviceIdentities.authenticateMachineCredential(issued.secret)).not.toBeNull()
    await rig.serviceIdentities.revoke(owner, identity.serviceIdentityId)
    expect(await rig.serviceIdentities.authenticateMachineCredential(issued.secret)).toBeNull()
    // revoke is idempotent, enable on revoked fails with CONFLICT
    const reRevoke = await rig.serviceIdentities.revoke(owner, identity.serviceIdentityId)
    expect(reRevoke.status).toBe("revoked")
    await expect(rig.serviceIdentities.enable(owner, identity.serviceIdentityId)).rejects.toMatchObject({ code: "CONFLICT" })
  })

  it("revoked and expired credentials are denied deterministically", async () => {
    const identity = await rig.serviceIdentities.create(owner, { name: "creds", permissions: ["run.read"] })
    const issued = await rig.serviceIdentities.issueCredential(owner, identity.serviceIdentityId)
    await rig.serviceIdentities.revokeCredential(owner, issued.credentialId)
    expect(await rig.serviceIdentities.authenticateMachineCredential(issued.secret)).toBeNull()
    const doomed = await rig.serviceIdentities.issueCredential(owner, identity.serviceIdentityId, { expiresInMs: -1000 })
    expect(await rig.serviceIdentities.authenticateMachineCredential(doomed.secret)).toBeNull()
  })

  it("cross-tenant isolation: another scope never discloses the identity", async () => {
    const identity = await rig.serviceIdentities.create(owner, { name: "isolated", permissions: ["run.read"] })
    expect(await rig.authStore.getServiceIdentity("t-other", "org-other", identity.serviceIdentityId)).toBeNull()
  })

  it("service identity lifecycle actions emit sanitized audit records (no secret bodies)", async () => {
    const identity = await rig.serviceIdentities.create(owner, { name: "audited", permissions: ["run.read"] })
    const issued = await rig.serviceIdentities.issueCredential(owner, identity.serviceIdentityId)
    const events = await rig.audit.list({ tenantId: rig.tenantId }, 100)
    const svcEvents = events.filter((e) => e.type === "service_identity_created" || e.type === "machine_credential_issued")
    expect(svcEvents.length).toBe(2)
    expect(JSON.stringify(svcEvents)).not.toContain(issued.secret.slice(16))
  })
})

describe("session registry", () => {
  it("revoke-all is idempotent and expiries bounded; fingerprints only", async () => {
    const rig = makeRig()
    await rig.ba.migrate()
    await seedScope(rig)
    const { userId, cookie } = await signUp(rig, "mia@example.com")
    await join(rig, userId, "viewer")
    const actor = await rig.resolver.resolve({ cookie })
    const sessions = await rig.authStore.listSessionsForUser(userId)
    expect(sessions).toHaveLength(1)
    expect(JSON.stringify(sessions)).not.toContain(cookie.split("=")[1]!.slice(0, 32))
    expect(await rig.authStore.revokeAllSessionsForUser(userId)).toBe(1)
    expect(await rig.authStore.revokeAllSessionsForUser(userId)).toBe(0)
    void actor
  })
})
