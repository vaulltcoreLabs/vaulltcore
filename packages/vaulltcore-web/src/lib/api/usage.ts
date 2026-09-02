import { apiRequest } from "./client";
import type { UsagePage, UsageAggregate, UsageSummary, CursorPagination } from "@/types";

export const usageApi = {
  async list(pagination: CursorPagination & {
    from?: number;
    to?: number;
    kind?: string;
    provider?: string;
    model?: string;
    runId?: string;
  }) {
    return apiRequest<UsagePage>("/usage", { params: pagination as Record<string, string | number | undefined> });
  },

  async summary(opts?: { from?: number; to?: number; kind?: string; provider?: string; model?: string }) {
    return apiRequest<UsageSummary>("/usage/summary", { params: opts as Record<string, string | number | undefined> });
  },

  async runUsage(runId: string) {
    return apiRequest<UsageAggregate>(`/usage/runs/${runId}`);
  },

  async ledger(pagination: CursorPagination) {
    return apiRequest<UsagePage>("/usage/ledger", {
      params: pagination as Record<string, string | number | undefined>,
    });
  },
};
