import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageLayout, ConfirmDialog } from "@/components/layout";
import { formatRelativeTime, formatDateTime } from "@/lib/formatting";
import { Plus, Clock, Pause, Play, XCircle, Calendar } from "lucide-react";

const mockSchedules = [
  {
    scheduleId: "sch_01HXYZ111",
    name: "Nightly Build",
    kind: "recurring",
    cron: "0 2 * * *",
    timezone: "UTC",
    state: "active",
    version: 5,
    lastAdmittedAt: Date.now() - 86400000,
    createdAt: Date.now() - 604800000,
    templateName: "Deploy to Staging",
  },
  {
    scheduleId: "sch_01HXYZ222",
    name: "Weekly Security Scan",
    kind: "recurring",
    cron: "0 6 * * 1",
    timezone: "America/New_York",
    state: "active",
    version: 3,
    lastAdmittedAt: Date.now() - 2592000000,
    createdAt: Date.now() - 1209600000,
    templateName: "E2E Test Suite",
  },
  {
    scheduleId: "sch_01HXYZ333",
    name: "Data Sync",
    kind: "recurring",
    cron: "*/30 * * * *",
    timezone: "UTC",
    state: "paused",
    version: 2,
    lastAdmittedAt: Date.now() - 86400000,
    createdAt: Date.now() - 2592000000,
    templateName: "PR Review Automation",
  },
];

export default function SchedulesPage() {
  const [confirmAction, setConfirmAction] = React.useState<{
    type: "pause" | "resume" | "cancel";
    scheduleId: string;
    name: string;
  } | null>(null);

  return (
    <PageLayout
      title="Schedules"
      description="Manage recurring and one-time automation schedules"
      actions={
        <Button>
          <Plus className="mr-2 h-4 w-4" />
          New Schedule
        </Button>
      }
    >
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Template</TableHead>
                <TableHead>Schedule</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Last Run</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {mockSchedules.map((schedule) => (
                <TableRow key={schedule.scheduleId}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Clock className="h-4 w-4 text-muted-foreground" />
                      <span className="font-medium">{schedule.name}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">{schedule.templateName}</TableCell>
                  <TableCell>
                    <div>
                      <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
                        {schedule.cron}
                      </code>
                      <p className="mt-0.5 text-xs text-muted-foreground">{schedule.timezone}</p>
                    </div>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={schedule.state} />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {schedule.lastAdmittedAt
                      ? formatRelativeTime(schedule.lastAdmittedAt)
                      : "—"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatRelativeTime(schedule.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      {schedule.state === "active" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            setConfirmAction({ type: "pause", scheduleId: schedule.scheduleId, name: schedule.name })
                          }
                        >
                          <Pause className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      {schedule.state === "paused" && (
                        <Button variant="ghost" size="sm">
                          <Play className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      {schedule.state !== "cancelled" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={() =>
                            setConfirmAction({ type: "cancel", scheduleId: schedule.scheduleId, name: schedule.name })
                          }
                        >
                          <XCircle className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmAction !== null}
        onOpenChange={() => setConfirmAction(null)}
        title={`${confirmAction?.type === "cancel" ? "Cancel" : confirmAction?.type === "pause" ? "Pause" : "Resume"} Schedule`}
        description={`Are you sure you want to ${confirmAction?.type} "${confirmAction?.name}"? ${confirmAction?.type === "cancel" ? "This action cannot be undone." : ""}`}
        confirmLabel={confirmAction?.type === "cancel" ? "Cancel Schedule" : confirmAction?.type === "pause" ? "Pause" : "Resume"}
        variant={confirmAction?.type === "cancel" ? "destructive" : "default"}
        onConfirm={() => setConfirmAction(null)}
      />
    </PageLayout>
  );
}
