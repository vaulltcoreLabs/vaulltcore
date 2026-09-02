import React from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge, Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageLayout, ConfirmDialog } from "@/components/layout";
import { formatRelativeTime } from "@/lib/formatting";
import {
  Activity,
  AlertTriangle,
  RefreshCcw,
  Clock,
  ShieldCheck,
  Zap,
  Play,
} from "lucide-react";

const mockHealth = {
  unresolvedUsage: 0,
  unresolvedPricing: 2,
  orphanedReservations: 0,
  settlementBacklog: 1,
  snapshotGcBacklog: 0,
  lastWatermark: Date.now() - 120000,
};

const mockRetryItems = [
  { workId: "ops_001", kind: "delivery_retry", state: "pending", attempts: 2, nextRetryAt: Date.now() + 300000, lastError: "Provider returned 503" },
  { workId: "ops_002", kind: "approval_expiry", state: "pending", attempts: 1, nextRetryAt: Date.now() + 86400000, lastError: null },
];

const mockDeadLetter = [
  { workId: "ops_003", kind: "delivery_retry", state: "dead_letter", attempts: 5, lastError: "Endpoint unreachable after 5 attempts" },
  { workId: "dsp_001", kind: "trigger_dispatch", state: "dead_letter", attempts: 3, lastError: "Invalid trigger configuration" },
];

export default function OperationsPage() {
  const [confirmAction, setConfirmAction] = React.useState<string | null>(null);
  const [actionLoading, setActionLoading] = React.useState(false);

  const handleAction = async (action: string) => {
    setActionLoading(true);
    // Simulate API call
    await new Promise((r) => setTimeout(r, 1000));
    setActionLoading(false);
    setConfirmAction(null);
  };

  return (
    <PageLayout
      title="Operations"
      description="System health, retry queues, dead letter, and administrative recovery actions"
    >
      {/* System Health */}
      <div className="mb-8">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <ShieldCheck className="h-4 w-4" />
          System Health
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <HealthCard label="Unresolved Usage" value={mockHealth.unresolvedUsage} status={mockHealth.unresolvedUsage === 0 ? "healthy" : "warning"} />
          <HealthCard label="Unresolved Pricing" value={mockHealth.unresolvedPricing} status={mockHealth.unresolvedPricing === 0 ? "healthy" : "warning"} />
          <HealthCard label="Orphaned Reservations" value={mockHealth.orphanedReservations} status={mockHealth.orphanedReservations === 0 ? "healthy" : "warning"} />
          <HealthCard label="Settlement Backlog" value={mockHealth.settlementBacklog} status={mockHealth.settlementBacklog === 0 ? "healthy" : "warning"} />
          <HealthCard label="Snapshot GC Backlog" value={mockHealth.snapshotGcBacklog} status="healthy" />
          <Card>
            <CardContent className="p-4">
              <p className="text-xs font-medium text-muted-foreground">Last Watermark</p>
              <p className="mt-1 text-lg font-bold">{mockHealth.lastWatermark ? formatRelativeTime(mockHealth.lastWatermark) : "—"}</p>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Admin Actions */}
      <div className="mb-8 grid gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Reconciliation</p>
                <p className="text-xs text-muted-foreground">Scan and repair projection gaps</p>
              </div>
              <Button size="sm" onClick={() => setConfirmAction("reconcile")}>
                <RefreshCcw className="mr-1 h-3.5 w-3.5" />
                Run
              </Button>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Timeout Scan</p>
                <p className="text-xs text-muted-foreground">Scan for timed-out runs and leases</p>
              </div>
              <Button size="sm" onClick={() => setConfirmAction("timeout")}>
                <Clock className="mr-1 h-3.5 w-3.5" />
                Scan
              </Button>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Readiness Check</p>
                <p className="text-xs text-muted-foreground">Verify system readiness status</p>
              </div>
              <Button size="sm" variant="outline" onClick={() => setConfirmAction("readiness")}>
                <Activity className="mr-1 h-3.5 w-3.5" />
                Check
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Retry Queue */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Retry Queue</CardTitle>
          <CardDescription>Items pending retry with backoff</CardDescription>
        </CardHeader>
        <CardContent>
          {mockRetryItems.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No items in retry queue</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Attempts</TableHead>
                  <TableHead>Next Retry</TableHead>
                  <TableHead>Last Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mockRetryItems.map((item) => (
                  <TableRow key={item.workId}>
                    <TableCell className="font-mono text-xs">{item.workId}</TableCell>
                    <TableCell><Badge variant="outline">{item.kind}</Badge></TableCell>
                    <TableCell className="font-mono">{item.attempts}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {item.nextRetryAt ? formatRelativeTime(item.nextRetryAt) : "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">
                      {item.lastError || "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Dead Letter */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            Dead Letter Queue
          </CardTitle>
          <CardDescription>Exhausted items requiring manual intervention</CardDescription>
        </CardHeader>
        <CardContent>
          {mockDeadLetter.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No dead-lettered items</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Attempts</TableHead>
                  <TableHead>Last Error</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mockDeadLetter.map((item) => (
                  <TableRow key={item.workId}>
                    <TableCell className="font-mono text-xs">{item.workId}</TableCell>
                    <TableCell><Badge variant="destructive">{item.kind}</Badge></TableCell>
                    <TableCell className="font-mono">{item.attempts}</TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">
                      {item.lastError}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setConfirmAction(`redrive:${item.workId}`)}
                      >
                        <Play className="mr-1 h-3 w-3" />
                        Redrive
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmAction !== null}
        onOpenChange={() => setConfirmAction(null)}
        title={`Confirm ${confirmAction?.startsWith("redrive") ? "Redrive" : confirmAction === "reconcile" ? "Reconciliation" : confirmAction === "timeout" ? "Timeout Scan" : "Action"}`}
        description={
          confirmAction?.startsWith("redrive")
            ? "This will re-attempt the dead-lettered item. Ensure the underlying issue has been addressed first."
            : confirmAction === "reconcile"
            ? "This will scan for projection gaps and attempt safe repairs. This is idempotent and safe to run multiple times."
            : confirmAction === "timeout"
            ? "This will scan for timed-out runs and cooperative leases."
            : "Execute this administrative action?"
        }
        confirmLabel="Execute"
        onConfirm={() => handleAction(confirmAction || "")}
        loading={actionLoading}
      />
    </PageLayout>
  );
}

function HealthCard({ label, value, status }: { label: string; value: number; status: "healthy" | "warning" }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-muted-foreground">{label}</p>
            <p className="mt-1 text-xl font-bold">{value}</p>
          </div>
          <div className={`h-3 w-3 rounded-full ${status === "healthy" ? "bg-success" : "bg-warning"}`} />
        </div>
      </CardContent>
    </Card>
  );
}
