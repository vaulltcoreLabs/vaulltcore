import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge, Badge } from "@/components/ui/badge";
import { PageLayout } from "@/components/layout";
import { formatRelativeTime } from "@/lib/formatting";
import { Plus, Bell, Webhook, Calendar, Hand, Zap, Play, Eye } from "lucide-react";

const triggerClassIcons: Record<string, React.ElementType> = {
  webhook_event: Webhook,
  schedule: Calendar,
  manual: Hand,
  integration_event: Zap,
};

const triggerClassLabels: Record<string, string> = {
  webhook_event: "Webhook",
  schedule: "Schedule",
  manual: "Manual",
  integration_event: "Integration",
};

const mockTriggers = [
  {
    triggerId: "trg_01HXYZ111",
    name: "GitHub PR Webhook",
    triggerClass: "webhook_event",
    templateName: "PR Review Automation",
    version: 7,
    state: "enabled",
    revision: 4,
    createdAt: Date.now() - 604800000,
    updatedAt: Date.now() - 86400000,
  },
  {
    triggerId: "trg_01HXYZ222",
    name: "Manual Deploy Trigger",
    triggerClass: "manual",
    templateName: "Deploy to Staging",
    version: 3,
    state: "enabled",
    revision: 1,
    createdAt: Date.now() - 2592000000,
    updatedAt: Date.now() - 2592000000,
  },
  {
    triggerId: "trg_01HXYZ333",
    name: "Linear Issue Update",
    triggerClass: "integration_event",
    templateName: "E2E Test Suite",
    version: 5,
    state: "disabled",
    revision: 2,
    createdAt: Date.now() - 1296000000,
    updatedAt: Date.now() - 604800000,
  },
];

export default function TriggersPage() {
  return (
    <PageLayout
      title="Triggers"
      description="Automate runs based on webhooks, schedules, integrations, or manual invocation"
      actions={
        <Button>
          <Plus className="mr-2 h-4 w-4" />
          New Trigger
        </Button>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {mockTriggers.map((trigger) => {
          const ClassIcon = triggerClassIcons[trigger.triggerClass] || Bell;
          return (
            <Card key={trigger.triggerId} className={`transition-colors hover:bg-accent/30 ${trigger.state === "disabled" ? "opacity-60" : ""}`}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10">
                      <ClassIcon className="h-4 w-4 text-primary" />
                    </div>
                    <div>
                      <CardTitle className="text-sm">{trigger.name}</CardTitle>
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <Badge variant="outline" className="text-[10px]">
                      {triggerClassLabels[trigger.triggerClass]}
                    </Badge>
                    <StatusBadge status={trigger.state} />
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-2 text-xs text-muted-foreground">
                  <div className="flex justify-between">
                    <span>Template</span>
                    <span className="text-foreground">{trigger.templateName}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Version</span>
                    <span className="font-mono">v{trigger.version}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Revision</span>
                    <span className="font-mono">{trigger.revision}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Updated</span>
                    <span>{formatRelativeTime(trigger.updatedAt)}</span>
                  </div>
                </div>
                <div className="mt-4 flex gap-2">
                  {trigger.state === "enabled" && trigger.triggerClass === "manual" && (
                    <Button size="sm" variant="default" className="flex-1">
                      <Play className="mr-1 h-3 w-3" />
                      Invoke
                    </Button>
                  )}
                  <Button size="sm" variant="outline" className="flex-1">
                    {trigger.state === "enabled" ? "Disable" : "Enable"}
                  </Button>
                  <Button size="sm" variant="ghost">
                    <Eye className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </PageLayout>
  );
}
