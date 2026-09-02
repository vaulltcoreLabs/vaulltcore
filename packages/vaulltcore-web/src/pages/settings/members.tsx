import React from "react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageLayout, ConfirmDialog } from "@/components/layout";
import { formatRelativeTime } from "@/lib/formatting";
import { Users, UserPlus, Shield, ChevronLeft } from "lucide-react";

const mockMembers = [
  { principalId: "user_admin_01", role: "admin", createdAt: Date.now() - 3888000000 },
  { principalId: "user_dev_01", role: "developer", createdAt: Date.now() - 2592000000 },
  { principalId: "user_dev_02", role: "developer", createdAt: Date.now() - 1296000000 },
  { principalId: "user_ops_01", role: "operator", createdAt: Date.now() - 604800000 },
  { principalId: "user_viewer_01", role: "viewer", createdAt: Date.now() - 302400000 },
];

const roleColors: Record<string, string> = {
  owner: "bg-primary/10 text-primary",
  admin: "bg-info/10 text-info",
  developer: "bg-success/10 text-success",
  operator: "bg-warning/10 text-warning",
  viewer: "bg-muted text-muted-foreground",
};

export default function MembersPage() {
  const [confirmRemove, setConfirmRemove] = React.useState<string | null>(null);

  return (
    <PageLayout
      title="Members"
      description="Manage team members and their roles"
      actions={
        <Button>
          <UserPlus className="mr-2 h-4 w-4" />
          Invite Member
        </Button>
      }
    >
      <div className="mb-4">
        <Link to="/settings" className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1">
          <ChevronLeft className="h-3 w-3" /> Back to Settings
        </Link>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Principal</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Joined</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {mockMembers.map((member) => (
                <TableRow key={member.principalId}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-xs font-medium">
                        {member.principalId.slice(-2).toUpperCase()}
                      </div>
                      <span className="font-mono text-sm">{member.principalId}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ${roleColors[member.role] || ""}`}>
                      {member.role}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatRelativeTime(member.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive">
                      Remove
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </PageLayout>
  );
}
