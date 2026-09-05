import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import type { AuthState, AuthUser } from "@/types";
import { identityApi } from "@/lib/api";

interface AuthContextValue extends AuthState {
  signIn: (user: AuthUser, permissions?: string[]) => void;
  signInWithApiKey: (apiKey: string) => Promise<void>;
  signOut: () => void;
  setDevHeaders: (tenant: string, org?: string, project?: string) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    isAuthenticated: false,
    isLoading: true,
    permissions: [],
  });

  useEffect(() => {
    let cancelled = false;
    let devHeader = false;

    const devHeaderAuth = import.meta.env.VITE_DEV_HEADER_AUTH === "true";
    if (devHeaderAuth) {
      const storedTenant = localStorage.getItem("vc-tenant");
      if (storedTenant) {
        devHeader = true;
        const storedOrg = localStorage.getItem("vc-org");
        setState({
          user: {
            principalId: "dev-user",
            tenantId: storedTenant,
            orgId: storedOrg || undefined,
          },
          isAuthenticated: true,
          isLoading: false,
          permissions: [],
        });
      }
    }

    if (!devHeader) {
      // Production auth: validate against the server (session cookie or
      // Bearer machine credential). A client-stored identity is never trusted..
      identityApi.me().then((me) => {
        if (cancelled) return;
        setState({
          user: {
            principalId: me.principalId,
            tenantId: me.tenantId,
            orgId: me.orgId || undefined,
          },
          isAuthenticated: true,
          isLoading: false,
          permissions: me.permissions ?? [],
        });
      }).catch(() => {
        if (cancelled) return;
        setState((s) => ({ ...s, isLoading: false }));
      });
    }

    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback((user: AuthUser, permissions: string[] = []) => {
    // Dev/header or programmatic flows: no persisted client-side session.

    setState({
      user,
      isAuthenticated: true,
      isLoading: false,
      permissions,
    });
  }, []);

  const signInWithApiKey = useCallback(async (apiKey: string) => {
    // Tab-scoped only; the key itself is a secret and must never land in
    // localStorage/URL/logs. The server verifies it; `me()` confirms identity..
    sessionStorage.setItem("vc-api-key", apiKey);
    try {
      const me = await identityApi.me();
      setState({
        user: {
          principalId: me.principalId,
          tenantId: me.tenantId,
          orgId: me.orgId || undefined,
        },
        isAuthenticated: true,
        isLoading: false,
        permissions: me.permissions ?? [],
      });
    } catch (error) {
      sessionStorage.removeItem("vc-api-key");
      throw error;
    }
  }, []);

  const signOut = useCallback(() => {
    sessionStorage.removeItem("vc-api-key");
    localStorage.removeItem("vc-user");
    localStorage.removeItem("vc-tenant");
    localStorage.removeItem("vc-org");
    localStorage.removeItem("vc-project");
    setState({
      user: null,
      isAuthenticated: false,
      isLoading: false,
      permissions: [],
    });
  }, []);

  const setDevHeaders = useCallback(
    (tenant: string, org?: string, project?: string) => {
      localStorage.setItem("vc-tenant", tenant);
      if (org) localStorage.setItem("vc-org", org);
      else localStorage.removeItem("vc-org");
      if (project) localStorage.setItem("vc-project", project);
      else localStorage.removeItem("vc-project");

      signIn({
        principalId: "dev-user",
        tenantId: tenant,
        orgId: org,
      });
    },
    [signIn]
  );

  return (
    <AuthContext.Provider value={{ ...state, signIn, signInWithApiKey, signOut, setDevHeaders }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!isAuthenticated) {
    // In header-auth dev mode, redirect to auth page for setup
    window.location.href = "/auth";
    return null;
  }

  return <>{children}</>;
}
