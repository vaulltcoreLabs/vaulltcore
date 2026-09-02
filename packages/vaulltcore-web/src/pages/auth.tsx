import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/lib/auth";

export default function AuthPage() {
  const { isAuthenticated, setDevHeaders } = useAuth();
  const navigate = useNavigate();
  const [tenant, setTenant] = useState("vaulltcore-dev");
  const [org, setOrg] = useState("default");
  const [project, setProject] = useState("");

  // Redirect if already authenticated
  React.useEffect(() => {
    if (isAuthenticated) {
      navigate("/dashboard", { replace: true });
    }
  }, [isAuthenticated, navigate]);

  const handleDevAuth = (e: React.FormEvent) => {
    e.preventDefault();
    setDevHeaders(tenant, org || undefined, project || undefined);
    navigate("/dashboard");
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-md space-y-6">
        {/* Logo */}
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground font-bold text-xl">
            V
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Vaulltcore</h1>
          <p className="text-sm text-muted-foreground">AI Engineering Automation</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Sign In</CardTitle>
            <CardDescription>
              Configure your development environment credentials.
              Production authentication uses Better Auth session cookies.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleDevAuth} className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Tenant ID</label>
                <Input
                  value={tenant}
                  onChange={(e) => setTenant(e.target.value)}
                  placeholder="vaulltcore-dev"
                  required
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Org ID (optional)</label>
                <Input
                  value={org}
                  onChange={(e) => setOrg(e.target.value)}
                  placeholder="default"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Project ID (optional)</label>
                <Input
                  value={project}
                  onChange={(e) => setProject(e.target.value)}
                  placeholder="project_vt_01"
                />
              </div>
              <Button type="submit" className="w-full">
                Continue with Dev Headers
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                In development mode, tenant identity is set via HTTP headers.
                <br />
                Production uses Better Auth session cookies (not yet mounted).
              </p>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
