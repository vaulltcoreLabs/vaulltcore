import React from "react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageLayout, ConfirmDialog } from "@/components/layout";
import { formatRelativeTime } from "@/lib/formatting";
import { Bot, Plus, Key, Eye, EyeOff, Copy, ChevronLeft, Shield } from "lucide-react";

const mockServiceIdentities = [
  {
    serviceIdentityId: "si_01HXYZ111",
    name: "CI/CD Pipeline",
    status: "active",
    permissions: ["jobs.create", "runs.create", "connections.read"],
    createdAt: Date.now() - 2592000000,
    disabledAt: null,
    revokedAt: null,
    credentialCount: 2,
  },
  {
    serviceIdentityId: "si_01HXYZ222",
    name: "Monitoring Agent",
    status: "active",
    permissions: ["jobs.read", "runs.read", "usage.read"],
    createdAt: Date.now() - 1296000000,
    disabledAt: null,
    revokedAt: null,
    credentialCount: 1,
  },
  {
    serviceIdentityId: "si_01HXYZ333",
    name: "Legacy Bot",
    status: "revoked",
    permissions: ["jobs.create"],
    createdAt: Date.now() - 3888000000,
    disabledAt: Date.now() - 604800000,
    revokedAt: Date.now() - 604800000,
    credentialCount: 0,
  },
];

export default function ServiceIdentitiesPage() {
  const [showSecret, setShowSecret] = React.useState(false);
  const [issuedSecret, setIssuedSecret] = React.useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = React.useState<string | null>(null);

  const handleIssueCredential = async () => {
    // In real mode, this calls POST /identity/service-identities/:id/credentials
    // The secret is returned ONCE and must be shown to the user
    setIssuedSecret("vc_sk_live_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0");
    setShowSecret(true);
  };

  return (
    <PageLayout
      title="Service Identities"
      description="Manage machine accounts, API credentials, and their permissions"
      actions={
        <Button>
          <Plus className="mr-2 h-4 w-4" />
          New Service Identity
        </Button>
      }
    >
      <div className="mb-4">
        <Link to="/settings" className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1">
          <ChevronLeft className="h-3 w-3" /> Back to Settings
        </Link>
      </div>

      {/* Secret Reveal — one-time display */}
      {showSecret && issuedSecret && (
        <Card className="mb-6 border-success/30 bg-success/5">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Key className="h-4 w-4 text-success" />
              Credential Issued
            </CardTitle>
            <CardDescription>
              This secret will NOT be shown again. Copy it now and store it securely.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2 rounded-md border bg-background p-3">
              <code className="flex-1 font-mono text-sm break-all">
                {issuedSecret}
              </code>
              <Button
                size="sm"
                variant="outline"
                onClick={() => navigator.clipboard.writeText(issuedSecret)}
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
            <div className="mt-3 flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setShowSecret(false)}>
                <EyeOff className="mr-1 h-3.5 w-3.5" />
                Hide
              </Button>
              <Button size="sm" onClick={() => { setIssuedSecret(null); setShowSecret(false); }}>
                Continue
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Permissions</TableHead>
                <TableHead>Credentials</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {mockServiceIdentities.map((si) => (
                <TableRow key={si.serviceIdentityId}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Bot className="h-4 w-4 text-muted-foreground" />
                      <span className="font-medium">{si.name}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={si.status} />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {si.permissions.slice(0, 3).map((p) => (
                        <Badge key={p} variant="secondary" className="text-[10px]">
                          {p}
                        </Badge>
                      ))}
                      {si.permissions.length > 3 && (
                        <Badge variant="secondary" className="text-[10px]">
                          +{si.permissions.length - 3}
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-sm">{si.credentialCount}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatRelativeTime(si.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      {si.status === "active" && (
                        <>
                          <Button size="sm" variant="outline" onClick={handleIssueCredential}>
                            <Key className="mr-1 h-3 w-3" />
                            Issue Key
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive hover:text-destructive"
                            onClick={() => setConfirmRevoke(si.serviceIdentityId)}
                          >
                            Revoke
                          </Button>
                        </>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmRevoke !== null}
        onOpenChange={() => setConfirmRevoke(null)}
        title="Revoke Service Identity"
        description="This will immediately revoke all credentials for this identity and disable it. This action cannot be undone."
        confirmLabel="Revoke Identity"
        variant="destructive"
        onConfirm={() => setConfirmRevoke(null)}
      />
    </PageLayout>
  );
}
