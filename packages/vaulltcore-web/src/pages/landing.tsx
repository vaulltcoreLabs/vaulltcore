import React from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Zap,
  Shield,
  Clock,
  Activity,
  Plug,
  BarChart3,
  Eye,
  Play,
  ArrowRight,
  Check,
  Bot,
  GitBranch,
  Webhook,
  Bell,
  FileCode,
  Cpu,
  ChevronRight,
} from "lucide-react";

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background">
      {/* Navigation */}
      <nav className="fixed top-0 z-50 w-full border-b bg-background/80 backdrop-blur-lg">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground font-bold text-sm">
              V
            </div>
            <span className="text-lg font-semibold tracking-tight">Vaulltcore</span>
          </div>
          <div className="hidden md:flex items-center gap-8 text-sm text-muted-foreground">
            <a href="#product" className="hover:text-foreground transition-colors">Product</a>
            <a href="#features" className="hover:text-foreground transition-colors">Features</a>
            <a href="#integrations" className="hover:text-foreground transition-colors">Integrations</a>
            <a href="#security" className="hover:text-foreground transition-colors">Security</a>
          </div>
          <div className="flex items-center gap-3">
            <Link to="/auth">
              <Button variant="ghost" size="sm">Sign In</Button>
            </Link>
            <Link to="/auth">
              <Button size="sm">Get Started</Button>
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="pt-32 pb-20 px-6">
        <div className="mx-auto max-w-4xl text-center">
          <Badge variant="outline" className="mb-6">
            <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-success animate-pulse-soft" />
            AI Engineering Automation Platform
          </Badge>
          <h1 className="text-5xl font-bold tracking-tight sm:text-6xl lg:text-7xl">
            Automate engineering
            <br />
            <span className="text-primary">with confidence</span>
          </h1>
          <p className="mt-6 text-lg text-muted-foreground max-w-2xl mx-auto">
            Turn engineering workflows into durable, observable, controlled automations.
            Built for teams that need reliability, not promises.
          </p>
          <div className="mt-8 flex items-center justify-center gap-4">
            <Link to="/auth">
              <Button size="lg" className="px-8">
                Start Building
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
            <Link to="/dashboard">
              <Button size="lg" variant="outline" className="px-8">
                View Dashboard
              </Button>
            </Link>
          </div>

          {/* Dashboard Preview */}
          <div className="mt-16 rounded-xl border bg-card p-2 shadow-2xl">
            <div className="rounded-lg bg-muted/30 p-6">
              <DashboardPreview />
            </div>
          </div>
        </div>
      </section>

      {/* Features Grid */}
      <section id="features" className="py-20 px-6 bg-muted/30">
        <div className="mx-auto max-w-6xl">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold tracking-tight">Built for real automation</h2>
            <p className="mt-3 text-muted-foreground">
              Every feature designed for reliability, observability, and control.
            </p>
          </div>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            <FeatureCard
              icon={FileCode}
              title="Versioned Templates"
              description="Immutable automation definitions with checksummed input contracts. Every run traceable to a specific version."
            />
            <FeatureCard
              icon={Shield}
              title="Approval Gates"
              description="Fenced approval workflows with version locking. No stale decisions, no contradictions."
            />
            <FeatureCard
              icon={Activity}
              title="Live Execution"
              description="SSE-powered real-time event streams. Watch your automations execute with cursor-resumable events."
            />
            <FeatureCard
              icon={Clock}
              title="Durable Schedules"
              description="Cron and one-time schedules with deterministic occurrence IDs. Crash-safe execution guarantees."
            />
            <FeatureCard
              icon={Plug}
              title="Integration Hub"
              description="OAuth connections with automatic refresh. GitHub, GitLab, Linear, Slack, and custom webhooks."
            />
            <FeatureCard
              icon={BarChart3}
              title="Usage Analytics"
              description="Token-level, model-level, and provider-level usage tracking with immutable ledger history."
            />
            <FeatureCard
              icon={Bot}
              title="Service Identities"
              description="Machine accounts with scoped permissions, credential lifecycle, and audit trail."
            />
            <FeatureCard
              icon={Eye}
              title="Operations Dashboard"
              description="System health, retry queues, dead letter management, and reconciliation — all in one view."
            />
            <FeatureCard
              icon={Webhook}
              title="Webhook Triggers"
              description="Declarative trigger matching with deterministic event IDs. Duplicate-safe webhook processing."
            />
          </div>
        </div>
      </section>

      {/* Workflow */}
      <section id="product" className="py-20 px-6">
        <div className="mx-auto max-w-6xl">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold tracking-tight">How it works</h2>
            <p className="mt-3 text-muted-foreground">
              From definition to execution to delivery — every step is durable and observable.
            </p>
          </div>
          <div className="grid gap-8 md:grid-cols-4">
            {[
              { step: "1", title: "Define", desc: "Create a versioned template with steps, input contracts, and approval gates", icon: FileCode },
              { step: "2", title: "Trigger", desc: "Start runs via webhook, schedule, manual invoke, or API", icon: Bell },
              { step: "3", title: "Execute", desc: "Durable execution with checkpointing, event logs, and live streaming", icon: Play },
              { step: "4", title: "Deliver", desc: "At-least-once delivery with idempotent settlement", icon: Zap },
            ].map((item) => (
              <div key={item.step} className="relative text-center">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary text-lg font-bold">
                  {item.step}
                </div>
                <h3 className="text-lg font-semibold">{item.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{item.desc}</p>
                {item.step !== "4" && (
                  <ChevronRight className="absolute right-0 top-6 hidden h-5 w-5 text-muted-foreground md:block" />
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Integrations */}
      <section id="integrations" className="py-20 px-6 bg-muted/30">
        <div className="mx-auto max-w-6xl">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold tracking-tight">Connects to everything</h2>
            <p className="mt-3 text-muted-foreground">
              OAuth-secured connections with automatic refresh and capability discovery.
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-4">
            {[
              { name: "GitHub", icon: GitBranch },
              { name: "GitLab", icon: GitBranch },
              { name: "Linear", icon: Bot },
              { name: "Slack", icon: Bell },
              { name: "OpenAI", icon: Cpu },
              { name: "Anthropic", icon: Cpu },
            ].map((provider) => {
              const Icon = provider.icon;
              return (
                <div key={provider.name} className="flex items-center gap-2 rounded-lg border bg-card px-4 py-3">
                  <Icon className="h-5 w-5 text-muted-foreground" />
                  <span className="text-sm font-medium">{provider.name}</span>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Security */}
      <section id="security" className="py-20 px-6">
        <div className="mx-auto max-w-4xl">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold tracking-tight">Security by design</h2>
            <p className="mt-3 text-muted-foreground">
              Multi-tenant isolation, credential hygiene, and operational safety built into every layer.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {[
              "Cross-tenant isolation via 404 (no existence leak)",
              "Secrets never returned after initial issuance",
              "SHA-256 fingerprint-only credential storage",
              "Fenced CAS on every state-changing write",
              "Idempotency keys prevent duplicate operations",
              "SSRF protection on all outbound requests",
              "Audit trail for every lifecycle event",
              "Session-based auth with Better Auth integration",
            ].map((item) => (
              <div key={item} className="flex items-start gap-3 rounded-lg border p-4">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                <span className="text-sm">{item}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-20 px-6">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="text-4xl font-bold tracking-tight">Ready to automate with confidence?</h2>
          <p className="mt-4 text-lg text-muted-foreground">
            Start building durable automations today. Your first runs are on us.
          </p>
          <div className="mt-8">
            <Link to="/auth">
              <Button size="lg" className="px-8">
                Get Started Free
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t py-12 px-6">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-6 sm:flex-row">
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded bg-primary text-primary-foreground font-bold text-[10px]">
              V
            </div>
            <span className="text-sm font-medium">Vaulltcore</span>
            <span className="text-xs text-muted-foreground">© {new Date().getFullYear()}</span>
          </div>
          <div className="flex items-center gap-6 text-sm text-muted-foreground">
            <a href="#product" className="hover:text-foreground">Product</a>
            <a href="#features" className="hover:text-foreground">Features</a>
            <a href="#security" className="hover:text-foreground">Security</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function FeatureCard({
  icon: Icon,
  title,
  description,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
}) {
  return (
    <Card className="transition-colors hover:bg-accent/30">
      <CardContent className="p-5">
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
          <Icon className="h-5 w-5 text-primary" />
        </div>
        <h3 className="font-semibold">{title}</h3>
        <p className="mt-1.5 text-sm text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  );
}

// Dashboard preview used in the hero — reuses actual dashboard components
function DashboardPreview() {
  return (
    <div className="grid grid-cols-4 gap-3">
      <MiniCard label="Active Runs" value="3" color="bg-info" />
      <MiniCard label="Jobs" value="47" color="bg-primary" />
      <MiniCard label="Approvals" value="2" color="bg-warning" />
      <MiniCard label="Schedules" value="5" color="bg-success" />
      <div className="col-span-4 mt-2 rounded border bg-card/50 p-3">
        <div className="flex items-center gap-2 mb-2">
          <div className="h-2 w-2 rounded-full bg-info animate-pulse-soft" />
          <span className="text-xs text-muted-foreground font-medium">Recent Activity</span>
        </div>
        <div className="space-y-1.5">
          {["Deploy Pipeline — running", "Code Review — completed", "Production Deploy — awaiting approval"].map((item) => (
            <div key={item} className="flex items-center gap-2 text-xs text-muted-foreground/70">
              <div className="h-1 w-1 rounded-full bg-muted-foreground/30" />
              {item}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function MiniCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="rounded border bg-card/50 p-2.5">
      <p className="text-[10px] text-muted-foreground/70">{label}</p>
      <p className="text-lg font-bold">{value}</p>
    </div>
  );
}
