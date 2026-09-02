import { apiRequest } from "./client";
import type {
  AutomationTemplate,
  AutomationVersion,
  AutomationRun,
  AutomationEvent,
  AutomationArtifact,
  ApprovalRequest,
  SanitizedDelivery,
} from "@/types";
import { generateIdempotencyKey } from "@/lib/idempotency";

export const automationApi = {
  templates: {
    async list(opts?: { orgId?: string; projectId?: string }) {
      return apiRequest<{ templates: AutomationTemplate[] }>(
        "/automation/templates",
        { params: opts }
      );
    },

    async create(body: {
      name: string;
      description?: string;
      orgId?: string;
      projectId?: string;
    }) {
      return apiRequest<AutomationTemplate>("/automation/templates", {
        method: "POST",
        body,
      });
    },

    async versions(templateId: string) {
      return apiRequest<{ versions: AutomationVersion[] }>(
        `/automation/templates/${templateId}/versions`
      );
    },

    async createVersion(
      templateId: string,
      body: {
        definition: AutomationVersion["definition"];
        inputContract: AutomationVersion["inputContract"];
      }
    ) {
      return apiRequest<AutomationVersion>(
        `/automation/templates/${templateId}/versions`,
        { method: "POST", body }
      );
    },
  },

  runs: {
    async create(body: {
      templateId: string;
      versionId: string;
      input: Record<string, unknown>[];
      orgId?: string;
      projectId?: string;
    }) {
      const key = generateIdempotencyKey(`run-create-${body.templateId}-${Date.now()}`);
      return apiRequest<AutomationRun>("/automation/runs", {
        method: "POST",
        body,
        idempotencyKey: key,
      });
    },

    async get(runId: string) {
      return apiRequest<AutomationRun>(`/automation/runs/${runId}`);
    },

    async events(runId: string, opts?: { after?: number }) {
      return apiRequest<{ events: AutomationEvent[] }>(
        `/automation/runs/${runId}/events`,
        { params: opts }
      );
    },

    async artifacts(runId: string) {
      return apiRequest<{ artifacts: AutomationArtifact[] }>(
        `/automation/runs/${runId}/artifacts`
      );
    },

    async deliveries(runId: string) {
      return apiRequest<{ deliveries: SanitizedDelivery[] }>(
        `/automation/runs/${runId}/deliveries`
      );
    },

    async advance(runId: string) {
      return apiRequest<AutomationRun>(`/automation/runs/${runId}/advance`, {
        method: "POST",
      });
    },

    async cancel(runId: string) {
      return apiRequest<AutomationRun>(`/automation/runs/${runId}/cancel`, {
        method: "POST",
      });
    },
  },

  approvals: {
    async approve(id: string, metadata?: Record<string, unknown>) {
      return apiRequest<{ approval: ApprovalRequest; run: AutomationRun }>(
        `/automation/approvals/${id}/approve`,
        { method: "POST", body: { metadata } }
      );
    },

    async reject(id: string, metadata?: Record<string, unknown>) {
      return apiRequest<{ approval: ApprovalRequest; run: AutomationRun }>(
        `/automation/approvals/${id}/reject`,
        { method: "POST", body: { metadata } }
      );
    },

    async requestChanges(id: string, metadata?: Record<string, unknown>) {
      return apiRequest<{ approval: ApprovalRequest; run: AutomationRun }>(
        `/automation/approvals/${id}/changes`,
        { method: "POST", body: { metadata } }
      );
    },
  },
};
