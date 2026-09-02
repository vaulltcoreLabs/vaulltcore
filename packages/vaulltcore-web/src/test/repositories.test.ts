import { describe, it, expect } from "vitest";
import { mockRepositories } from "@/lib/repositories/mock";
import type { AppRepositories } from "@/lib/repositories/interfaces";

// Verify mock implements the same interface shape as AppRepositories
describe("Mock Repository Interface Compliance", () => {
  const repos: AppRepositories = mockRepositories;

  it("has all required top-level domains", () => {
    expect(repos.jobs).toBeDefined();
    expect(repos.automation).toBeDefined();
    expect(repos.schedules).toBeDefined();
    expect(repos.connections).toBeDefined();
    expect(repos.triggers).toBeDefined();
    expect(repos.usage).toBeDefined();
    expect(repos.operations).toBeDefined();
    expect(repos.metrics).toBeDefined();
  });

  describe("jobs repository", () => {
    it("returns a list of jobs", async () => {
      const jobs = await repos.jobs.list();
      expect(Array.isArray(jobs)).toBe(true);
      expect(jobs.length).toBeGreaterThan(0);
      expect(jobs[0].id).toBeTruthy();
      expect(jobs[0].status).toBeTruthy();
      expect(typeof jobs[0].createdAt).toBe("number");
      expect(typeof jobs[0].updatedAt).toBe("number");
    });

    it("returns a single job by ID", async () => {
      const jobs = await repos.jobs.list();
      const job = await repos.jobs.get(jobs[0].id);
      expect(job.id).toBe(jobs[0].id);
      expect(job.usage).toBeDefined();
      expect(typeof job.usage.totalTokens).toBe("number");
    });

    it("returns events for a job", async () => {
      const jobs = await repos.jobs.list();
      const events = await repos.jobs.events(jobs[0].id);
      expect(Array.isArray(events)).toBe(true);
      if (events.length > 0) {
        expect(typeof events[0].seq).toBe("number");
        expect(typeof events[0].timestamp).toBe("number");
        expect(events[0].jobId).toBe(jobs[0].id);
      }
    });

    it("returns usage for a job", async () => {
      const jobs = await repos.jobs.list();
      const usage = await repos.jobs.usage(jobs[0].id);
      expect(usage.jobId).toBe(jobs[0].id);
      expect(typeof usage.usage.inputTokens).toBe("number");
      expect(typeof usage.usage.totalTokens).toBe("number");
    });
  });

  describe("automation repository", () => {
    it("lists templates", async () => {
      const result = await repos.automation.templates.list();
      expect(result.templates).toBeDefined();
      expect(Array.isArray(result.templates)).toBe(true);
      expect(result.templates[0].templateId).toBeTruthy();
      expect(result.templates[0].status).toMatch(/active|archived/);
    });

    it("gets template versions", async () => {
      const { templates } = await repos.automation.templates.list();
      const { versions } = await repos.automation.templates.versions(templates[0].templateId);
      expect(Array.isArray(versions)).toBe(true);
      if (versions.length > 0) {
        expect(versions[0].version).toBeGreaterThan(0);
        expect(versions[0].definition).toBeDefined();
        expect(versions[0].definition.steps).toBeDefined();
        expect(Array.isArray(versions[0].definition.steps)).toBe(true);
        expect(versions[0].inputContract).toBeDefined();
        expect(Array.isArray(versions[0].inputContract.fields)).toBe(true);
      }
    });

    it("lists runs", async () => {
      const runs = await repos.automation.runs.list();
      expect(Array.isArray(runs)).toBe(true);
      expect(runs[0].runId).toBeTruthy();
      expect(typeof runs[0].runVersion).toBe("number");
      expect(runs[0].status).toBeTruthy();
    });

    it("gets run artifacts", async () => {
      const runs = await repos.automation.runs.list();
      const { artifacts } = await repos.automation.runs.artifacts(runs[0].runId);
      expect(Array.isArray(artifacts)).toBe(true);
    });

    it("gets run deliveries", async () => {
      const runs = await repos.automation.runs.list();
      const { deliveries } = await repos.automation.runs.deliveries(runs[0].runId);
      expect(Array.isArray(deliveries)).toBe(true);
    });
  });

  describe("schedules repository", () => {
    it("lists schedules", async () => {
      const { schedules } = await repos.schedules.list();
      expect(Array.isArray(schedules)).toBe(true);
      expect(schedules[0].scheduleId).toBeTruthy();
      expect(schedules[0].state).toMatch(/active|paused|cancelled/);
    });
  });

  describe("connections repository", () => {
    it("lists connections", async () => {
      const { connections } = await repos.connections.list();
      expect(Array.isArray(connections)).toBe(true);
      expect(connections[0].connectionId).toBeTruthy();
      expect(connections[0].provider).toBeTruthy();
      expect(connections[0].state).toBeTruthy();
      // Should never expose secretRef or secretFingerprint
      for (const conn of connections) {
        expect(conn).not.toHaveProperty("secretRef");
        expect(conn).not.toHaveProperty("secretFingerprint");
      }
    });

    it("lists capabilities", async () => {
      const { capabilities } = await repos.connections.capabilities();
      expect(Array.isArray(capabilities)).toBe(true);
    });
  });

  describe("triggers repository", () => {
    it("lists triggers", async () => {
      const { triggers } = await repos.triggers.list();
      expect(Array.isArray(triggers)).toBe(true);
      expect(triggers[0].triggerId).toBeTruthy();
      expect(triggers[0].triggerClass).toMatch(/webhook_event|schedule|manual|integration_event/);
      expect(triggers[0].state).toMatch(/enabled|disabled/);
    });
  });

  describe("usage repository", () => {
    it("returns cursor-paginated usage", async () => {
      const page = await repos.usage.list({ limit: 10 });
      expect(page.items).toBeDefined();
      expect(Array.isArray(page.items)).toBe(true);
      expect(typeof page.hasMore).toBe("boolean");
    });

    it("returns usage summary", async () => {
      const summary = await repos.usage.summary();
      expect(typeof summary.totalTokens).toBe("number");
      expect(typeof summary.totalRequests).toBe("number");
      expect(summary.byProvider).toBeDefined();
      expect(summary.byModel).toBeDefined();
    });
  });

  describe("operations repository", () => {
    it("returns retry status", async () => {
      const { items } = await repos.operations.retryStatus();
      expect(Array.isArray(items)).toBe(true);
    });

    it("returns health report", async () => {
      const health = await repos.operations.health();
      expect(health).toBeDefined();
      expect(health.health).toBeDefined();
    });

    it("returns dead letter items", async () => {
      const result = await repos.operations.deadLetter();
      expect(result.deadLetter).toBeDefined();
      expect(Array.isArray(result.deadLetter)).toBe(true);
    });
  });

  describe("metrics repository", () => {
    it("returns automation metrics", async () => {
      const metrics = await repos.metrics.get();
      expect(typeof metrics.totalRuns).toBe("number");
      expect(typeof metrics.completedRuns).toBe("number");
      expect(typeof metrics.successRate).toBe("number");
      expect(metrics.successRate).toBeGreaterThanOrEqual(0);
      expect(metrics.successRate).toBeLessThanOrEqual(1);
    });
  });
});

