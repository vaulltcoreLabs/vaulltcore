import { apiRequest } from "./client";
import type { JobView, JobEvent } from "@/types";
import { generateIdempotencyKey } from "@/lib/idempotency";

export const jobsApi = {
  async list(): Promise<JobView[]> {
    return apiRequest("/jobs");
  },

  async create(input: {
    engine: string;
    model: string;
    input: string;
    policy?: Record<string, unknown>;
    projectId?: string;
    metadata?: Record<string, unknown>;
  }, options?: { idempotencyKey?: string }): Promise<{ id: string; reservationId: string; status: string }> {
    const key = options?.idempotencyKey ?? generateIdempotencyKey(`job-create:${input.engine}:${input.model}:${input.input}`);
    return apiRequest("/jobs", {
      method: "POST",
      body: {
        spec: {
          engine: input.engine,
          model: input.model,
          input: input.input,
        },
        policy: input.policy,
        projectId: input.projectId,
        metadata: input.metadata,
      },
      idempotencyKey: key,
    });
  },

  async get(jobId: string): Promise<JobView> {
    return apiRequest(`/jobs/${jobId}`);
  },

  async events(
    jobId: string,
    opts?: { after?: number; follow?: boolean }
  ): Promise<JobEvent[]> {
    return apiRequest(`/jobs/${jobId}/events`, {
      params: {
        after: opts?.after,
        follow: opts?.follow ? "true" : undefined,
      },
    });
  },

  async cancel(jobId: string): Promise<{ status: string }> {
    return apiRequest(`/jobs/${jobId}/cancel`, { method: "POST" });
  },

  async input(jobId: string, text: string): Promise<{ status: string }> {
    return apiRequest(`/jobs/${jobId}/input`, {
      method: "POST",
      body: { text },
    });
  },

  async usage(
    jobId: string
  ): Promise<{ jobId: string; usage: Record<string, number> }> {
    return apiRequest(`/jobs/${jobId}/usage`);
  },
};
