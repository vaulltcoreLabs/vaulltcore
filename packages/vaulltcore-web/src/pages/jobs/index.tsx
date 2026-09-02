import React, { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageLayout, DataViewState } from "@/components/layout";
import { useRepositories } from "@/lib/repositories";
import { formatDateTime, formatRelativeTime, formatTokens } from "@/lib/formatting";
import type { JobView } from "@/types";
import { Plus, ExternalLink, XCircle } from "lucide-react";

const containerVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.04 } },
};
const itemVariants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0 },
};

export default function JobsPage() {
  const repos = useRepositories();
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    repos.jobs.list().then(setJobs).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, [repos.jobs]);

  return (
    <PageLayout
      title="Jobs"
      description="Monitor and manage AI execution jobs"
      actions={
        <Button>
          <Plus className="mr-2 h-4 w-4" />
          New Job
        </Button>
      }
    >
      <DataViewState loading={loading} error={error} empty={jobs.length === 0} emptyTitle="No jobs yet" emptyDescription="Create your first job to start running AI executions." emptyAction={<Button><Plus className="mr-2 h-4 w-4" />New Job</Button>} />

      {jobs.length > 0 && (
        <>
          {/* Desktop: Table */}
          <Card className="hidden md:block">
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Job ID</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Tokens</TableHead>
                    <TableHead>Steps</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {jobs.map((job) => (
                    <TableRow key={job.id}>
                      <TableCell>
                        <Link to={`/jobs/${job.id}`} className="font-mono text-xs text-primary hover:underline">
                          {job.id.slice(0, 16)}…
                        </Link>
                      </TableCell>
                      <TableCell><StatusBadge status={job.status} /></TableCell>
                      <TableCell className="font-mono text-sm">{formatTokens(job.usage.totalTokens)}</TableCell>
                      <TableCell className="font-mono text-sm">{job.usage.steps}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{formatRelativeTime(job.createdAt)}</TableCell>
                      <TableCell className="text-right">
                        <Link to={`/jobs/${job.id}`}><Button variant="ghost" size="sm"><ExternalLink className="h-3.5 w-3.5" /></Button></Link>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* Mobile: Cards */}
          <motion.div className="grid gap-3 md:hidden" variants={containerVariants} initial="hidden" animate="visible">
            {jobs.map((job) => (
              <motion.div key={job.id} variants={itemVariants}>
                <Link to={`/jobs/${job.id}`}>
                  <Card className="transition-colors hover:bg-accent/30">
                    <CardContent className="p-4">
                      <div className="flex items-center justify-between mb-2">
                        <span className="font-mono text-xs text-primary">{job.id.slice(0, 16)}…</span>
                        <StatusBadge status={job.status} />
                      </div>
                      <div className="flex items-center gap-4 text-xs text-muted-foreground">
                        <span>{formatTokens(job.usage.totalTokens)} tokens</span>
                        <span>{job.usage.steps} steps</span>
                        <span>{formatRelativeTime(job.createdAt)}</span>
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
