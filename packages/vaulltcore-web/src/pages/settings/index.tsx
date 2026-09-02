import React from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageLayout } from "@/components/layout";
import { formatRelativeTime } from "@/lib/formatting";
import { Settings, Users, Bot, Key, Shield } from "lucide-react";

export default function SettingsPage() {
  return (
    <PageLayout title="Settings" description="Manage organization, identity, and platform settings">
      <div className="grid gap-6">
        {/* Organization Card */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <Settings className="h-5 w-5 text-primary" />
              </div>
              <div>
                <CardTitle>Organization</CardTitle>
                <CardDescription>Organization identity and configuration</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="rounded-lg border p-4 text-sm">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <p className="text-xs text-muted-foreground">Organization ID</p>
                  <p className="font-mono text-sm">org_vt_01HXYZ</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Tenant</p>
                  <p className="font-mono text-sm">tenant_vt_01</p>
                </div>
              </div>
              <div className="mt-4">
                <p className="text-xs text-muted-foreground mb-2">Note</p>
                <p className="text-xs text-muted-foreground">
                  Organization and project creation are not currently supported by the backend.
                  This section displays existing organization data only.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Quick Links */}
        <div className="grid gap-4 sm:grid-cols-3">
          <Card className="transition-colors hover:bg-accent/30 cursor-pointer">
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <Users className="h-5 w-5 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">Members</p>
                  <p className="text-xs text-muted-foreground">Manage team access and roles</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="transition-colors hover:bg-accent/30 cursor-pointer">
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <Bot className="h-5 w-5 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">Service Identities</p>
                  <p className="text-xs text-muted-foreground">Machine accounts and API access</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="transition-colors hover:bg-accent/30 cursor-pointer">
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <Shield className="h-5 w-5 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">Sessions</p>
                  <p className="text-xs text-muted-foreground">Active sessions and revocation</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </PageLayout>
  );
}
