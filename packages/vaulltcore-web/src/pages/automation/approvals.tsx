import React from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge, Badge } from "@/components/ui/badge";
import { PageLayout, ConfirmDialog } from "@/components/layout";
import { formatRelativeTime, formatDateTime } from "@/lib/formatting";
import { Shield, Check, X, MessageSquare, AlertTriangle } from "lucide-react";

const mockApprovals = [
  {
    approvalId: "apr_01HXYZ111",
    runId: "run_01HXYZ222",
    templateName: "PR Review Automation",
    status: "pending",
    minApproverRole: "developer",
    contextArtifacts: ["Review Summary", "Diff Analysis"],
    createdAt: Date.now() - 1800000,
    expiresAt: Date.now() + 14400000,
    approvalVersion: 1,
    decisionActor: null,
    decisionTime: null,
  },
  {
    approvalId: "apr_01HXYZ222",
    runId: "run_01HXYZ333",
    templateName: "Deploy to Staging",
    status: "pending",
    minApproverRole: "admin",
    contextArtifacts: ["Deploy Plan", "Risk Assessment"],
    createdAt: Date.now() - 3600000,
    expiresAt: Date.now() + 7200000,
    approvalVersion: 2,
    decisionActor: null,
    decisionTime: null,
  },
  {
    approvalId: "apr_01HXYZ333",
    runId: "run_01HXYZ555",
    templateName: "Production Deploy",
    status: "approved",
    minApproverRole: "admin",
    contextArtifacts: ["Deploy Plan"],
    createdAt: Date.now() - 172800000,
    expiresAt: null,
    approvalVersion: 1,
    decisionActor: { principalId: "user_admin", kind: "human" },
    decisionTime: Date.now() - 172700000,
  },
  {
    approvalId: "apr_01HXYZ444",
    runId: "run_01HXYZ666",
    templateName: "E2E Test Suite",
    status: "rejected",
    minApproverRole: "developer",
    contextArtifacts: ["Test Results"],
    createdAt: Date.now() - 432000000,
    expiresAt: null,
    approvalVersion: 1,
    decisionActor: { principalId: "user_dev", kind: "human" },
    decisionTime: Date.now() - 431900000,
  },
];

export default function ApprovalsPage() {
  const [confirmAction, setConfirmAction] = React.useState<{
    type: "approve" | "reject" | "changes";
    approvalId: string;
  } | null>(null);

  const pendingApprovals = mockApprovals.filter((a) => a.status === "pending");
  const history = mockApprovals.filter((a) => a.status !== "pending");

  return (
    <PageLayout
      title="Approvals"
      description="Review and act on pending automation approval gates"
    >
      {/* Pending Approvals - prominent */}
      {pendingApprovals.length > 0 && (
        <div className="mb-8">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-warning flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            Pending Approvals ({pendingApprovals.length})
          </h2>
          <div className="grid gap-4 lg:grid-cols-2">
            {pendingApprovals.map((approval) => (
              <Card key={approval.approvalId} className="border-warning/30 bg-warning/5">
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div>
                      <CardTitle className="text-base">{approval.templateName}</CardTitle>
                      <CardDescription>
                        Run: {approval.runId.slice(0, 14)}… · Approval v{approval.approvalVersion}
                      </CardDescription>
                    </div>
                    <Badge variant="warning">Awaiting Review</Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="mb-4 space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Required Role</span>
                      <span className="font-medium">{approval.minApproverRole}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Context</span>
                      <span>{approval.contextArtifacts.join(", ")}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Expires</span>
                      <span>{approval.expiresAt ? formatDateTime(approval.expiresAt) : "No expiry"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Created</span>
                      <span>{formatRelativeTime(approval.createdAt)}</span>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      className="flex-1 bg-success hover:bg-success/90 text-white"
                      onClick={() => setConfirmAction({ type: "approve", approvalId: approval.approvalId })}
                    >
                      <Check className="mr-1 h-3.5 w-3.5" />
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      className="flex-1"
                      onClick={() => setConfirmAction({ type: "reject", approvalId: approval.approvalId })}
                    >
                      <X className="mr-1 h-3.5 w-3.5" />
                      Reject
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setConfirmAction({ type: "changes", approvalId: approval.approvalId })}
                    >
                      <MessageSquare className="mr-1 h-3.5 w-3.5" />
                      Changes
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* History */}
      <div>
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          History
        </h2>
        <div className="grid gap-3">
          {history.map((approval) => (
            <Card key={approval.approvalId}>
              <CardContent className="flex items-center justify-between p-4">
                <div className="flex items-center gap-3">
                  <Shield className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">{approval.templateName}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatRelativeTime(approval.createdAt)} · v{approval.approvalVersion}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {approval.decisionActor && (
                    <span className="text-xs text-muted-foreground">
                      by {approval.decisionActor.principalId.slice(0, 12)}
                    </span>
                  )}
                  <StatusBadge status={approval.status} />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      <ConfirmDialog
        open={confirmAction !== null}
        onOpenChange={() => setConfirmAction(null)}
        title={`${confirmAction?.type === "approve" ? "Approve" : confirmAction?.type === "reject" ? "Reject" : "Request Changes"}`}
        description={`Are you sure you want to ${confirmAction?.type} this approval? This action is fenced and cannot be undone.`}
        confirmLabel={confirmAction?.type === "approve" ? "Approve" : confirmAction?.type === "reject" ? "Reject" : "Request Changes"}
        variant={confirmAction?.type === "reject" ? "destructive" : "default"}
        onConfirm={() => setConfirmAction(null)}
      />
    </PageLayout>
  );
}
