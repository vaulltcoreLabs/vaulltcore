import React from "react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/badge";
import { PageLayout, DataViewState } from "@/components/layout";
import { formatRelativeTime } from "@/lib/formatting";
import { Plus, FileCode, ArrowRight } from "lucide-react";

const mockTemplates = [
  {
    templateId: "tmpl_01HXYZAAAA",
    name: "Deploy to Staging",
    description: "Automated deployment pipeline for staging environment with approval gate",
    status: "active",
    createdAt: Date.now() - 604800000,
    createdBy: "user_admin",
    versionCount: 3,
    runCount: 24,
  },
  {
    templateId: "tmpl_01HXYZBBBB",
    name: "PR Review Automation",
    description: "Automated code review with AI-powered suggestions and approval workflow",
    status: "active",
    createdAt: Date.now() - 2592000000,
    createdBy: "user_admin",
    versionCount: 7,
    runCount: 156,
  },
  {
    templateId: "tmpl_01HXYZCCCC",
    name: "E2E Test Suite",
    description: "End-to-end integration testing with artifact collection and delivery",
    status: "active",
    createdAt: Date.now() - 1296000000,
    createdBy: "user_dev",
    versionCount: 5,
    runCount: 89,
  },
  {
    templateId: "tmpl_01HXYZDDDD",
    name: "Legacy Migration",
    description: "Data migration automation (archived — no longer in active use)",
    status: "archived",
    createdAt: Date.now() - 3888000000,
    createdBy: "user_admin",
    versionCount: 2,
    runCount: 4,
  },
];

export default function TemplatesPage() {
  return (
    <PageLayout
      title="Automation Templates"
      description="Manage automation templates — versioned definitions for repeatable workflows"
      actions={
        <Button>
          <Plus className="mr-2 h-4 w-4" />
          New Template
        </Button>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {mockTemplates.map((template) => (
          <Card key={template.templateId} className="transition-colors hover:bg-accent/30">
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10">
                    <FileCode className="h-4 w-4 text-primary" />
                  </div>
                  <div>
                    <CardTitle className="text-sm">{template.name}</CardTitle>
                  </div>
                </div>
                <StatusBadge status={template.status} />
              </div>
            </CardHeader>
            <CardContent>
              <p className="mb-3 text-xs text-muted-foreground line-clamp-2">
                {template.description}
              </p>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <div className="flex gap-3">
                  <span>{template.versionCount} versions</span>
                  <span>{template.runCount} runs</span>
                </div>
                <span>{formatRelativeTime(template.createdAt)}</span>
              </div>
              <Link to={`/automation/templates/${template.templateId}`}>
                <Button variant="ghost" size="sm" className="mt-3 w-full">
                  View details <ArrowRight className="ml-1 h-3 w-3" />
                </Button>
              </Link>
            </CardContent>
          </Card>
        ))}
      </div>
    </PageLayout>
  );
}
