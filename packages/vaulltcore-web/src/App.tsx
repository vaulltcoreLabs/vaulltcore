import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryProvider } from "@/lib/query-provider";
import { AuthProvider, useAuth, RequireAuth } from "@/lib/auth";
import { RepositoriesProvider } from "@/lib/repositories";
import { ToastProvider, Toaster } from "@/components/ui/toast";
import { Sidebar, Topbar } from "@/components/layout";

// Pages
import LandingPage from "@/pages/landing";
import AuthPage from "@/pages/auth";
import DashboardPage from "@/pages/dashboard";
import JobsPage from "@/pages/jobs";
import JobDetailPage from "@/pages/jobs/detail";
import TemplatesPage from "@/pages/automation/templates";
import TemplateDetailPage from "@/pages/automation/template-detail";
import RunsPage from "@/pages/automation/runs";
import RunDetailPage from "@/pages/automation/run-detail";
import SchedulesPage from "@/pages/automation/schedules";
import TriggersPage from "@/pages/automation/triggers";
import ApprovalsPage from "@/pages/automation/approvals";
import ConnectionsPage from "@/pages/connections";
import UsagePage from "@/pages/usage";
import OperationsPage from "@/pages/operations";
import SettingsPage from "@/pages/settings";
import MembersPage from "@/pages/settings/members";
import ServiceIdentitiesPage from "@/pages/settings/service-identities";
import SessionsPage from "@/pages/settings/sessions";

// App layout with sidebar + topbar
function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Topbar />
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}

// Router
function AppRoutes() {
  const { isAuthenticated } = useAuth();

  return (
    <Routes>
      {/* Public routes */}
      <Route path="/" element={<LandingPage />} />
      <Route path="/auth" element={<AuthPage />} />

      {/* Protected application routes */}
      <Route
        path="/dashboard"
        element={
          <RequireAuth>
            <AppLayout>
              <DashboardPage />
            </AppLayout>
          </RequireAuth>
        }
      />
      <Route
        path="/jobs"
        element={
          <RequireAuth>
            <AppLayout>
              <JobsPage />
            </AppLayout>
          </RequireAuth>
        }
      />
      <Route
        path="/jobs/:jobId"
        element={
          <RequireAuth>
            <AppLayout>
              <JobDetailPage />
            </AppLayout>
          </RequireAuth>
        }
      />

      {/* Automation routes */}
      <Route
        path="/automation/templates"
        element={
          <RequireAuth>
            <AppLayout>
              <TemplatesPage />
            </AppLayout>
          </RequireAuth>
        }
      />
      <Route
        path="/automation/templates/:templateId"
        element={
          <RequireAuth>
            <AppLayout>
              <TemplateDetailPage />
            </AppLayout>
          </RequireAuth>
        }
      />
      <Route
        path="/automation/runs"
        element={
          <RequireAuth>
            <AppLayout>
              <RunsPage />
            </AppLayout>
          </RequireAuth>
        }
      />
      <Route
        path="/automation/runs/:runId"
        element={
          <RequireAuth>
            <AppLayout>
              <RunDetailPage />
            </AppLayout>
          </RequireAuth>
        }
      />
      <Route
        path="/automation/schedules"
        element={
          <RequireAuth>
            <AppLayout>
              <SchedulesPage />
            </AppLayout>
          </RequireAuth>
        }
      />
      <Route
        path="/automation/triggers"
        element={
          <RequireAuth>
            <AppLayout>
              <TriggersPage />
            </AppLayout>
          </RequireAuth>
        }
      />
      <Route
        path="/approvals"
        element={
          <RequireAuth>
            <AppLayout>
              <ApprovalsPage />
            </AppLayout>
          </RequireAuth>
        }
      />

      {/* Platform routes */}
      <Route
        path="/connections"
        element={
          <RequireAuth>
            <AppLayout>
              <ConnectionsPage />
            </AppLayout>
          </RequireAuth>
        }
      />
      <Route
        path="/usage"
        element={
          <RequireAuth>
            <AppLayout>
              <UsagePage />
            </AppLayout>
          </RequireAuth>
        }
      />
      <Route
        path="/operations"
        element={
          <RequireAuth>
            <AppLayout>
              <OperationsPage />
            </AppLayout>
          </RequireAuth>
        }
      />

      {/* Settings routes */}
      <Route
        path="/settings"
        element={
          <RequireAuth>
            <AppLayout>
              <SettingsPage />
            </AppLayout>
          </RequireAuth>
        }
      />
      <Route
        path="/settings/members"
        element={
          <RequireAuth>
            <AppLayout>
              <MembersPage />
            </AppLayout>
          </RequireAuth>
        }
      />
      <Route
        path="/settings/service-identities"
        element={
          <RequireAuth>
            <AppLayout>
              <ServiceIdentitiesPage />
            </AppLayout>
          </RequireAuth>
        }
      />
      <Route
        path="/settings/sessions"
        element={
          <RequireAuth>
            <AppLayout>
              <SessionsPage />
            </AppLayout>
          </RequireAuth>
        }
      />

      {/* Redirect unknown routes to dashboard if auth'd, landing if not */}
      <Route
        path="*"
        element={
          isAuthenticated ? <Navigate to="/dashboard" replace /> : <Navigate to="/" replace />
        }
      />
    </Routes>
  );
}

// Root App
export default function App() {
  return (
    <BrowserRouter>
      <QueryProvider>
        <AuthProvider>
          <RepositoriesProvider>
            <ToastProvider>
              <AppRoutes />
              <Toaster />
            </ToastProvider>
          </RepositoriesProvider>
        </AuthProvider>
      </QueryProvider>
    </BrowserRouter>
  );
}
