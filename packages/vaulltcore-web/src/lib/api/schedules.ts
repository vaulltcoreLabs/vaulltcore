import { apiRequest } from "./client";
import type { ScheduleView, OccurrenceView } from "@/types";

export const schedulesApi = {
  async list(opts?: { orgId?: string; projectId?: string }) {
    return apiRequest<{ schedules: ScheduleView[] }>("/automation/schedules", {
      params: opts,
    });
  },

  async get(scheduleId: string) {
    return apiRequest<ScheduleView>(`/automation/schedules/${scheduleId}`);
  },

  async create(body: {
    name: string;
    automationVersionId: string;
    kind: "one_time" | "recurring";
    cron?: string;
    scheduledAt?: number;
    timezone?: string;
    missedRunPolicy?: string;
    maxCatchUp?: number;
    input?: Record<string, unknown>;
  }) {
    return apiRequest<ScheduleView>("/automation/schedules", {
      method: "POST",
      body,
    });
  },

  async pause(scheduleId: string) {
    return apiRequest<ScheduleView>(`/automation/schedules/${scheduleId}/pause`, {
      method: "POST",
    });
  },

  async resume(scheduleId: string) {
    return apiRequest<ScheduleView>(`/automation/schedules/${scheduleId}/resume`, {
      method: "POST",
    });
  },

  async cancel(scheduleId: string) {
    return apiRequest<ScheduleView>(`/automation/schedules/${scheduleId}/cancel`, {
      method: "POST",
    });
  },

  async occurrences(scheduleId: string) {
    return apiRequest<{ occurrences: OccurrenceView[] }>(
      `/automation/schedules/${scheduleId}/occurrences`
    );
  },
};
