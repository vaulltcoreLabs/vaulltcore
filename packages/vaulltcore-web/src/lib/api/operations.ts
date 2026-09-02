import { apiRequest } from "./client";
import type {
  RetryStatusItem,
  DeadLetterItem,
  HealthReport,
  ReliabilityHealthReport,
  ReadinessReport,
  ReconciliationResult,
  TimeoutScanResult,
} from "@/types";

export const operationsApi = {
  async retryStatus(opts?: { kind?: string; state?: string }) {
    return apiRequest<{ items: RetryStatusItem[] }>("/operations/retry-status", {
      params: opts,
    });
  },

  async healthP2b() {
    return apiRequest<HealthReport>("/operations/health/p2b");
  },

  async healthReliability() {
    return apiRequest<ReliabilityHealthReport>("/operations/health/reliability");
  },

  async deadLetter() {
    return apiRequest<{
      items: RetryStatusItem[];
      deadLetter: DeadLetterItem[];
      dispatchDeadLetter: DeadLetterItem[];
    }>("/operations/dead-letter");
  },

  async redrive(id: string) {
    return apiRequest<unknown>(`/operations/dead-letter/${id}/redrive`, {
      method: "POST",
    });
  },

  async redriveDispatch(id: string) {
    return apiRequest<unknown>(`/operations/dispatches/${id}/redrive`, {
      method: "POST",
    });
  },

  async reconcile(all?: boolean) {
    return apiRequest<ReconciliationResult>("/operations/reconcile", {
      method: "POST",
      body: all ? { all: true } : {},
    });
  },

  async timeoutScan() {
    return apiRequest<TimeoutScanResult>("/operations/timeout-scan", {
      method: "POST",
    });
  },

  async readiness() {
    return apiRequest<ReadinessReport>("/readiness");
  },

  async metrics(opts?: { orgId?: string; projectId?: string }) {
    return apiRequest<Record<string, unknown>>("/automation/metrics", {
      params: opts,
    });
  },
};
