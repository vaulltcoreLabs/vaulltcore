import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import type { AuthState, AuthUser } from "@/types";
import { identityApi } from "@/lib/api";

interface AuthContextValue extends AuthState {
  signIn: (user: AuthUser, permissions?: string[]) => void;
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

  // Check for existing auth on mount
  useEffect(() => {
    const storedTenant = localStorage.getItem("vc-tenant");
    const storedOrg = localStorage.getItem("vc-org");
    const storedUser = localStorage.getItem("vc-user");

    if (storedUser) {
      try {
        const user = JSON.parse(storedUser) as AuthUser;
        setState({
          user,
          isAuthenticated: true,
          isLoading: false,
          permissions: [],
        });
      } catch {
        setState((s) => ({ ...s, isLoading: false }));
      }
    } else if (storedTenant) {
      // Header-auth dev mode — create synthetic user
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
    } else {
      setState((s) => ({ ...s, isLoading: false }));
    }
  }, []);

  const signIn = useCallback((user: AuthUser, permissions: string[] = []) => {
    localStorage.setItem("vc-user", JSON.stringify(user));
    localStorage.setItem("vc-tenant", user.tenantId);
    if (user.orgId) localStorage.setItem("vc-org", user.orgId);
    setState({
      user,
      isAuthenticated: true,
      isLoading: false,
      permissions,
    });
  }, []);

  const signOut = useCallback(() => {
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
    <AuthContext.Provider value={{ ...state, signIn, signOut, setDevHeaders }}>
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
