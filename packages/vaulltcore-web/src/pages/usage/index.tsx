import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageLayout } from "@/components/layout";
import { formatTokens, formatDuration, formatRelativeTime } from "@/lib/formatting";
import {
  BarChart3,
  TrendingUp,
  ArrowDown,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

// Mock usage data
const mockSummary = {
  totalTokens: 2847500,
  totalRequests: 312,
  totalDurationMs: 45_600_000,
  byProvider: {
    openai: { tokens: 1_420_000, requests: 156 },
    anthropic: { tokens: 1_427_500, requests: 156 },
  },
  byModel: {
    "gpt-4o": { tokens: 1_200_000, requests: 100 },
    "claude-sonnet-4-20250514": { tokens: 1_100_000, requests: 112 },
    "claude-3-haiku": { tokens: 547_500, requests: 100 },
  },
  byKind: {
    tokens: { quantity: 2_847_500, unit: "tokens" },
    tool_calls: { quantity: 892, unit: null },
    duration: { quantity: 45_600_000, unit: "ms" },
  },
  period: { from: Date.now() - 2_592_000_000, to: Date.now() },
};

const mockLedger = [
  { eventId: "evt_001", kind: "tokens", quantity: 15200, unit: "tokens", provider: "anthropic", model: "claude-sonnet-4-20250514", jobId: "job_01HXYZ123", recordedAt: Date.now() - 300000 },
  { eventId: "evt_002", kind: "tokens", quantity: 8400, unit: "tokens", provider: "anthropic", model: "claude-sonnet-4-20250514", jobId: "job_01HXYZ123", recordedAt: Date.now() - 300000 },
  { eventId: "evt_003", kind: "tool_calls", quantity: 4, unit: null, provider: "anthropic", model: "claude-sonnet-4-20250514", jobId: "job_01HXYZ123", recordedAt: Date.now() - 300000 },
  { eventId: "evt_004", kind: "duration", quantity: 42000, unit: "ms", provider: "anthropic", model: "claude-sonnet-4-20250514", jobId: "job_01HXYZ123", recordedAt: Date.now() - 300000 },
  { eventId: "evt_005", kind: "tokens", quantity: 42100, unit: "tokens", provider: "openai", model: "gpt-4o", jobId: "job_01HXYZ124", recordedAt: Date.now() - 3600000 },
  { eventId: "evt_006", kind: "tokens", quantity: 21300, unit: "tokens", provider: "openai", model: "gpt-4o", jobId: "job_01HXYZ124", recordedAt: Date.now() - 3600000 },
  { eventId: "evt_007", kind: "tool_calls", quantity: 12, unit: null, provider: "openai", model: "gpt-4o", jobId: "job_01HXYZ124", recordedAt: Date.now() - 3600000 },
  { eventId: "evt_008", kind: "duration", quantity: 128000, unit: "ms", provider: "openai", model: "gpt-4o", jobId: "job_01HXYZ124", recordedAt: Date.now() - 3600000 },
];

export default function UsagePage() {
  const [page, setPage] = React.useState(0);
  const pageSize = 10;
  const hasMore = mockLedger.length >= pageSize;

  return (
    <PageLayout
      title="Usage"
      description="Token consumption, model breakdown, and billing analytics"
    >
      {/* Summary Cards */}
      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard label="Total Tokens" value={formatTokens(mockSummary.totalTokens)} icon={TrendingUp} />
        <SummaryCard label="Total Requests" value={String(mockSummary.totalRequests)} icon={BarChart3} />
        <SummaryCard label="Duration" value={formatDuration(mockSummary.totalDurationMs)} icon={ArrowDown} />
        <SummaryCard label="Tool Calls" value={String(mockSummary.byKind.tool_calls.quantity)} icon={ArrowRight} />
      </div>

      {/* Breakdowns */}
      <div className="mb-8 grid gap-6 lg:grid-cols-2">
        {/* Provider Breakdown */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">By Provider</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {Object.entries(mockSummary.byProvider).map(([provider, data]) => (
                <div key={provider} className="space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium capitalize">{provider}</span>
                    <span className="text-muted-foreground">{formatTokens(data.tokens)} tokens</span>
                  </div>
                  <div className="h-2 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${(data.tokens / mockSummary.totalTokens) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Model Breakdown */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">By Model</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {Object.entries(mockSummary.byModel).map(([model, data]) => (
                <div key={model} className="space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium">{model}</span>
                    <span className="text-muted-foreground">{formatTokens(data.tokens)} tokens · {data.requests} req</span>
                  </div>
                  <div className="h-2 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full bg-info"
                      style={{ width: `${(data.tokens / mockSummary.totalTokens) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Usage Ledger */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Usage Ledger</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Event</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Quantity</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Job</TableHead>
                <TableHead>Recorded</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {mockLedger.map((entry) => (
                <TableRow key={entry.eventId}>
                  <TableCell className="font-mono text-xs">{entry.eventId}</TableCell>
                  <TableCell>
                    <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
                      {entry.kind}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-sm">
                    {entry.unit === "ms"
                      ? formatDuration(entry.quantity)
                      : entry.unit === "tokens"
                      ? formatTokens(entry.quantity)
                      : entry.quantity}
                  </TableCell>
                  <TableCell className="text-sm capitalize">{entry.provider}</TableCell>
                  <TableCell className="text-sm">{entry.model}</TableCell>
                  <TableCell>
                    <span className="font-mono text-xs text-primary">{entry.jobId.slice(0, 12)}…</span>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatRelativeTime(entry.recordedAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {/* Cursor pagination */}
          <div className="mt-4 flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              Showing {page * pageSize + 1}–{(page + 1) * pageSize} of {mockLedger.length}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page === 0}
                onClick={() => setPage(page - 1)}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!hasMore}
                onClick={() => setPage(page + 1)}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </PageLayout>
  );
}

function SummaryCard({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon: React.ElementType;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-muted-foreground">{label}</p>
            <p className="mt-1 text-xl font-bold tracking-tight">{value}</p>
          </div>
          <div className="rounded-lg bg-muted p-2">
            <Icon className="h-4 w-4 text-muted-foreground" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
