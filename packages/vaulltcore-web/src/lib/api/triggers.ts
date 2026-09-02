import { apiRequest } from "./client";
import type { TriggerView, TriggerDispatch } from "@/types";

export const triggersApi = {
  async list() {
    return apiRequest<{ triggers: TriggerView[] }>("/triggers");
  },

  async get(triggerId: string) {
    return apiRequest<TriggerView>(`/triggers/${triggerId}`);
  },

  async create(body: {
    templateId: string;
    versionId: string;
    name: string;
    triggerClass: string;
    criteria?: Record<string, unknown>;
    scheduleId?: string;
    inputMapping?: Record<string, unknown>;
    state?: string;
  }) {
    return apiRequest<TriggerView>("/triggers", { method: "POST", body });
  },

  async enable(triggerId: string) {
    return apiRequest<TriggerView>(`/triggers/${triggerId}/enable`, {
      method: "POST",
    });
  },

  async disable(triggerId: string) {
    return apiRequest<TriggerView>(`/triggers/${triggerId}/disable`, {
      method: "POST",
    });
  },

  async invoke(triggerId: string) {
    return apiRequest<{ dispatches: TriggerDispatch[]; runIds: string[] }>(
      `/triggers/${triggerId}/invoke`,
      { method: "POST" }
    );
  },

  async getDispatch(dispatchId: string) {
    return apiRequest<TriggerDispatch>(`/triggers/dispatches/${dispatchId}`);
  },
};
