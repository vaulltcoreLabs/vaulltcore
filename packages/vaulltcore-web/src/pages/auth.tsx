import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/lib/auth";

const devHeaderAuth = import.meta.env.VITE_DEV_HEADER_AUTH === "true";

export default function AuthPage() {
  const { isAuthenticated, signInWithApiKey, setDevHeaders } = useAuth();
  const navigate = useNavigate();
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [tenant, setTenant] = useState("vaulltcore-dev");
  const [org, setOrg] = useState("default");
  const [project, setProject] = useState("");

  React.useEffect(() => {
    if (isAuthenticated) {
      navigate("/dashboard", { replace: true });
    }
  }, [isAuthenticated, navigate]);

  const handleApiKeyAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await signInWithApiKey(apiKey.trim());
      navigate("/dashboard", { replace: true });
    } catch {
      setError("Invalid or expired API key. Contact your administrator to mint a machine credential for this environment.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDevAuth = (e: React.FormEvent) => {
    e.preventDefault();
    setDevHeaders(tenant, org || undefined, project || undefined);
    navigate("/dashboard");
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-md space-y-6">
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
              Machine credentials are verified by the server. Session-cookie sign-in
              appears here when Better Auth is configured.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleApiKeyAuth} className="space-y-4">
              <div className="space-y-2">
                <label htmlFor="api-key" className="text-sm font-medium">API Key</label>
                <Input
                  id="api-key"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="vc_live_..."
                  required
                  autoComplete="off"
                />
              </div>
              {error ? (
                <p role="alert" className="text-sm text-destructive">{error}</p>
              ) : null}
              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting ? "Signing in..." : "Sign in with Machine Key"}
              </Button>
            </form>

            {devHeaderAuth ? (
              <form onSubmit={handleDevAuth} className="mt-6 space-y-4 border-t pt-4">
                <p className="text-sm font-medium">Development header auth</p>
                <Input
                  value={tenant}
                  onChange={(e) => setTenant(e.target.value)}
                  placeholder="vaulltcore-dev"
                />
                <Input
                  value={org}
                  onChange={(e) => setOrg(e.target.value)}
                  placeholder="default"
                />
                <Input
                  value={project}
                  onChange={(e) => setProject(e.target.value)}
                  placeholder="project_vt_01"
                />
                <Button type="submit" variant="outline" className="w-full">
                  Continue with Dev Headers
                </Button>
              </form>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}