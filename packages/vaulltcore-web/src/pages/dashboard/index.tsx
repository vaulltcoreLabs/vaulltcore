import React, { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageLayout } from "@/components/layout";
import { useRepositories } from "@/lib/repositories";
import { formatRelativeTime, formatTokens, formatDuration } from "@/lib/formatting";
import type { AutomationMetrics } from "@/types";
import {
  Zap,
  Play,
  Shield,
  Clock,
  AlertTriangle,
  TrendingUp,
  Activity,
  ArrowRight,
} from "lucide-react"

// Dashboard uses derived metrics from automation metrics endpoint
// In mock mode, shows representative data

interface DashboardMetric {
  label: string;
  value: string | number;
  change?: string;
  icon: React.ElementType;
  color: string;
  href?: string;
}

interface RecentActivity {
  id: string;
  type: "run" | "approval" | "job" | "schedule";
  title: string;
  status: string;
  timestamp: number;
  template?: string;
}

const containerVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.05 } },
};
const itemVariants = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.3 } },
};

const recentActivity: RecentActivity[] = [
  { id: "run_01", type: "run", title: "Deploy Pipeline", status: "running", timestamp: Date.now() - 120000, template: "Deploy to Staging" },
  { id: "run_02", type: "run", title: "Code Review", status: "completed", timestamp: Date.now() - 3600000, template: "PR Review Automation" },
  { id: "apr_01", type: "approval", title: "Production Deploy Approval", status: "awaiting_approval", timestamp: Date.now() - 1800000 },
  { id: "run_03", type: "run", title: "Integration Test Suite", status: "failed", timestamp: Date.now() - 7200000, template: "E2E Tests" },
  { id: "sch_01", type: "schedule", title: "Nightly Build", status: "active", timestamp: Date.now() - 86400000 },
];

const statusColors: Record<string, string> = {
  running: "bg-info/10 text-info border-info/20",
  completed: "bg-success/10 text-success border-success/20",
  failed: "bg-destructive/10 text-destructive border-destructive/20",
  awaiting_approval: "bg-warning/10 text-warning border-warning/20",
  active: "bg-success/10 text-success border-success/20",
};

export default function DashboardPage() {
  const repos = useRepositories();
  const [metrics, setMetrics] = useState<AutomationMetrics | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    repos.metrics.get().then(setMetrics).finally(() => setLoading(false));
  }, [repos.metrics]);

  const metricCards: DashboardMetric[] = [
    { label: "Active Runs", value: metrics?.activeRuns ?? "—", icon: Play, color: "text-info", href: "/automation/runs" },
    { label: "Total Runs", value: metrics?.totalRuns ?? "—", change: metrics ? `${(metrics.successRate * 100).toFixed(0)}% success` : undefined, icon: Zap, color: "text-primary", href: "/jobs" },
    { label: "Templates", value: metrics?.totalTemplates ?? "—", icon: Shield, color: "text-warning", href: "/automation/templates" },
    { label: "Schedules", value: metrics?.activeSchedules ?? "—", icon: Clock, color: "text-success", href: "/automation/schedules" },
  ];

  return (
    <PageLayout
      title="Dashboard"
      description="Overview of your Vaulltcore automation platform"
    >
      {/* Metrics Grid */}
      <motion.div
        className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
        variants={containerVariants}
        initial="hidden"
        animate="visible"
      >
        {metricCards.map((metric) => {
          const Icon = metric.icon;
          return (
            <motion.div key={metric.label} variants={itemVariants}>
              <Link to={metric.href || "#"}>
                <Card className="transition-colors hover:bg-accent/50">
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-xs font-medium text-muted-foreground">{metric.label}</p>
                        <p className="mt-1 text-2xl font-bold tracking-tight">{metric.value}</p>
                        {metric.change && (
                          <p className="mt-0.5 text-xs text-muted-foreground">{metric.change}</p>
                        )}
                      </div>
                      <div className={`rounded-lg bg-muted p-2 ${metric.color}`}>
                        <Icon className="h-5 w-5" />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            </motion.div>
          );
        })}
      </motion.div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Recent Activity */}
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-base">Recent Activity</CardTitle>
            <Link to="/automation/runs">
              <Button variant="ghost" size="sm">
                View all <ArrowRight className="ml-1 h-3 w-3" />
              </Button>
            </Link>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {recentActivity.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between rounded-md border p-3"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-md bg-muted text-xs font-medium">
                      {item.type === "run" ? <Play className="h-3.5 w-3.5" /> :
                       item.type === "approval" ? <Shield className="h-3.5 w-3.5" /> :
                       item.type === "schedule" ? <Clock className="h-3.5 w-3.5" /> :
                       <Zap className="h-3.5 w-3.5" />}
                    </div>
                    <div>
                      <p className="text-sm font-medium">{item.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {item.template && `${item.template} · `}
                        {formatRelativeTime(item.timestamp)}
                      </p>
                    </div>
                  </div>
                  <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${statusColors[item.status] || ""}`}>
                    {item.status.replace(/_/g, " ")}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* System Health */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">System Health</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <HealthItem label="Control Plane" status="healthy" />
              <HealthItem label="Worker Pool" status="healthy" />
              <HealthItem label="Scheduler" status="healthy" />
              <HealthItem label="Reconciliation" status="healthy" />
              <HealthItem label="Dead Letter Queue" status="warning" detail="2 items" />
            </div>

            <div className="mt-6 pt-4 border-t">
              <h4 className="text-xs font-medium text-muted-foreground mb-3 uppercase tracking-wider">
                Usage Today
              </h4>
              <div className="space-y-2">
                <UsageBar label="Tokens" current={142500} max={500000} />
                <UsageBar label="API Calls" current={47} max={200} />
                <UsageBar label="Compute" current={3400000} max={10000000} suffix="ms" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </PageLayout>
  );
}

function HealthItem({
  label,
  status,
  detail,
}: {
  label: string;
  status: "healthy" | "degraded" | "unhealthy" | "warning";
  detail?: string;
}) {
  const dotColor =
    status === "healthy" ? "bg-success" :
    status === "degraded" ? "bg-warning" : "bg-destructive";

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <div className={`h-2 w-2 rounded-full ${dotColor}`} />
        <span className="text-sm">{label}</span>
      </div>
      <span className="text-xs text-muted-foreground">
        {detail || status.charAt(0).toUpperCase() + status.slice(1)}
      </span>
    </div>
  );
}

function UsageBar({
  label,
  current,
  max,
  suffix,
}: {
  label: string;
  current: number;
  max: number;
  suffix?: string;
}) {
  const pct = Math.min((current / max) * 100, 100);
  const displayValue = suffix
    ? `${(current / 1000000).toFixed(1)}M ${suffix}`
    : formatTokens(current);

  return (
    <div>
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium">{displayValue}</span>
      </div>
      <div className="mt-1 h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${pct > 80 ? "bg-warning" : "bg-primary"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
