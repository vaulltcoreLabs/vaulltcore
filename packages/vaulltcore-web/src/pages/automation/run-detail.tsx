import React, { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/ui/dialog";
import { useRepositories } from "@/lib/repositories";
import { useEventStream } from "@/lib/sse";
import { useToast } from "@/components/ui/toast";
import { formatDateTime, formatRelativeTime, formatTokens, formatDuration, formatNumber } from "@/lib/formatting";
import type { AutomationRun, AutomationEvent, AutomationArtifact, ApprovalRequest, SanitizedDelivery } from "@/types";
import {
  ChevronLeft, Play, Pause, XCircle, CheckCircle, AlertTriangle,
  Shield, Package, Truck, Activity, Clock, ArrowRight,
} from "lucide-react";

const stepStatusIcons: Record<string, { icon: React.ElementType; color: string }> = {
  created: { icon: Clock, color: "text-muted-foreground" },
  validating_input: { icon: Activity, color: "text-info" },
  admitted: { icon: CheckCircle, color: "text-info" },
  running: { icon: Play, color: "text-info" },
  step_started: { icon: Play, color: "text-info" },
  step_completed: { icon: CheckCircle, color: "text-success" },
  collecting: { icon: Package, color: "text-primary" },
  awaiting_approval: { icon: Shield, color: "text-warning" },
  delivering: { icon: Truck, color: "text-info" },
  completed: { icon: CheckCircle, color: "text-success" },
  failed: { icon: AlertTriangle, color: "text-destructive" },
  cancelled: { icon: XCircle, color: "text-muted-foreground" },
  error: { icon: AlertTriangle, color: "text-destructive" },
};

export default function RunDetailPage() {
  const { runId } = useParams<{ runId: string }>();
  const repos = useRepositories();
  const { toast } = useToast();
  const [run, setRun] = useState<AutomationRun | null>(null);
  const [events, setEvents] = useState<AutomationEvent[]>([]);
  const [artifacts, setArtifacts] = useState<AutomationArtifact[]>([]);
  const [deliveries, setDeliveries] = useState<SanitizedDelivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmAdvance, setConfirmAdvance] = useState(false);
  const [activeTab, setActiveTab] = useState("timeline");

  // Load all data
  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    (async () => {
      try {
        const [runData, eventsData, artifactsData, deliveriesData] = await Promise.all([
          repos.automation.runs.get(runId),
          repos.automation.runs.events(runId),
          repos.automation.runs.artifacts(runId),
          repos.automation.runs.deliveries(runId),
        ]);
        if (!cancelled) {
          setRun(runData);
          setEvents(eventsData?.events || []);
          setArtifacts(artifactsData?.artifacts || []);
          setDeliveries(deliveriesData?.deliveries || []);
          setLoading(false);
        }
      } catch (e: unknown) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load run");
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [runId, repos.automation.runs]);

  // SSE for live stream
  const { state: sseState } = useEventStream({
    path: `/automation/runs/${runId}/stream`,
    enabled: !!runId && !!run && !["completed", "failed", "cancelled", "rejected"].includes(run.status),
    onEvent: (_eventType, data) => {
      const evt = data as AutomationEvent;
      if (evt?.seq) {
        setEvents((prev) => {
          if (prev.some((e) => e.seq === evt.seq)) return prev;
          return [...prev, evt].sort((a, b) => a.seq - b.seq);
        });
        // Update run status
        if (typeof evt.data === "object" && evt.data !== null && "status" in (evt.data as Record<string, unknown>)) {
          const newStatus = (evt.data as Record<string, unknown>).status as string;
          if (newStatus) {
            setRun((prev) => prev ? { ...prev, status: newStatus as AutomationRun["status"] } : prev);
          }
        }
      }
    },
    onDone: () => {
      if (runId) repos.automation.runs.get(runId).then(setRun);
    },
  });

  const handleCancel = async () => {
    if (!runId) return;
    try {
      const updated = await repos.automation.runs.cancel(runId);
      setRun(updated);
      toast({ description: "Run cancelled", variant: "success" });
    } catch {
      toast({ description: "Failed to cancel run", variant: "error" });
    }
    setConfirmCancel(false);
  };

  const handleAdvance = async () => {
    if (!runId) return;
    try {
      const updated = await repos.automation.runs.advance(runId);
      setRun(updated);
      toast({ description: "Run advanced", variant: "success" });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to advance run";
      toast({ description: msg, variant: "error" });
    }
    setConfirmAdvance(false);
  };

  const isTerminal = run?.status === "completed" || run?.status === "failed" || run?.status === "cancelled" || run?.status === "rejected";

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-2"><ChevronLeft className="h-4 w-4" /><Skeleton className="h-4 w-16" /></div>
        <Skeleton className="h-12 w-48" />
        <Skeleton className="h-96" />
      </div>
    );
  }

  if (error || !run) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <AlertTriangle className="h-12 w-12 text-muted-foreground mb-4" />
        <h2 className="text-lg font-semibold">Run Not Found</h2>
        <p className="text-sm text-muted-foreground mt-1">{error || "The requested run does not exist or is not accessible."}</p>
        <Link to="/automation/runs"><Button variant="outline" className="mt-4">Back to Runs</Button></Link>
      </div>
    );
  }

  return (
    <div className="animate-fade-in space-y-6">
      {/* Header */}
      <div>
        <Link to="/automation/runs" className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1 mb-3">
          <ChevronLeft className="h-3 w-3" /> Back to Runs
        </Link>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold tracking-tight">Run Detail</h1>
              <StatusBadge status={run.status} />
            </div>
            <p className="mt-1 font-mono text-sm text-muted-foreground">{run.runId}</p>
            <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
              <span>Template: <Link to={`/automation/templates/${run.templateId}`} className="text-primary hover:underline">{run.templateId.slice(0, 16)}…</Link></span>
              <span>Version: <span className="font-mono">v{run.version}</span></span>
              <span>Run v{run.runVersion}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {sseState.status === "connected" && (
              <Badge variant="success" className="gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse-soft" /> Live
              </Badge>
            )}
            {run.status === "awaiting_approval" && (
              <Badge variant="warning" className="gap-1">
                <Shield className="h-3 w-3" /> Awaiting Approval
              </Badge>
            )}
            {!isTerminal && (
              <>
                {run.status !== "awaiting_approval" && (
                  <Button size="sm" variant="outline" onClick={() => setConfirmAdvance(true)}>
                    <ArrowRight className="mr-1 h-3.5 w-3.5" /> Advance
                  </Button>
                )}
                <Button variant="destructive" size="sm" onClick={() => setConfirmCancel(true)}>
                  <XCircle className="mr-1 h-3.5 w-3.5" /> Cancel
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid gap-4 sm:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs font-medium text-muted-foreground">Events</p>
            <p className="mt-1 text-xl font-bold">{events.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs font-medium text-muted-foreground">Artifacts</p>
            <p className="mt-1 text-xl font-bold">{artifacts.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs font-medium text-muted-foreground">Deliveries</p>
            <p className="mt-1 text-xl font-bold">{deliveries.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs font-medium text-muted-foreground">Duration</p>
            <p className="mt-1 text-xl font-bold">
              {run.completedAt ? formatDuration(run.completedAt - run.createdAt) : formatDuration(Date.now() - run.createdAt)}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Error banner */}
      {run.error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium text-destructive">Run Error</p>
              <p className="text-sm text-muted-foreground mt-0.5">{run.error}</p>
            </div>
          </div>
        </div>
      )}

      {/* Tabs */}
      <Tabs defaultValue="timeline" value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="timeline">Timeline ({events.length})</TabsTrigger>
          <TabsTrigger value="artifacts">Artifacts ({artifacts.length})</TabsTrigger>
          <TabsTrigger value="deliveries">Deliveries ({deliveries.length})</TabsTrigger>
          <TabsTrigger value="overview">Overview</TabsTrigger>
        </TabsList>

        {/* Timeline */}
        <TabsContent value="timeline">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Execution Timeline</CardTitle>
                {sseState.status === "connecting" && <Badge variant="secondary">Connecting...</Badge>}
              </div>
            </CardHeader>
            <CardContent>
              {events.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">No events yet</p>
              ) : (
                <div className="relative ml-4 border-l-2 border-border pl-6 space-y-4">
                  {events.map((event, i) => {
                    const config = stepStatusIcons[event.type] || { icon: Activity, color: "text-muted-foreground" };
                    const Icon = config.icon;
                    return (
                      <div key={event.seq} className="relative animate-slide-in" style={{ animationDelay: `${i * 30}ms` }}>
                        <div className="absolute -left-[31px] flex h-6 w-6 items-center justify-center rounded-full bg-background border-2 border-border">
                          <Icon className={`h-3 w-3 ${config.color}`} />
                        </div>
                        <div>
                          <div className="flex items-center gap-2 mb-1">
                            <Badge variant="outline" className="text-[10px] font-mono">{event.type}</Badge>
                            <span className="text-[10px] text-muted-foreground">seq:{event.seq}</span>
                            <span className="text-[10px] text-muted-foreground">{formatRelativeTime(event.timestamp)}</span>
                          </div>
                          <p className="text-sm text-muted-foreground">
                            {typeof event.data === "object" && event.data !== null
                              ? JSON.stringify(event.data).slice(0, 200)
                              : String(event.data || "")}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Artifacts */}
        <TabsContent value="artifacts">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Run Artifacts</CardTitle>
              <CardDescription>Generated outputs from automation steps</CardDescription>
            </CardHeader>
            <CardContent>
              {artifacts.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">No artifacts generated yet</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Step</TableHead>
                      <TableHead>Size</TableHead>
                      <TableHead>Checksum</TableHead>
                      <TableHead>Created</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {artifacts.map((art) => (
                      <TableRow key={art.artifactId}>
                        <TableCell className="font-medium">{art.name}</TableCell>
                        <TableCell><Badge variant="outline">{art.type}</Badge></TableCell>
                        <TableCell className="font-mono text-xs">{art.stepId || "—"}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{art.size != null ? `${(art.size / 1024).toFixed(1)} KB` : "—"}</TableCell>
                        <TableCell className="font-mono text-[10px] text-muted-foreground">{art.checksum.slice(0, 20)}…</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{formatRelativeTime(art.createdAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              <p className="mt-3 text-xs text-muted-foreground">
                Note: Artifact content download is not currently exposed via the API. Only metadata is shown.
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Deliveries */}
        <TabsContent value="deliveries">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Deliveries</CardTitle>
              <CardDescription>At-least-once delivery status with idempotent settlement</CardDescription>
            </CardHeader>
            <CardContent>
              {deliveries.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">No deliveries yet</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Destination</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Attempts</TableHead>
                      <TableHead>Last Error</TableHead>
                      <TableHead>Updated</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {deliveries.map((dlv) => (
                      <TableRow key={dlv.deliveryId}>
                        <TableCell className="font-mono text-xs">{dlv.destination}</TableCell>
                        <TableCell><StatusBadge status={dlv.status} /></TableCell>
                        <TableCell className="font-mono">{dlv.attempts}</TableCell>
                        <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">{dlv.lastError || "—"}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{formatRelativeTime(dlv.updatedAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Overview */}
        <TabsContent value="overview">
          <Card>
            <CardHeader><CardTitle className="text-base">Run Overview</CardTitle></CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-3">
                  <div className="flex justify-between text-sm"><span className="text-muted-foreground">Run ID</span><span className="font-mono text-xs">{run.runId}</span></div>
                  <div className="flex justify-between text-sm"><span className="text-muted-foreground">Status</span><StatusBadge status={run.status} /></div>
                  <div className="flex justify-between text-sm"><span className="text-muted-foreground">Template</span><span className="font-mono text-xs">{run.templateId}</span></div>
                  <div className="flex justify-between text-sm"><span className="text-muted-foreground">Version</span><span className="font-mono">v{run.version}</span></div>
                </div>
                <div className="space-y-3">
                  <div className="flex justify-between text-sm"><span className="text-muted-foreground">Created</span><span>{formatDateTime(run.createdAt)}</span></div>
                  <div className="flex justify-between text-sm"><span className="text-muted-foreground">Updated</span><span>{formatDateTime(run.updatedAt)}</span></div>
                  <div className="flex justify-between text-sm"><span className="text-muted-foreground">Run Version (fence)</span><span className="font-mono">{run.runVersion}</span></div>
                  <div className="flex justify-between text-sm"><span className="text-muted-foreground">Created By</span><span>{run.createdBy}</span></div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title="Cancel Run"
        description="This will cancel the automation run. The run status will change to 'cancelled' and no further steps will execute."
        confirmLabel="Cancel Run"
        variant="destructive"
        onConfirm={handleCancel}
      />
      <ConfirmDialog
        open={confirmAdvance}
        onOpenChange={setConfirmAdvance}
        title="Advance Run"
        description="Manually advance this run to the next step. Use this when the run is stuck or needs manual progression."
        confirmLabel="Advance"
        onConfirm={handleAdvance}
      />
    </div>
  );
}
