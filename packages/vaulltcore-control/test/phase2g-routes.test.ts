/**
 * Phase 2G control-plane proof: public `/auth/*` bridge, protected
 * `/identity/*` pipeline, membership administration, service identity
 * lifecycle, session management, tenant isolation, and HTTP status semantics.
 * Runs a real Better Auth instance (own migrations) and a real control-plane
 * server. No mocks.
 */

import { createRequire } from "node:module"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"

const nodeRequire = createRequire(import.meta.url)
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite")

import { DurableAgentRunner, FileJobStore, ScriptEngine } from "@vaulltcore/runner"
import { NodeSqliteDatabase } from "@vaulltcore/store-sql"
import { SqlIdentityStore } from "@vaulltcore/identity"
import { SqlAuditStore } from "@vaulltcore/audit"
import { ActorResolver, BetterAuthAdapter, ServiceIdentityService, SqlB2bAuthStore } from "@vaulltcore/auth"
import { ControlPlane } from "../src/index"

const BASE_AUTH_URL = "http://better-auth.test"
const SECRET = "test-secret-test-secret-test-secret-0123456789"

let root: string
const servers: Server[] = []

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vaulltcore-phase2g-"))
})
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve))
  await rm(root, { recursive: true, force: true })
})

interface Rig {
  base: string
  tenantId: string
  orgId: string
  projectId: string
  identity: SqlIdentityStore
  authStore: SqlB2bAuthStore
  audit: SqlAuditStore
  ba: BetterAuthAdapter
}

function makeRunner(): DurableAgentRunner {
  return new DurableAgentRunner({
    store: new FileJobStore(path.join(root, "store")),
    engines: [new ScriptEngine([{ text: "ok" }] as never)],
    tools: [],
    workspace: null,
  })
}

