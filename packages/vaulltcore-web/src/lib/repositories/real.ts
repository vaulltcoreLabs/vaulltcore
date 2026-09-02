// Real API repository implementations using the typed API client
// These implement the same interfaces as mock repositories

import { jobsApi } from "@/lib/api/jobs";
import { automationApi } from "@/lib/api/automation";
import { schedulesApi } from "@/lib/api/schedules";
import { connectionsApi } from "@/lib/api/connections";
import { triggersApi } from "@/lib/api/triggers";
import { usageApi } from "@/lib/api/usage";
import { operationsApi } from "@/lib/api/operations";
import type { AppRepositories } from "./interfaces";

function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (typeof window !== "undefined") {
    const tenant = localStorage.getItem("vc-tenant");
    if (tenant) headers["x-vc-tenant"] = tenant;
    const org = localStorage.getItem("vc-org");
    if (org) headers["x-vc-org"] = org;
    const project = localStorage.getItem("vc-project");
    if (project) headers["x-vc-project"] = project;
  }
  return headers;
}

async function rawFetch<T>(path: string): Promise<T> {
  const response = await fetch(`${import.meta.env.VITE_API_BASE_URL || "http://localhost:3000"}${path}`, {
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    credentials: "include",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export const realRepositories: AppRepositories = {
  jobs: {
    async list() { return rawFetch("/jobs"); },
    async get(jobId) { return jobsApi.get(jobId); },
    async events(jobId, opts) { return jobsApi.events(jobId, opts); },
    async cancel(jobId) { return jobsApi.cancel(jobId); },
    async input(jobId, text) { return jobsApi.input(jobId, text); },
    async usage(jobId) { return jobsApi.usage(jobId); },
  },

  automation: {
    templates: {
      async list() { return automationApi.templates.list(); },
      async create(body) { return automationApi.templates.create(body); },
      async versions(templateId) { return automationApi.templates.versions(templateId); },
      async createVersion(templateId, body) { return automationApi.templates.createVersion(templateId, body); },
    },
    runs: {
      async list() { return rawFetch("/automation/runs"); },
      async get(runId) { return automationApi.runs.get(runId); },
      async events(runId, opts) { return automationApi.runs.events(runId, opts); },
      async artifacts(runId) { return automationApi.runs.artifacts(runId); },
      async deliveries(runId) { return automationApi.runs.deliveries(runId); },
      async advance(runId) { return automationApi.runs.advance(runId); },
      async cancel(runId) { return automationApi.runs.cancel(runId); },
    },
    approvals: {
      async approve(id, metadata) { return automationApi.approvals.approve(id, metadata); },
      async reject(id, metadata) { return automationApi.approvals.reject(id, metadata); },
      async requestChanges(id, metadata) { return automationApi.approvals.requestChanges(id, metadata); },
    },
  },

  schedules: {
    async list() { return schedulesApi.list(); },
    async get(scheduleId) { return schedulesApi.get(scheduleId); },
    async create(body) { return schedulesApi.create(body as Parameters<typeof schedulesApi.create>[0]); },
    async pause(scheduleId) { return schedulesApi.pause(scheduleId); },
    async resume(scheduleId) { return schedulesApi.resume(scheduleId); },
    async cancel(scheduleId) { return schedulesApi.cancel(scheduleId); },
    async occurrences(scheduleId) { return schedulesApi.occurrences(scheduleId); },
  },

  connections: {
    async capabilities() {
      const result = await connectionsApi.capabilities();
      return { capabilities: result.capabilities.map(c => ({ ...c, family: "other" })) };
    },
    async list() { return connectionsApi.list(); },
    async get(connectionId) { return connectionsApi.get(connectionId); },
    async create(body) { return connectionsApi.create(body as { provider: string; redirectUri: string }); },
    async reconnect(connectionId) { return connectionsApi.reconnect(connectionId, { redirectUri: window.location.origin }); },
    async refresh(connectionId) { return connectionsApi.refresh(connectionId); },
    async disconnect(connectionId) { return connectionsApi.disconnect(connectionId); },
  },

  triggers: {
    async list() { return triggersApi.list(); },
    async get(triggerId) { return triggersApi.get(triggerId); },
    async create(body) { return triggersApi.create(body as Parameters<typeof triggersApi.create>[0]); },
    async enable(triggerId) { return triggersApi.enable(triggerId); },
    async disable(triggerId) { return triggersApi.disable(triggerId); },
    async invoke(triggerId) { return triggersApi.invoke(triggerId); },
    async dispatch(dispatchId) { return triggersApi.getDispatch(dispatchId); },
  },

  usage: {
    async list(params) {
      return usageApi.list(params || { cursor: undefined, limit: 200 });
    },
    async summary(params) { return usageApi.summary(params); },
    async run(runId) { return usageApi.runUsage(runId); },
    async ledger(params) {
      return usageApi.ledger(params || { cursor: undefined, limit: 200 });
    },
  },

  operations: {
    async retryStatus() { return operationsApi.retryStatus(); },
    async health() { return operationsApi.healthReliability(); },
    async deadLetter() { return operationsApi.deadLetter(); },
    async redrive(id) { return operationsApi.redrive(id); },
    async dispatchRedrive(id) { return operationsApi.redriveDispatch(id); },
    async reconcile() { return operationsApi.reconcile(); },
    async timeoutScan() { return operationsApi.timeoutScan(); },
    async readiness() { return operationsApi.readiness(); },
  },

  metrics: {
    async get() { return rawFetch("/automation/metrics"); },
  },
};