describe("Type safety: status unions", () => {
  it("all statuses are string literals from the expected set", async () => {
    const jobs = await mockRepositories.jobs.list();
    const validJobStatuses = new Set(["queued", "leased", "preparing", "running", "checkpointing", "suspended", "resuming", "completed", "failed", "cancelled"]);
    for (const job of jobs) {
      expect(validJobStatuses.has(job.status)).toBe(true);
    }
  });

  it("run statuses are valid", async () => {
    const runs = await mockRepositories.automation.runs.list();
    const validRunStatuses = new Set(["created", "validating_input", "admitted", "running", "collecting", "awaiting_approval", "delivering", "completed", "failed", "cancelled", "rejected", "suspended"]);
    for (const run of runs) {
      expect(validRunStatuses.has(run.status)).toBe(true);
    }
  });

  it("connection states are valid", async () => {
    const { connections } = await mockRepositories.connections.list();
    const validStates = new Set(["disconnected", "authorization_pending", "authorization_verified", "active", "degraded", "expired", "revoked"]);
    for (const conn of connections) {
      expect(validStates.has(conn.state)).toBe(true);
    }
  });

  it("trigger classes are valid", async () => {
    const { triggers } = await mockRepositories.triggers.list();
    const validClasses = new Set(["webhook_event", "schedule", "manual", "integration_event"]);
    for (const trigger of triggers) {
      expect(validClasses.has(trigger.triggerClass)).toBe(true);
    }
  });
});