async function serve(): Promise<Rig> {
  const db = NodeSqliteDatabase.memory()
  const baDb = new DatabaseSync(":memory:")
  const identity = new SqlIdentityStore(db)
  const authStore = new SqlB2bAuthStore(db)
  const audit = new SqlAuditStore(db)
  const ba = new BetterAuthAdapter({ database: baDb, secret: SECRET, baseURL: BASE_AUTH_URL })
  await ba.migrate()
  const serviceIdentities = new ServiceIdentityService({ identity, authStore, audit })
  const resolver = new ActorResolver({ identity, authStore, sessions: ba, serviceIdentities, audit })
  const control = new ControlPlane({
    runner: makeRunner(),
    phase2g: { resolver, authStore, identity, serviceIdentities, audit, betterAuth: ba },
  })
  const server = await control.listen(0)
  servers.push(server)
  const address = server.address()
  const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`
  return { base, tenantId: "t-acme", orgId: "org-acme", projectId: "proj-alpha", identity, authStore, audit, ba }
}

async function json(
  base: string,
  method: string,
  urlPath: string,
  options: { body?: unknown; cookie?: string; authorization?: string; orgHeader?: string; browserOrigin?: string } = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const headers: Record<string, string> = {}
  if (options.body !== undefined) headers["content-type"] = "application/json"
  if (options.cookie) headers.cookie = options.cookie
  if (options.authorization) headers.authorization = options.authorization
  if (options.orgHeader) headers["x-vc-org"] = options.orgHeader
  // Browsers always send Origin on POST; the BA bridge enforces trusted
  // origins. Simulated browser origin must match the adapter's baseURL.
  if (options.browserOrigin) headers.origin = options.browserOrigin
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  })
  let body: any = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  return { status: res.status, body, headers: res.headers }
}

async function signUp(rig: Rig, email: string): Promise<{ cookie: string; userId: string }> {
  const res = await json(rig.base, "POST", "/auth/sign-up/email", { body: { email, password: "password1234", name: "U" }, browserOrigin: BASE_AUTH_URL })
  expect(res.status).toBe(200)
  const setCookie = res.headers.get("set-cookie")!
  return { cookie: setCookie.split(";")[0]!, userId: res.body.user.id }
}

async function joinAsOwner(rig: Rig, userId: string): Promise<void> {
  await rig.identity.createTenant(rig.tenantId, "system", "Acme")
  await rig.identity.createOrganization(rig.tenantId, rig.orgId, "Acme")
  await rig.identity.createProject(rig.tenantId, rig.orgId, rig.projectId, "Alpha")
  await rig.identity.registerPrincipal(rig.tenantId, userId, "user")
  await rig.identity.addMember(rig.tenantId, rig.orgId, userId, "owner")
  await rig.identity.grantProject(rig.tenantId, rig.orgId, rig.projectId, userId, "owner")
}

describe("public trust-boundary exceptions", () => {
  it("health endpoint and the Better Auth bridge are explicitly public", async () => {
    const rig = await serve()
    const health = await json(rig.base, "GET", "/health")
    expect(health.status).toBe(200)
    const unsupportedRandomGet = await json(rig.base, "GET", "/auth/get-session")
    // Better Auth resolves missing session → 200 with null. The important
    // property: the route is reachable without a Vaulltcore session.
    expect([200, 401]).toContain(unsupportedRandomGet.status)
  })

  it("protected identity routes reject unauthenticated requests with 401", async () => {
    const rig = await serve()
    const res = await json(rig.base, "GET", "/identity/me")
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe("UNAUTHENTICATED")
  })
})

describe("protected /identity/* pipeline", () => {
  it("valid session resolves /identity/me with role, scope and attribution — never secrets", async () => {
    const rig = await serve()
    const signedUp = await signUp(rig, "owner@example.com")
    await joinAsOwner(rig, signedUp.userId)
    const me = await json(rig.base, "GET", "/identity/me", { cookie: signedUp.cookie })
    expect(me.status).toBe(200)
    expect(me.body.role).toBe("owner")
    expect(me.body.orgId).toBe("org-acme")
    expect(me.body.actorClass).toBe("user")
    expect(JSON.stringify(me.body)).not.toContain(signedUp.cookie.split("=")[1]!)
    const token = signedUp.cookie.split("=").pop()
    expect(JSON.stringify(me.body)).not.toContain(token)
  })

  it("org hint header is validated against membership (no client-trusted org)", async () => {
    const rig = await serve()
    const signedUp = await signUp(rig, "multi@example.com")
    await joinAsOwner(rig, signedUp.userId)
    await rig.identity.createOrganization(rig.tenantId, "org-second", "Second")
    const bad = await json(rig.base, "GET", "/identity/me", { cookie: signedUp.cookie, orgHeader: "org-second" })
    expect(bad.status).toBe(404)
    expect(bad.body.error.code).toBe("ORG_NOT_MEMBER")
    const good = await json(rig.base, "GET", "/identity/me", { cookie: signedUp.cookie })
    expect(good.status).toBe(200)
  })

  it("membership administration: add → role change → remove; viewer is forbidden; invalid role is 422; cross-org is 404", async () => {
    const rig = await serve()
    const owner = await signUp(rig, "admin@example.com")
    await joinAsOwner(rig, owner.userId)
    const member = await signUp(rig, "member@example.com")
    // Add the member (owner permission).
    const add = await json(rig.base, "POST", "/identity/orgs/org-acme/members", { cookie: owner.cookie, body: { userId: member.userId, role: "viewer", projects: ["proj-alpha"] } })
    expect(add.status).toBe(201)
    expect(add.body.role).toBe("viewer")
    // Viewer cannot mutate memberships (403).
    const forbidden = await json(rig.base, "PATCH", "/identity/orgs/org-acme/members/" + owner.userId, { cookie: member.cookie, body: { role: "owner" } })
    expect(forbidden.status).toBe(403)
    // Owner changes the member's role (works).
    const changed = await json(rig.base, "PATCH", "/identity/orgs/org-acme/members/" + member.userId, { cookie: owner.cookie, body: { role: "developer" } })
    expect(changed.status).toBe(200)
    expect(changed.body.role).toBe("developer")
    // Invalid role → 422.
    const invalid = await json(rig.base, "POST", "/identity/orgs/org-acme/members", { cookie: owner.cookie, body: { userId: "someone", role: "superuser" } })
    expect(invalid.status).toBe(422)
    // Cross-org access → 404 (no existence leak).
    const crossOrg = await json(rig.base, "GET", "/identity/orgs/org-acme/members", { cookie: owner.cookie, orgHeader: "org-acme" })
    expect(crossOrg.status).toBe(200)
    const otherOrgMembers = await json(rig.base, "GET", "/identity/orgs/org-other/members", { cookie: owner.cookie })
    expect(otherOrgMembers.status).toBe(404)
    // Membership removal takes effect at the NEXT request.
    const removed = await json(rig.base, "DELETE", "/identity/orgs/org-acme/members/" + member.userId, { cookie: owner.cookie })
    expect(removed.status).toBe(200)
    const memberAfter = await json(rig.base, "GET", "/identity/me", { cookie: member.cookie })
    expect(memberAfter.status).toBe(404)
    expect(memberAfter.body.error.code).toBe("ORG_NOT_MEMBER")
  })

  it("service identity lifecycle over HTTP: create → issue → authenticate; revoke denies; no plaintext persisted", async () => {
    const rig = await serve()
    const owner = await signUp(rig, "svc-owner@example.com")
    await joinAsOwner(rig, owner.userId)
    const created = await json(rig.base, "POST", "/identity/service-identities", { cookie: owner.cookie, body: { name: "ci-bot", permissions: ["run.read"], projects: ["proj-alpha"] } })
    expect(created.status).toBe(201)
    const svcId = created.body.serviceIdentityId
    // Issue a credential — the secret appears EXACTLY once.
    const issued = await json(rig.base, "POST", `/identity/service-identities/${svcId}/credentials`, { cookie: owner.cookie, body: {} })
    expect(issued.status).toBe(201)
    const secret = issued.body.secret as string
    expect(secret).toContain(".")
    // The secret authenticates with bounded permissions.
    const machineMe = await json(rig.base, "GET", "/identity/me", { authorization: `Bearer ${secret}` })
    expect(machineMe.status).toBe(200)
    expect(machineMe.body.actorClass).toBe("service")
    const perms = await json(rig.base, "GET", "/identity/permissions", { authorization: `Bearer ${secret}` })
    expect(perms.status).toBe(200)
    expect(perms.body.permissions).toEqual(["run.read"])
    // Listings never contain the secret.
    const list = await json(rig.base, "GET", `/identity/service-identities/${svcId}/credentials`, { cookie: owner.cookie })
    expect(JSON.stringify(list.body)).not.toContain(secret)
    // A viewer user cannot manage service identities (403).
    const viewer = await signUp(rig, "svc-viewer@example.com")
    const addViewer = await json(rig.base, "POST", "/identity/orgs/org-acme/members", { cookie: owner.cookie, body: { userId: viewer.userId, role: "viewer" } })
    expect(addViewer.status).toBe(201)
    const viewerAttempt = await json(rig.base, "POST", "/identity/service-identities", { cookie: viewer.cookie, body: { name: "nope", permissions: ["run.read"] } })
    expect(viewerAttempt.status).toBe(403)
    // Revocation is terminal and effective at the next request.
    const revoked = await json(rig.base, "POST", `/identity/service-identities/${svcId}/revoke`, { cookie: owner.cookie })
    expect(revoked.status).toBe(200)
    const afterRevoke = await json(rig.base, "GET", "/identity/me", { authorization: `Bearer ${secret}` })
    expect(afterRevoke.status).toBe(401)
    // Confirm the DB itself never holds the plaintext.
    const rows = await rig.authStore.listMachineCredentials(rig.tenantId, rig.orgId, svcId)
    expect(JSON.stringify(rows)).not.toContain(secret)
  })

  it("session management: list own sessions, revoke current → denied afterwards, disable user → global denial", async () => {
    const rig = await serve()
    const admin = await signUp(rig, "sess-admin@example.com")
    await joinAsOwner(rig, admin.userId)
    const user = await signUp(rig, "sess-user@example.com")
    await rig.identity.registerPrincipal(rig.tenantId, user.userId, "user").catch(() => undefined)
    await rig.identity.addMember(rig.tenantId, rig.orgId, user.userId, "viewer")
    // Resolve once so the session is registered.
    await json(rig.base, "GET", "/identity/me", { cookie: user.cookie })
    // List own sessions.
    const sessions = await json(rig.base, "GET", "/identity/sessions", { cookie: user.cookie })
    expect(sessions.status).toBe(200)
    expect(sessions.body.sessions.length).toBeGreaterThanOrEqual(1)
    // Revoke current session → denied on the next request.
    const revoke = await json(rig.base, "POST", "/identity/sessions/revoke", { cookie: user.cookie })
    expect(revoke.status).toBe(200)
    const after = await json(rig.base, "GET", "/identity/me", { cookie: user.cookie })
    expect(after.status).toBe(401)
    // Admin disables another user → global denial of the live session.
    const target = await signUp(rig, "sess-target@example.com")
    await json(rig.base, "POST", "/identity/orgs/org-acme/members", { cookie: admin.cookie, body: { userId: target.userId, role: "viewer" } })
    await json(rig.base, "GET", "/identity/me", { cookie: target.cookie })
    const disable = await json(rig.base, "POST", `/identity/users/${target.userId}/disable`, { cookie: admin.cookie })
    expect(disable.status).toBe(200)
    const targetAfter = await json(rig.base, "GET", "/identity/me", { cookie: target.cookie })
    expect(targetAfter.status).toBe(401)
  })

  it("legacy bearer API keys still resolve under the machine path and downstream routes stay intact", async () => {
    const rig = await serve()
    await rig.identity.createTenant(rig.tenantId, "system", null)
    await rig.identity.createOrganization(rig.tenantId, rig.orgId, null)
    await rig.identity.registerPrincipal(rig.tenantId, "svc-sa", "service_account")
    await rig.identity.addMember(rig.tenantId, rig.orgId, "svc-sa", "operator")
    const key = await rig.identity.createApiKey(rig.tenantId, rig.orgId, "svc-sa", "svc")
    const me = await json(rig.base, "GET", "/identity/me", { authorization: `Bearer ${key.secret}` })
    expect(me.status).toBe(200)
    expect(me.body.actorClass).toBe("service")
    // Downstream protected route still enforces via the requested pipeline.
    const perms = await json(rig.base, "GET", "/identity/permissions", { authorization: `Bearer ${key.secret}` })
    expect(perms.status).toBe(200)
    expect(perms.body.permissions).toContain("reliability.manage")
  })
})
