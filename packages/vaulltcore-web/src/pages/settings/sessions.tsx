import React from "react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageLayout, ConfirmDialog } from "@/components/layout";
import { formatRelativeTime, formatDateTime } from "@/lib/formatting";
import { MonitorSmartphone, ChevronLeft, ShieldAlert } from "lucide-react";

const mockSessions = [
  {
    sessionId: "sess_001",
    fingerprint: "a1b2c3d4",
    createdAt: Date.now() - 86400000,
    lastSeenAt: Date.now() - 3600000,
    expiresAt: Date.now() + 604800000,
    isCurrent: true,
  },
  {
    sessionId: "sess_002",
    fingerprint: "e5f6g7h8",
    createdAt: Date.now() - 604800000,
    lastSeenAt: Date.now() - 259200000,
    expiresAt: Date.now() + 259200000,
    isCurrent: false,
  },
  {
    sessionId: "sess_003",
    fingerprint: "i9j0k1l2",
    createdAt: Date.now() - 1296000000,
    lastSeenAt: Date.now() - 1296000000,
    expiresAt: Date.now() - 86400000,
    isCurrent: false,
  },
];

export default function SessionsPage() {
  const [confirmRevokeAll, setConfirmRevokeAll] = React.useState(false);

  return (
    <PageLayout
      title="Sessions"
      description="Manage active sessions and revoke access when needed"
    >
      <div className="mb-4">
        <Link to="/settings" className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1">
          <ChevronLeft className="h-3 w-3" /> Back to Settings
        </Link>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">Active Sessions</CardTitle>
            <CardDescription>{mockSessions.length} session(s) found</CardDescription>
          </div>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setConfirmRevokeAll(true)}
          >
            <ShieldAlert className="mr-1 h-3.5 w-3.5" />
            Revoke All Others
          </Button>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Session</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Last Active</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {mockSessions.map((session) => {
                const isExpired = session.expiresAt < Date.now();
                return (
                  <TableRow key={session.sessionId}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <MonitorSmartphone className="h-4 w-4 text-muted-foreground" />
                        <div>
                          <span className="font-mono text-xs">{session.fingerprint}</span>
                          <p className="text-[10px] text-muted-foreground">{session.sessionId.slice(0, 16)}…</p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatRelativeTime(session.createdAt)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatRelativeTime(session.lastSeenAt)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDateTime(session.expiresAt)}
                    </TableCell>
                    <TableCell>
                      {session.isCurrent ? (
                        <Badge variant="success">Current</Badge>
                      ) : isExpired ? (
                        <Badge variant="secondary">Expired</Badge>
                      ) : (
                        <Badge variant="outline">Active</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmRevokeAll}
        onOpenChange={() => setConfirmRevokeAll(false)}
        title="Revoke All Other Sessions"
        description="This will immediately terminate all other active sessions. Users will need to sign in again."
        confirmLabel="Revoke All"
        variant="destructive"
        onConfirm={() => setConfirmRevokeAll(false)}
      />
    </PageLayout>
  );
}
