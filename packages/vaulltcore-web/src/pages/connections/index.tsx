import React from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge, Badge } from "@/components/ui/badge";
import { PageLayout, ConfirmDialog } from "@/components/layout";
import { formatRelativeTime } from "@/lib/formatting";
import {
  Plug,
  RefreshCw,
  Unplug,
  ExternalLink,
  GitBranch,
  MessageSquare,
  Cpu,
  Database,
  Bot,
} from "lucide-react";

const providerIcons: Record<string, React.ElementType> = {
  github: GitBranch,
  gitlab: GitBranch,
  linear: Bot,
  slack: MessageSquare,
  openai: Cpu,
  anthropic: Cpu,
  default: Plug,
};

const mockConnections = [
  {
    connectionId: "conn_01HXYZ111",
    provider: "github",
    family: "git",
    account: { externalId: "gh_123", displayName: "Vaulltcore Org" },
    capabilities: [{ name: "repos", description: "Repository access" }, { name: "prs", description: "Pull requests" }],
    state: "active",
    version: 2,
    lastUsedAt: Date.now() - 3600000,
    expiresAt: Date.now() + 2592000000,
    createdAt: Date.now() - 604800000,
  },
  {
    connectionId: "conn_01HXYZ222",
    provider: "slack",
    family: "messaging",
    account: { externalId: "sl_456", displayName: "#deploys" },
    capabilities: [{ name: "webhooks", description: "Send messages" }],
    state: "active",
    version: 1,
    lastUsedAt: Date.now() - 86400000,
    expiresAt: null,
    createdAt: Date.now() - 1296000000,
  },
  {
    connectionId: "conn_01HXYZ333",
    provider: "openai",
    family: "model",
    account: { externalId: "oai_789", displayName: "OpenAI BYOK" },
    capabilities: [{ name: "completions", description: "Chat completions" }],
    state: "active",
    version: 3,
    lastUsedAt: Date.now() - 120000,
    expiresAt: null,
    createdAt: Date.now() - 2592000000,
  },
  {
    connectionId: "conn_01HXYZ444",
    provider: "linear",
    family: "pm",
    account: { externalId: "ln_abc", displayName: "Linear Workspace" },
    capabilities: [{ name: "issues", description: "Issue tracking" }],
    state: "expired",
    version: 1,
    lastUsedAt: Date.now() - 604800000,
    expiresAt: Date.now() - 86400000,
    createdAt: Date.now() - 3888000000,
  },
];

const stateColors: Record<string, string> = {
  active: "bg-success/10 text-success",
  expired: "bg-warning/10 text-warning",
  degraded: "bg-warning/10 text-warning",
  revoked: "bg-destructive/10 text-destructive",
  disconnected: "bg-muted text-muted-foreground",
};

export default function ConnectionsPage() {
  const [disconnectId, setDisconnectId] = React.useState<string | null>(null);

  return (
    <PageLayout
      title="Connections"
      description="Manage integrations with external providers and services"
      actions={
        <Button>
          <Plug className="mr-2 h-4 w-4" />
          Add Connection
        </Button>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {mockConnections.map((conn) => {
          const ProviderIcon = providerIcons[conn.provider] || Plug;
          return (
            <Card key={conn.connectionId} className="transition-colors hover:bg-accent/30">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                      <ProviderIcon className="h-5 w-5" />
                    </div>
                    <div>
                      <CardTitle className="text-sm">{conn.provider}</CardTitle>
                      <CardDescription className="text-xs">
                        {conn.account.displayName}
                      </CardDescription>
                    </div>
                  </div>
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${stateColors[conn.state] || ""}`}>
                    {conn.state}
                  </span>
                </div>
              </CardHeader>
              <CardContent>
                <div className="mb-3 space-y-1.5 text-xs text-muted-foreground">
                  <div className="flex flex-wrap gap-1">
                    {conn.capabilities.map((cap) => (
                      <Badge key={cap.name} variant="secondary" className="text-[10px]">
                        {cap.name}
                      </Badge>
                    ))}
                  </div>
                  <div className="flex justify-between pt-1">
                    <span>Last used</span>
                    <span className="text-foreground">{conn.lastUsedAt ? formatRelativeTime(conn.lastUsedAt) : "—"}</span>
                  </div>
                  {conn.expiresAt && (
                    <div className="flex justify-between">
                      <span>Expires</span>
                      <span className={conn.expiresAt < Date.now() ? "text-warning" : "text-foreground"}>
                        {formatRelativeTime(conn.expiresAt)}
                      </span>
                    </div>
                  )}
                </div>
                <div className="flex gap-2">
                  {conn.state === "active" && (
                    <>
                      <Button size="sm" variant="outline" className="flex-1">
                        <RefreshCw className="mr-1 h-3 w-3" />
                        Refresh
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setDisconnectId(conn.connectionId)}
                      >
                        <Unplug className="h-3.5 w-3.5" />
                      </Button>
                    </>
                  )}
                  {conn.state === "expired" && (
                    <Button size="sm" variant="default" className="flex-1">
                      <RefreshCw className="mr-1 h-3 w-3" />
                      Reconnect
                    </Button>
                  )}
                  {(conn.state === "disconnected" || conn.state === "authorization_pending") && (
                    <Button size="sm" variant="default" className="flex-1">
                      <ExternalLink className="mr-1 h-3 w-3" />
                      Authorize
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <ConfirmDialog
        open={disconnectId !== null}
        onOpenChange={() => setDisconnectId(null)}
        title="Disconnect Integration"
        description="This will revoke the connection and stop all triggers depending on it. You can reconnect later."
        confirmLabel="Disconnect"
        variant="destructive"
        onConfirm={() => setDisconnectId(null)}
      />
    </PageLayout>
  );
}
