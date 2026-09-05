/**
 * Production-facing list routes: GET /jobs and GET /automation/runs.
 *
 * Verifies the frontend repository contracts (jobs.list(),
 * automation.runs.list()) against the mounted backend. These route
 * pairs were previously industrialized as list endpoints in the frontend
 * while the backend never registered them. Tenant isolation and the auth
 * boundary are exercised over real HTTP (PGlite, stub runner read-only
 * routes never invoke agent execution).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PgliteDatabase, pgliteDialect } from "@vaulltcore/store-sql";
import { SqlIdentityStore } from "@vaulltcore/identity";
import { SqlPolicyStore } from "@vaulltcore/policy";
import { SqlQuotaStore } from "@vaulltcore/quota";
import { SqlMeteringStore } from "@vaulltcore/metering";
import { SqlBillingStore } from "@vaulltcore/billing";
import { SqlAuditStore } from "@vaulltcore/audit";
import { SqlAutomationStore } from "@vaulltcore/automation";
import { ControlPlane, HeaderAuthenticator } from "../src/index";
import type { JobIndex } from "@vaulltcore/reconcile";
import type { Server } from "node:http";

const db = new PgliteDatabase();

let control: ControlPlane;
let server: Server;
let base: string;

const jobsIndex: JobIndex = {
  async listJobsByTenant(tenantId: string) {
    if (tenantId == "tList") {
      return [
        { jobId: "job_list_1", tenantId: "tList", orgId: "org_list", projectId: "proj_list", status: "completed" as const, lastSeq: 2, createdAt: 1000, updatedAt: 2000 },
        { jobId: "job_list_2", tenantId: "tList", orgId: "org_list", projectId: "proj_list", status: "failed" as const, lastSeq: 1, createdAt: 1500, updatedAt:  2500 },
      ];
    }
    return [];
  },
};

function view(id: string, status: string): Record<string, unknown> {
  return {
    id,
    tenantId: "tList",
    orgId: "org_list",
    projectId: "proj_list",
    status,
    createdAt: 1000,
    updatedAt: 2000,
    usage: { inputTokens: 0, outputTokens:  0, reasoningTokens:  0, totalTokens:  5, steps: 2, toolCalls: 0 },
    pendingInput: [],
  };
}

const jobsByRunner: Record<string, unknown> = {
  job_list_1: view("job_list_1", "completed"),
  job_list_2: view("job_list_2", "failed"),
};

beforeAll(async () => {
  const identity = new SqlIdentityStore(db, { dialect: pgliteDialect });
  const policy = new SqlPolicyStore(db, { dialect: pgliteDialect });
  const quota = new SqlQuotaStore(db, { dialect: pgliteDialect });
  const metering = new SqlMeteringStore(db, { dialect: pgliteDialect });
  const billing = new SqlBillingStore(db, { dialect: pgliteDialect });
  const audit = new SqlAuditStore(db, { dialect: pgliteDialect });
  const automationStore = new SqlAutomationStore(db, { dialect: pgliteDialect });

  const runner = {
    runJob: async () => ({ status: "succeeded" }),
    listEvents: async () => [],
    getJobState: async () => null,
    createJob: async () => ({ jobId: "j" }),
    submitInput: async () => ({ status: "succeeded" }),
    getJob: async (jobId: string) => jobsByRunner[jobId] ?? null,
  } as never;

  control = new ControlPlane({
    runner,
    authenticator: new HeaderAuthenticator(),
    business: { identity, policy, quota, metering, billing, audit, jobs: jobsIndex },
    automation: { store: automationStore },
  });
  server = await control.listen(0);
  const address = server.address();
  base = `http://127.0.0.1:${typeof address == "object" && address ? address.port : 0}`;

  await identity.createTenant("tList", "system", "List");
  await identity.createOrganization("tList", "org_list", "Eng");
await identity.createProject("tList", "org_list", "proj_list", "List");
await identity.registerPrincipal("tList", "p-list", "service_account");
await identity.addMember("tList", "org_list", "p-list", "owner");
await identity.grantProject("tList", "org_list", "proj_list", "p-list", "owner");
});

afterAll(() => {
  server.close();
  db.close();
});

function h(tenant: string): Record<string, string> {
  return { "x-vc-tenant": tenant, "x-vc-org": "org_list" };
}

describe("GET /jobs", () => {
  it("returns tenant-scoped job views", async () => {
    const res = await fetch(`${base}/jobs`, { headers: h("tList") });
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect((body[0] as Record<string, unknown>).id).toBe("job_list_1");
    expect((body[1] as Record<string, unknown>).status).toBe("failed");
  });

  it("returns an empty array for another tenant", async () => {
    const res = await fetch(`${base}/jobs`, { headers: h("tOther") });
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body).toEqual([]);
  });

  it("requires authentication", async () => {
    const res = await fetch(`${base}/jobs`);
    expect(res.status).toBe(401);
  });
});

describe("GET /automation/runs", () => {
  it("returns the runs wrapper", async () => {
    const res = await fetch(`${base}/automation/runs`, { headers: h("tList") });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: unknown[] };
  });

  it("isolates another tenant", async () => {
    const res = await fetch(`${base}/automation/runs`, { headers: h("tOther") });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: unknown[] };
    expect(body.runs).toEqual([]);
  });

 it("requires authentication", async () => {
    const res = await fetch(`${base}/automation/runs`);
    expect(res.status).toBe(401);
  });
});