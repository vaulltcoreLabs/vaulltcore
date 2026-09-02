import { apiRequest } from "./client";
import type { ConnectionView, ConnectionCapability } from "@/types";

export const connectionsApi = {
  async capabilities() {
    return apiRequest<{ capabilities: ConnectionCapability[] }>(
      "/integrations/capabilities"
    );
  },

  async list(opts?: { family?: string }) {
    return apiRequest<{ connections: ConnectionView[] }>("/connections", {
      params: opts,
    });
  },

  async get(connectionId: string) {
    return apiRequest<ConnectionView>(`/connections/${connectionId}`);
  },

  async create(body: {
    provider: string;
    redirectUri: string;
    method?: string;
    scopes?: string[];
    codeVerifier?: string;
  }) {
    return apiRequest<{
      attemptId: string;
      state: string;
      authorizeUrl: string;
      codeChallenge: string;
    }>("/connections", { method: "POST", body });
  },

  async reconnect(
    connectionId: string,
    body: { redirectUri: string }
  ) {
    return apiRequest<{
      attemptId: string;
      state: string;
      authorizeUrl: string;
    }>(`/connections/${connectionId}/reconnect`, {
      method: "POST",
      body,
    });
  },

  async refresh(connectionId: string) {
    return apiRequest<ConnectionView>(`/connections/${connectionId}/refresh`, {
      method: "POST",
    });
  },

  async disconnect(connectionId: string) {
    return apiRequest<ConnectionView>(`/connections/${connectionId}/disconnect`, {
      method: "POST",
    });
  },
};
