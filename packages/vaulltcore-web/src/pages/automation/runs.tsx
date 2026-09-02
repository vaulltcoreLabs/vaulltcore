import React, { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageLayout, DataViewState } from "@/components/layout";
import { useRepositories } from "@/lib/repositories";
import { formatRelativeTime } from "@/lib/formatting";
import type { AutomationRun } from "@/types";
import { Plus, ExternalLink } from "lucide-react";

const containerVariants = { hidden: { opacity: 0 }, visible: { opacity: 1, transition: { staggerChildren: 0.04 } } };
const itemVariants = { hidden: { opacity: 0, y: 8 }, visible: { opacity: 1, y: 0 } };

export default function RunsPage() {
  const repos = useRepositories();
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    repos.automation.runs.list().then(setRuns).catch((e: Error) => setError(e.message)).finally(() => setLoading(false));
  }, [repos.automation.runs]);

  const templateNames: Record<string, string> = {
    tmpl_01HXYZAAAA: "Deploy to Staging",
    tmpl_01HXYZBBBB: "PR Review Automation",
    tmpl_01HXYZCCCC: "E2E Test Suite",
  };

  // Fallback mock data for display
  const mockRuns: (AutomationRun & { templateName: string })[] = [
    { runId: "run_01HXYZ111", templateId: "tmpl_01HXYZAAAA", versionId: "ver_01", version: 3, status: "running", inputRevisionId: "inp_1", runVersion: 2, createdBy: "user_admin", error: null, createdAt: Date.now() - 1200000, updatedAt: Date.now() - 60000, suspendedAt: null, completedAt: null, tenantId: "t_1", orgId: "org_1", projectId: "proj_abc", templateName: "Deploy to Staging" },
    { runId: "run_01HXYZ222", templateId: "tmpl_01HXYZBBBB", versionId: "ver_03", version: 7, status: "awaiting_approval", inputRevisionId: "inp_2", runVersion: 1, createdBy: "user_dev", error: null, createdAt: Date.now() - 3600000, updatedAt: Date.now() - 1800000, suspendedAt: null, completedAt: null, tenantId: "t_1", orgId: "org_1", projectId: "proj_abc", templateName: "PR Review Automation" },
    { runId: "run_01HXYZ333", templateId: "tmpl_01HXYZAAAA", versionId: "ver_01", version: 3, status: "completed", inputRevisionId: "inp_3", runVersion: 5, createdBy: "user_admin", error: null, createdAt: Date.now() - 86400000, updatedAt: Date.now() - 86000000, suspendedAt: null, completedAt: Date.now() - 86000000, tenantId: "t_1", orgId: "org_1", projectId: "proj_abc", templateName: "Deploy to Staging" },
    { runId: "run_01HXYZ444", templateId: "tmpl_01HXYZCCCC", versionId: "ver_04", version: 5, status: "failed", inputRevisionId: "inp_4", runVersion: 3, createdBy: "user_dev", error: "Step 'run_tests' failed: connection timeout", createdAt: Date.now() - 172800000, updatedAt: Date.now() - 172700000, suspendedAt: null, completedAt: null, tenantId: "t_1", orgId: "org_1", projectId: "proj_abc", templateName: "E2E Test Suite" },
  ];

  const displayRuns: (AutomationRun & { templateName: string })[] = runs.length > 0
    ? runs.map(r => ({ ...r, templateName: templateNames[r.templateId] || r.templateId.slice(0, 12) }))
    : mockRuns;

  return (
    <PageLayout
      title="Automation Runs"
      description="Track execution history and real-time status of automation runs"
      actions={<Button><Plus className="mr-2 h-4 w-4" />New Run</Button>}
    >
      <DataViewState
        loading={loading}
        error={error}
        empty={displayRuns.length === 0}
        emptyTitle="No runs yet"
        emptyDescription="Create your first automation run to start executing workflows."
        emptyAction={<Button><Plus className="mr-2 h-4 w-4" />New Run</Button>}
      />

      {displayRuns.length > 0 && (
        <>
          {/* Desktop: Table */}
          <Card className="hidden md:block">
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Run ID</TableHead>
                    <TableHead>Template</TableHead>
                    <TableHead>Version</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {displayRuns.map((run) => (
                    <TableRow key={run.runId}>
                      <TableCell>
                        <Link to={`/automation/runs/${run.runId}`} className="font-mono text-xs text-primary hover:underline">
                          {run.runId.slice(0, 14)}…
                        </Link>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm font-medium">{run.templateName}</span>
                        {run.error && <p className="mt-0.5 text-xs text-destructive line-clamp-1">{run.error}</p>}
                      </TableCell>
                      <TableCell><span className="font-mono text-sm">v{run.version}</span></TableCell>
                      <TableCell><StatusBadge status={run.status} /></TableCell>
                      <TableCell className="text-xs text-muted-foreground">{formatRelativeTime(run.createdAt)}</TableCell>
                      <TableCell className="text-right">
                        <Link to={`/automation/runs/${run.runId}`}>
                          <Button variant="ghost" size="sm"><ExternalLink className="h-3.5 w-3.5" /></Button>
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* Mobile: Cards */}
          <motion.div className="grid gap-3 md:hidden" variants={containerVariants} initial="hidden" animate="visible">
            {displayRuns.map((run) => (
              <motion.div key={run.runId} variants={itemVariants}>
                <Link to={`/automation/runs/${run.runId}`}>
                  <Card className="transition-colors hover:bg-accent/30">
                    <CardContent className="p-4">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm font-medium">{run.templateName}</span>
                        <StatusBadge status={run.status} />
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span className="font-mono">v{run.version}</span>
                        <span>{formatRelativeTime(run.createdAt)}</span>
                        {run.error && <span className="text-destructive truncate">{run.error}</span>}
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              </motion.div>
            ))}
          </motion.div>
        </>
      )}
    </PageLayout>
  );
}
