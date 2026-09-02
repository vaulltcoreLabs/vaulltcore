import { apiRequest } from "./client";
import type {
  ResolvedPrincipal,
  OrganizationMembership,
  OrgMember,
  ServiceIdentity,
  MachineCredential,
  CredentialIssuance,
  Session,
} from "@/types";

export const identityApi = {
  async me() {
    return apiRequest<ResolvedPrincipal>("/identity/me");
  },

  async permissions() {
    return apiRequest<{ permissions: string[] }>("/identity/permissions");
  },

  async orgs() {
    return apiRequest<{ organizations: OrganizationMembership[] }>(
      "/identity/orgs"
    );
  },

  members: {
    async list(orgId: string) {
      return apiRequest<{ members: OrgMember[] }>(
        `/identity/orgs/${orgId}/members`
      );
    },

    async add(orgId: string, body: { userId: string; role: string; projects?: string[] }) {
      return apiRequest<OrgMember>(`/identity/orgs/${orgId}/members`, {
        method: "POST",
        body,
      });
    },

    async updateRole(orgId: string, principalId: string, body: { role: string }) {
      return apiRequest<{ principalId: string; role: string }>(
        `/identity/orgs/${orgId}/members/${principalId}`,
        { method: "PATCH", body }
      );
    },

    async remove(orgId: string, principalId: string) {
      return apiRequest<{ removed: boolean }>(
        `/identity/orgs/${orgId}/members/${principalId}`,
        { method: "DELETE" }
      );
    },
  },

  serviceIdentities: {
    async list() {
      return apiRequest<{ serviceIdentities: ServiceIdentity[] }>(
        "/identity/service-identities"
      );
    },

    async create(body: { name: string; permissions: string[]; projects?: string[] }) {
      return apiRequest<ServiceIdentity>("/identity/service-identities", {
        method: "POST",
        body,
      });
    },

    async disable(id: string) {
      return apiRequest<ServiceIdentity>(
        `/identity/service-identities/${id}/disable`,
        { method: "POST" }
      );
    },

    async enable(id: string) {
      return apiRequest<ServiceIdentity>(
        `/identity/service-identities/${id}/enable`,
        { method: "POST" }
      );
    },

    async revoke(id: string) {
      return apiRequest<ServiceIdentity>(
        `/identity/service-identities/${id}/revoke`,
        { method: "POST" }
      );
    },

    async createCredential(id: string, body?: { expiresInMs?: number }) {
      return apiRequest<CredentialIssuance>(
        `/identity/service-identities/${id}/credentials`,
        { method: "POST", body: body || {} }
      );
    },

    async listCredentials(id: string) {
      return apiRequest<{ credentials: MachineCredential[] }>(
        `/identity/service-identities/${id}/credentials`
      );
    },
  },

  credentials: {
    async revoke(credentialId: string) {
      return apiRequest<MachineCredential>(
        `/identity/credentials/${credentialId}/revoke`,
        { method: "POST" }
      );
    },
  },

  sessions: {
    async list() {
      return apiRequest<{ sessions: Session[] }>("/identity/sessions");
    },

    async revokeAll() {
      return apiRequest<{ revoked: number }>("/identity/sessions/revoke", {
        method: "POST",
      });
    },
  },

  users: {
    async disable(userId: string) {
      return apiRequest<{ userId: string; status: string; revokedSessions: number }>(
        `/identity/users/${userId}/disable`,
        { method: "POST" }
      );
    },

    async revokeSessions(userId: string) {
      return apiRequest<{ revoked: number }>(
        `/identity/users/${userId}/revoke-sessions`,
        { method: "POST" }
      );
    },
  },
};
