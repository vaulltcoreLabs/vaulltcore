import React, { useState, useEffect, useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/ui/dialog";
import { useRepositories } from "@/lib/repositories";
import { useEventStream, type UseEventStreamOptions } from "@/lib/sse";
import { useToast } from "@/components/ui/toast";
import { formatDateTime, formatRelativeTime, formatTokens, formatDuration } from "@/lib/formatting";
import type { JobView, JobEvent } from "@/types";
import {
  ChevronLeft, Zap, XCircle, MessageSquare, Terminal, AlertTriangle,
  Activity, Send, Clock, ArrowRight,
} from "lucide-react";

const eventTypeConfig: Record<string, { icon: React.ElementType; color: string }> = {
  queued: { icon: Clock, color: "text-muted-foreground" },
  started: { icon: Activity, color: "text-info" },
  resumed: { icon: Activity, color: "text-info" },
  checkpoint: { icon: Activity, color: "text-primary" },
  message: { icon: MessageSquare, color: "text-primary" },
  tool_request: { icon: Terminal, color: "text-warning" },
  tool_response: { icon: Terminal, color: "text-success" },
  usage: { icon: Zap, color: "text-info" },
  warning: { icon: AlertTriangle, color: "text-warning" },
  error: { icon: AlertTriangle, color: "text-destructive" },
  budget_exhausted: { icon: AlertTriangle, color: "text-destructive" },
  completed: { icon: Zap, color: "text-success" },
  cancelled: { icon: XCircle, color: "text-muted-foreground" },
};

function formatEventData(type: string, data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const d = data as Record<string, unknown>;
  switch (type) {
    case "message":
      return typeof d.content === "string" ? d.content : JSON.stringify(d.content || "");
    case "tool_request":
      return `${d.tool || "tool"} → ${d.args ? JSON.stringify(d.args).slice(0, 80) : ""}`;
    case "tool_response":
      return `${d.tool || "tool"} ← ${typeof d.result === "string" ? d.result.slice(0, 80) : "done"}`;
    case "started":
      return `Model: ${d.model || "unknown"}`;
    case "usage":
      return `Tokens: ${d.inputTokens || 0} in / ${d.outputTokens || 0} out`;
    default:
      return JSON.stringify(d).slice(0, 100);
  }
}

export default function JobDetailPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const repos = useRepositories();
  const { toast } = useToast();
  const [job, setJob] = useState<JobView | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inputText, setInputText] = useState("");
  const [sending, setSending] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [activeTab, setActiveTab] = useState("events");

  // Load job and historical events
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    (async () => {
      try {
        const [jobData, eventsData] = await Promise.all([
          repos.jobs.get(jobId),
          repos.jobs.events(jobId),
        ]);
        if (!cancelled) {
          setJob(jobData);
          setEvents(Array.isArray(eventsData) ? eventsData : []);
          setLoading(false);
        }
      } catch (e: unknown) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load job");
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [jobId, repos.jobs]);

  // SSE for live event streaming
  const { state: sseState } = useEventStream({
    path: `/jobs/${jobId}/events`,
    enabled: !!jobId && job?.status !== "completed" && job?.status !== "failed" && job?.status !== "cancelled",
    onEvent: (eventType, data) => {
      const evt = data as JobEvent;
      if (evt && evt.seq) {
        setEvents((prev) => {
          if (prev.some((e) => e.seq === evt.seq)) return prev;
          return [...prev, evt].sort((a, b) => a.seq - b.seq);
        });
        // Update job status from events
        if (evt.type === "completed" || evt.type === "cancelled" || evt.type === "error") {
          setJob((prev) => prev ? { ...prev, status: evt.type === "completed" ? "completed" : evt.type === "cancelled" ? "cancelled" : "failed" } : prev);
        }
      }
    },
    onDone: () => {
      // Refresh job after stream completes
      if (jobId) repos.jobs.get(jobId).then(setJob);
    },
  });

  const handleSendInput = async () => {
    if (!jobId || !inputText.trim() || sending) return;
    setSending(true);
    try {
      await repos.jobs.input(jobId, inputText);
      setInputText("");
      toast({ description: "Input sent successfully", variant: "success" });
    } catch {
      toast({ description: "Failed to send input", variant: "error" });
    } finally {
      setSending(false);
    }
  };

  const handleCancel = async () => {
    if (!jobId) return;
    try {
      await repos.jobs.cancel(jobId);
      setJob((prev) => prev ? { ...prev, status: "cancelled" } : prev);
      toast({ description: "Job cancelled", variant: "success" });
    } catch {
      toast({ description: "Failed to cancel job", variant: "error" });
    }
    setConfirmCancel(false);
  };

  const isActive = job?.status === "running" || job?.status === "queued" || job?.status === "leased" || job?.status === "preparing";

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-2">
          <ChevronLeft className="h-4 w-4" />
          <Skeleton className="h-4 w-16" />
        </div>
        <Skeleton className="h-12 w-48" />
        <div className="grid gap-4 sm:grid-cols-4">{[1,2,3,4].map(i => <Skeleton key={i} className="h-24" />)}</div>
        <Skeleton className="h-96" />
      </div>
    );
  }

  if (error || !job) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <AlertTriangle className="h-12 w-12 text-muted-foreground mb-4" />
        <h2 className="text-lg font-semibold">Job Not Found</h2>
        <p className="text-sm text-muted-foreground mt-1">{error || "The requested job does not exist or is not accessible."}</p>
        <Link to="/jobs"><Button variant="outline" className="mt-4">Back to Jobs</Button></Link>
      </div>
    );
  }

  return (
    <div className="animate-fade-in space-y-6">
      {/* Header */}
      <div>
        <Link to="/jobs" className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1 mb-3">
          <ChevronLeft className="h-3 w-3" /> Back to Jobs
        </Link>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold tracking-tight">Job Detail</h1>
              <StatusBadge status={job.status} />
            </div>
            <p className="mt-1 font-mono text-sm text-muted-foreground">{job.id}</p>
          </div>
          <div className="flex items-center gap-2">
            {sseState.status === "connected" && (
              <Badge variant="success" className="gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse-soft" /> Live
              </Badge>
            )}
            {isActive && (
              <>
                {job.pendingInput.length > 0 && (
                  <Badge variant="warning">Awaiting Input</Badge>
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
            <p className="text-xs font-medium text-muted-foreground">Total Tokens</p>
            <p className="mt-1 text-xl font-bold">{formatTokens(job.usage.totalTokens)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs font-medium text-muted-foreground">Steps</p>
            <p className="mt-1 text-xl font-bold">{job.usage.steps}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs font-medium text-muted-foreground">Tool Calls</p>
            <p className="mt-1 text-xl font-bold">{job.usage.toolCalls}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs font-medium text-muted-foreground">Duration</p>
            <p className="mt-1 text-xl font-bold">{formatDuration(job.updatedAt - job.createdAt)}</p>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="events" value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="events">Events ({events.length})</TabsTrigger>
          <TabsTrigger value="usage">Usage</TabsTrigger>
          <TabsTrigger value="input">Input</TabsTrigger>
          <TabsTrigger value="overview">Overview</TabsTrigger>
        </TabsList>

        {/* Events Tab — live timeline */}
        <TabsContent value="events">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Event Timeline</CardTitle>
                {sseState.status === "connecting" && (
                  <Badge variant="secondary" className="gap-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-warning animate-pulse-soft" /> Connecting...
                  </Badge>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {events.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">No events yet</p>
              ) : (
                <div className="relative ml-4 border-l-2 border-border pl-6 space-y-4">
                  {events.map((event, i) => {
                    const config = eventTypeConfig[event.type] || { icon: Zap, color: "text-muted-foreground" };
                    const Icon = config.icon;
                    return (
                      <div key={event.seq} className="relative animate-slide-in" style={{ animationDelay: `${i * 30}ms` }}>
                        <div className={`absolute -left-[31px] flex h-6 w-6 items-center justify-center rounded-full bg-background border-2 border-border`}>
                          <Icon className={`h-3 w-3 ${config.color}`} />
                        </div>
                        <div>
                          <div className="flex items-center gap-2 mb-1">
                            <Badge variant="outline" className="text-[10px] font-mono">{event.type}</Badge>
                            <span className="text-[10px] text-muted-foreground">seq:{event.seq}</span>
                            <span className="text-[10px] text-muted-foreground">{formatRelativeTime(event.timestamp)}</span>
                          </div>
                          <p className="text-sm text-muted-foreground">
                            {formatEventData(event.type, event.data)}
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

        {/* Usage Tab */}
        <TabsContent value="usage">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Token Usage</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-6 sm:grid-cols-2">
                <div className="space-y-4">
                  <UsageBar label="Input Tokens" value={job.usage.inputTokens} max={Math.max(job.usage.inputTokens, job.usage.outputTokens)} />
                  <UsageBar label="Output Tokens" value={job.usage.outputTokens} max={Math.max(job.usage.inputTokens, job.usage.outputTokens)} />
                  <UsageBar label="Reasoning Tokens" value={job.usage.reasoningTokens} max={job.usage.totalTokens} />
                  <UsageBar label="Total Tokens" value={job.usage.totalTokens} max={job.usage.totalTokens} />
                </div>
                <div className="rounded-lg border p-4 space-y-3">
                  <h4 className="text-sm font-medium">Summary</h4>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between"><span className="text-muted-foreground">Input</span><span className="font-mono">{formatTokens(job.usage.inputTokens)}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Output</span><span className="font-mono">{formatTokens(job.usage.outputTokens)}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Reasoning</span><span className="font-mono">{formatTokens(job.usage.reasoningTokens)}</span></div>
                    <div className="border-t pt-2 flex justify-between font-medium"><span>Total</span><span className="font-mono">{formatTokens(job.usage.totalTokens)}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Steps</span><span className="font-mono">{job.usage.steps}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Tool Calls</span><span className="font-mono">{job.usage.toolCalls}</span></div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Input Tab */}
        <TabsContent value="input">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Job Input</CardTitle>
            </CardHeader>
            <CardContent>
              {job.pendingInput.length > 0 && (
                <div className="mb-4 rounded-lg border border-warning/30 bg-warning/5 p-4">
                  <p className="text-sm font-medium text-warning">Pending Input Required</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    This job is waiting for input on: {job.pendingInput.join(", ")}
                  </p>
                </div>
              )}
              <div className="flex gap-2">
                <input
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  placeholder="Type input text for this job..."
                  className="flex-1 rounded-md border bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  onKeyDown={(e) => e.key === "Enter" && handleSendInput()}
                />
                <Button onClick={handleSendInput} disabled={!inputText.trim() || sending} loading={sending}>
                  <Send className="mr-1 h-3.5 w-3.5" /> Send
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Overview Tab */}
        <TabsContent value="overview">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Job Overview</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-3">
                  <InfoRow label="Job ID" value={job.id} mono />
                  <InfoRow label="Status" value={<StatusBadge status={job.status} />} />
                  <InfoRow label="Tenant" value={job.tenantId} mono />
                  <InfoRow label="Org" value={job.orgId || "—"} mono />
                  <InfoRow label="Project" value={job.projectId || "—"} mono />
                </div>
                <div className="space-y-3">
                  <InfoRow label="Created" value={formatDateTime(job.createdAt)} />
                  <InfoRow label="Updated" value={formatDateTime(job.updatedAt)} />
                  <InfoRow label="Duration" value={formatDuration(job.updatedAt - job.createdAt)} />
                  <InfoRow label="Pending Input" value={job.pendingInput.length > 0 ? job.pendingInput.join(", ") : "None"} />
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title="Cancel Job"
        description="This will cancel the running job. Any progress up to the last checkpoint will be preserved."
        confirmLabel="Cancel Job"
        variant="destructive"
        onConfirm={handleCancel}
      />
    </div>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={`text-sm ${mono ? "font-mono text-xs" : ""}`}>{value}</span>
    </div>
  );
}

function UsageBar({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div>
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono font-medium">{formatTokens(value)}</span>
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
