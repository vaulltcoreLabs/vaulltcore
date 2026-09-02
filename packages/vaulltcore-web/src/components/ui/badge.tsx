import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        destructive: "border-transparent bg-destructive text-destructive-foreground",
        outline: "text-foreground",
        success: "border-transparent bg-success text-white",
        warning: "border-transparent bg-warning text-white",
        info: "border-transparent bg-info text-white",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

// Status-specific badges for Vaulltcore entities
export function StatusBadge({ status }: { status: string }) {
  const variant = getStatusVariant(status);
  return <Badge variant={variant}>{formatStatus(status)}</Badge>;
}

function getStatusVariant(status: string): "default" | "secondary" | "destructive" | "success" | "warning" | "info" {
  const s = status.toLowerCase();
  if (s === "completed" || s === "active" || s === "approved" || s === "delivered" || s === "enabled" || s === "succeeded") return "success";
  if (s === "failed" || s === "cancelled" || s === "revoked" || s === "rejected" || s === "dead_letter") return "destructive";
  if (s === "running" || s === "admitted" || s === "collecting" || s === "delivering" || s === "in_progress" || s === "authorization_pending" || s === "authorization_verified") return "info";
  if (s === "awaiting_approval" || s === "pending" || s === "created" || s === "validating_input" || s === "queued" || s === "leased" || s === "preparing") return "warning";
  if (s === "paused" || s === "suspended" || s === "degraded" || s === "expired" || s === "disabled") return "secondary";
  return "default";
}

function formatStatus(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export { Badge, badgeVariants };
