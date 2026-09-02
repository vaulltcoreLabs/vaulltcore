import { describe, it, expect, afterAll } from "vitest"
import { PgliteDatabase, pgliteDialect } from "../src/index"
import { SqlIdentityStore } from "@vaulltcore/identity"

const db = new PgliteDatabase()

afterAll(() => {
  db.close()
})

describe("pglite driver under vitest", () => {
  it("runs real PostgreSQL via PGlite sync bridge", () => {
    db.exec("CREATE TABLE IF NOT EXISTS smoke (id serial PRIMARY KEY, name text NOT NULL)")
    const stmt = db.prepare("INSERT INTO smoke (name) VALUES ($1) RETURNING id")
    const row = stmt.get("hello")
    expect(row).toBeDefined()
    expect(Number((row as { id: number }).id)).toBeGreaterThan(0)
    const all = db.prepare("SELECT * FROM smoke ORDER BY id").all()
    expect(all.length).toBeGreaterThan(0)
  })

  it("runs a SqlStoreBase business store against real PG unchanged", async () => {
    const identity = new SqlIdentityStore(db, { dialect: pgliteDialect })
    await identity.createTenant("t-pg", "system", "PG Tenant")
    const org = await identity.createOrganization("t-pg", "org-pg", "PG Org")
    expect(org.orgId).toBe("org-pg")
    await identity.createProject("t-pg", "org-pg", "proj-pg", "PG Project")
    await identity.registerPrincipal("t-pg", "p-pg", "service_account")
    await identity.addMember("t-pg", "org-pg", "p-pg", "owner")
    const key = await identity.createApiKey("t-pg", "org-pg", "p-pg", "pg-key")
    expect(key.secret).toContain(".")
    const principal = await identity.authenticateApiKey(key.secret)
    expect(principal).not.toBeNull()
    expect(principal!.tenantId).toBe("t-pg")
  })
})
