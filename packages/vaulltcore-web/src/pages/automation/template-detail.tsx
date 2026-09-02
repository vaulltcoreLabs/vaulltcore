import React, { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { useRepositories } from "@/lib/repositories";
import { useToast } from "@/components/ui/toast";
import { formatDateTime, formatRelativeTime } from "@/lib/formatting";
import type { AutomationTemplate, AutomationVersion } from "@/types";
import {
  ChevronLeft, FileCode, Shield, Package, Truck, AlertTriangle,
  Plus, Eye,
} from "lucide-react";

export default function TemplateDetailPage() {
  const { templateId } = useParams<{ templateId: string }>();
  const repos = useRepositories();
  const { toast } = useToast();
  const [template, setTemplate] = useState<AutomationTemplate | null>(null);
  const [versions, setVersions] = useState<AutomationVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<AutomationVersion | null>(null);
  const [activeTab, setActiveTab] = useState("versions");

  useEffect(() => {
    if (!templateId) return;
    let cancelled = false;
    (async () => {
      try {
        const [tmplData, versionsData] = await Promise.all([
          // Get template from list (no single GET endpoint)
          repos.automation.templates.list().then(r => r.templates.find(t => t.templateId === templateId)),
          repos.automation.templates.versions(templateId),
        ]);
        if (!cancelled) {
          setTemplate(tmplData || null);
          setVersions(versionsData?.versions || []);
          // Auto-select latest version
          const sorted = [...(versionsData?.versions || [])].sort((a, b) => b.version - a.version);
          setSelectedVersion(sorted[0] || null);
          setLoading(false);
        }
      } catch (e: unknown) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load template");
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [templateId, repos.automation.templates]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-2"><ChevronLeft className="h-4 w-4" /><Skeleton className="h-4 w-20" /></div>
        <Skeleton className="h-12 w-64" />
        <Skeleton className="h-96" />
      </div>
    );
  }

  if (error || !template) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <AlertTriangle className="h-12 w-12 text-muted-foreground mb-4" />
        <h2 className="text-lg font-semibold">Template Not Found</h2>
        <p className="text-sm text-muted-foreground mt-1">{error || "The requested template does not exist or is not accessible."}</p>
        <Link to="/automation/templates"><Button variant="outline" className="mt-4">Back to Templates</Button></Link>
      </div>
    );
  }

  const latestVersion = [...versions].sort((a, b) => b.version - a.version)[0];

  return (
    <div className="animate-fade-in space-y-6">
      {/* Header */}
      <div>
        <Link to="/automation/templates" className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1 mb-3">
          <ChevronLeft className="h-3 w-3" /> Back to Templates
        </Link>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <FileCode className="h-5 w-5 text-primary" />
              </div>
              <div>
                <h1 className="text-2xl font-bold tracking-tight">{template.name}</h1>
                <p className="text-sm text-muted-foreground">{template.description}</p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge status={template.status} />
            {latestVersion && <Badge variant="outline">Latest: v{latestVersion.version}</Badge>}
            <Badge variant="secondary">{versions.length} version{versions.length !== 1 ? "s" : ""}</Badge>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="versions" value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="versions">Versions</TabsTrigger>
          <TabsTrigger value="definition">Definition</TabsTrigger>
          <TabsTrigger value="input">Input Contract</TabsTrigger>
          <TabsTrigger value="overview">Overview</TabsTrigger>
        </TabsList>

        {/* Versions Tab */}
        <TabsContent value="versions">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle className="text-base">Versions</CardTitle>
                <CardDescription>Immutable versioned automation definitions</CardDescription>
              </div>
              <Button size="sm">
                <Plus className="mr-1 h-3.5 w-3.5" /> New Version
              </Button>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Version</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Checksum</TableHead>
                    <TableHead>Steps</TableHead>
                    <TableHead>Input Fields</TableHead>
                    <TableHead>Approval</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {versions.sort((a, b) => b.version - a.version).map((v) => (
                    <TableRow
                      key={v.versionId}
                      className={selectedVersion?.versionId === v.versionId ? "bg-accent/50" : ""}
                    >
                      <TableCell>
                        <span className="font-mono font-bold">v{v.version}</span>
                        <span className="ml-2 text-[10px] text-muted-foreground">{v.versionId}</span>
                      </TableCell>
                      <TableCell><StatusBadge status={v.status} /></TableCell>
                      <TableCell className="font-mono text-[10px] text-muted-foreground">{v.checksum.slice(0, 20)}…</TableCell>
                      <TableCell className="font-mono text-sm">{v.definition.steps.length}</TableCell>
                      <TableCell className="font-mono text-sm">{v.inputContract.fields.length}</TableCell>
                      <TableCell>
                        {v.definition.approval.required ? (
                          <Badge variant="warning" className="gap-1 text-[10px]">
                            <Shield className="h-2.5 w-2.5" /> Required
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="text-[10px]">None</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{formatRelativeTime(v.createdAt)}</TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="ghost" onClick={() => setSelectedVersion(v)}>
                          <Eye className="h-3.5 w-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Definition Tab */}
        <TabsContent value="definition">
          {selectedVersion ? (
            <div className="space-y-6">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span>Viewing:</span>
                <Badge variant="outline">v{selectedVersion.version}</Badge>
                <span className="font-mono text-xs">{selectedVersion.checksum}</span>
              </div>

              {/* Steps */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Steps ({selectedVersion.definition.steps.length})</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {selectedVersion.definition.steps.map((step, i) => (
                      <div key={step.stepId} className="flex items-start gap-3 rounded-lg border p-4">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
                          {i + 1}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{step.stepId}</span>
                            <Badge variant="secondary" className="text-[10px]">{step.type}</Badge>
                            {step.dependsOn && step.dependsOn.length > 0 && (
                              <Badge variant="outline" className="text-[10px]">
                                depends on: {step.dependsOn.join(", ")}
                              </Badge>
                            )}
                          </div>
                          {step.config && (
                            <pre className="mt-2 rounded bg-muted p-2 text-xs font-mono overflow-x-auto">
                              {JSON.stringify(step.config, null, 2)}
                            </pre>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              {/* Artifacts */}
              {selectedVersion.definition.artifacts.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                      <Package className="h-4 w-4" /> Artifacts
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      {selectedVersion.definition.artifacts.map((art, i) => (
                        <div key={i} className="flex items-center gap-3 rounded border p-3">
                          <Badge variant="outline">{art.type}</Badge>
                          <span className="text-sm">{art.name}</span>
                          {art.stepId && <span className="text-xs text-muted-foreground">from {art.stepId}</span>}
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Approval Gate */}
              {selectedVersion.definition.approval.required && (
                <Card className="border-warning/30">
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                      <Shield className="h-4 w-4 text-warning" /> Approval Gate
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between"><span className="text-muted-foreground">Required</span><span>Yes</span></div>
                      {selectedVersion.definition.approval.minApproverRole && (
                        <div className="flex justify-between"><span className="text-muted-foreground">Min Role</span><span>{selectedVersion.definition.approval.minApproverRole}</span></div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Delivery */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Truck className="h-4 w-4" /> Delivery
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between"><span className="text-muted-foreground">Type</span><Badge variant="outline">{selectedVersion.definition.delivery.type}</Badge></div>
                    {selectedVersion.definition.delivery.config && (
                      <pre className="rounded bg-muted p-2 text-xs font-mono overflow-x-auto">
                        {JSON.stringify(selectedVersion.definition.delivery.config, null, 2)}
                      </pre>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>
          ) : (
            <Card>
              <CardContent className="py-8 text-center">
                <p className="text-sm text-muted-foreground">Select a version to view its definition</p>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Input Contract Tab */}
        <TabsContent value="input">
          {selectedVersion ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Input Contract</CardTitle>
                <CardDescription>Fields accepted by this version's input validation</CardDescription>
              </CardHeader>
              <CardContent>
                {selectedVersion.inputContract.fields.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-4">No input fields defined</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Field ID</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Required</TableHead>
                        <TableHead>Description</TableHead>
                        <TableHead>Constraints</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {selectedVersion.inputContract.fields.map((field) => (
                        <TableRow key={field.fieldId}>
                          <TableCell className="font-mono text-sm font-medium">{field.fieldId}</TableCell>
                          <TableCell><Badge variant="secondary">{field.type}</Badge></TableCell>
                          <TableCell>
                            {field.required ? (
                              <Badge variant="warning" className="text-[10px]">Required</Badge>
                            ) : (
                              <Badge variant="outline" className="text-[10px]">Optional</Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">{field.description || "—"}</TableCell>
                          <TableCell>
                            <div className="flex flex-wrap gap-1">
                              {field.min != null && <Badge variant="outline" className="text-[10px]">min: {field.min}</Badge>}
                              {field.max != null && <Badge variant="outline" className="text-[10px]">max: {field.max}</Badge>}
                              {field.enum && <Badge variant="outline" className="text-[10px]">enum: {field.enum.join(", ")}</Badge>}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="py-8 text-center">
                <p className="text-sm text-muted-foreground">Select a version to view its input contract</p>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Overview Tab */}
        <TabsContent value="overview">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Template Overview</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-3">
                  <div className="flex justify-between text-sm"><span className="text-muted-foreground">Template ID</span><span className="font-mono text-xs">{template.templateId}</span></div>
                  <div className="flex justify-between text-sm"><span className="text-muted-foreground">Name</span><span>{template.name}</span></div>
                  <div className="flex justify-between text-sm"><span className="text-muted-foreground">Status</span><StatusBadge status={template.status} /></div>
                  <div className="flex justify-between text-sm"><span className="text-muted-foreground">Versions</span><span>{versions.length}</span></div>
                </div>
                <div className="space-y-3">
                  <div className="flex justify-between text-sm"><span className="text-muted-foreground">Created</span><span>{formatDateTime(template.createdAt)}</span></div>
                  <div className="flex justify-between text-sm"><span className="text-muted-foreground">Created By</span><span>{template.createdBy}</span></div>
                  <div className="flex justify-between text-sm"><span className="text-muted-foreground">Tenant</span><span className="font-mono text-xs">{template.tenantId}</span></div>
                  <div className="flex justify-between text-sm"><span className="text-muted-foreground">Org</span><span className="font-mono text-xs">{template.orgId || "—"}</span></div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
