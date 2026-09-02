import React, { useState, useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils"
import {
  LayoutDashboard,
  Zap,
  GitBranch,
  Clock,
  Bell,
  Plug,
  BarChart3,
  Settings,
  ChevronLeft,
  ChevronRight,
  Activity,
  Shield,
  Bot,
  FileCode,
  Play,
  AlertCircle,
  Layers,
  Users,
  Key,
  MonitorSmartphone,
} from "lucide-react";

interface NavItem {
  label: string;
  path: string;
  icon: React.ElementType;
  badge?: number;
}

const appNav: NavItem[] = [
  { label: "Dashboard", path: "/dashboard", icon: LayoutDashboard },
  { label: "Jobs", path: "/jobs", icon: Zap },
];

const automationNav: NavItem[] = [
  { label: "Templates", path: "/automation/templates", icon: FileCode },
  { label: "Runs", path: "/automation/runs", icon: Play },
  { label: "Schedules", path: "/automation/schedules", icon: Clock },
  { label: "Triggers", path: "/automation/triggers", icon: Bell },
  { label: "Approvals", path: "/approvals", icon: Shield },
];

const infraNav: NavItem[] = [
  { label: "Connections", path: "/connections", icon: Plug },
  { label: "Usage", path: "/usage", icon: BarChart3 },
  { label: "Operations", path: "/operations", icon: Activity },
];

const settingsNav: NavItem[] = [
  { label: "Settings", path: "/settings", icon: Settings },
  { label: "Members", path: "/settings/members", icon: Users },
  { label: "Service Identities", path: "/settings/service-identities", icon: Bot },
  { label: "Sessions", path: "/settings/sessions", icon: MonitorSmartphone },
];

function NavSection({
  title,
  items,
  collapsed,
}: {
  title: string;
  items: NavItem[];
  collapsed: boolean;
}) {
  const location = useLocation();

  return (
    <div className="mb-1">
      {!collapsed && (
        <div className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-sidebar-muted">
          {title}
        </div>
      )}
      {items.map((item) => {
        const isActive =
          location.pathname === item.path ||
          (item.path !== "/dashboard" && location.pathname.startsWith(item.path));
        const Icon = item.icon;

        return (
          <Link
            key={item.path}
            to={item.path}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              isActive
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
            )}
            title={collapsed ? item.label : undefined}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {!collapsed && (
              <>
                <span className="flex-1">{item.label}</span>
                {item.badge !== undefined && (
                  <span className="rounded-full bg-primary/20 px-1.5 py-0.5 text-xs text-primary">
                    {item.badge}
                  </span>
                )}
              </>
            )}
          </Link>
        );
      })}
    </div>
  );
}

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  // Close mobile drawer on navigation
  useEffect(() => { setMobileOpen(false); }, [location.pathname]);

  return (
    <>
      {/* Mobile hamburger button */}
      <button
        className="fixed top-3 left-3 z-50 flex h-10 w-10 items-center justify-center rounded-md border bg-background shadow-md lg:hidden"
        onClick={() => setMobileOpen(!mobileOpen)}
        aria-label="Toggle navigation"
      >
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          {mobileOpen ? (
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          ) : (
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          )}
        </svg>
      </button>

      {/* Mobile overlay */}
      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 bg-black/50 lg:hidden"
            onClick={() => setMobileOpen(false)}
          />
        )}
      </AnimatePresence>

      {/* Sidebar — fixed on mobile, static on desktop */}
      <aside
        className={cn(
          "flex h-screen flex-col border-r border-sidebar-border bg-sidebar transition-all duration-200",
          collapsed ? "w-16" : "w-60",
          // Mobile: overlay drawer
          "fixed z-40 lg:relative lg:z-auto",
          mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        )}
      >
      {/* Logo */}
      <div className="flex h-14 items-center border-b border-sidebar-border px-3">
        <Link to="/dashboard" className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground font-bold text-sm">
            V
          </div>
          {!collapsed && (
            <span className="text-sm font-semibold text-sidebar-foreground">
              Vaulltcore
            </span>
          )}
        </Link>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto p-2">
        <NavSection title="Overview" items={appNav} collapsed={collapsed} />
        <NavSection title="Automation" items={automationNav} collapsed={collapsed} />
        <NavSection title="Platform" items={infraNav} collapsed={collapsed} />
        <NavSection title="Admin" items={settingsNav} collapsed={collapsed} />
      </nav>

      {/* Collapse toggle (desktop only) */}
      <div className="hidden lg:block border-t border-sidebar-border p-2">
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="flex w-full items-center justify-center rounded-md p-2 text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? (
            <ChevronRight className="h-4 w-4" />
          ) : (
            <ChevronLeft className="h-4 w-4" />
          )}
        </button>
      </div>
    </aside>
    </>
  );
}
