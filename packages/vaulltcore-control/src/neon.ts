/**
 * Neon PostgreSQL configuration helper.
 *
 * Provides utilities for validating and configuring Neon database connections.
 * Neon is a serverless PostgreSQL service with branching, autoscaling, and
 * connection pooling built-in.
 */

import type { PoolConfig } from "pg";

/**
 * Neon connection string validation result.
 */
export interface NeonConnectionResult {
  valid: boolean;
  error?: string;
  host?: string;
  database?: string;
  hasSSL?: boolean;
}

/**
 * Validate a Neon PostgreSQL connection string.
 *
 * Neon connection strings follow the format:
 * postgres://user:password@ep-xxx.region.aws.neon.tech/dbname?sslmode=require
 *
 * @param connectionString - The PostgreSQL connection string to validate
 * @returns Validation result with host and database info
 */
export function validateNeonConnectionString(
  connectionString: string
): NeonConnectionResult {
  try {
    const url = new URL(connectionString);

    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
      return { valid: false, error: "Invalid protocol. Expected postgres:// or postgresql://" };
    }

    const host = url.hostname;
    const database = url.pathname.slice(1); // Remove leading /
    const hasSSL = connectionString.includes("sslmode=require") || connectionString.includes("ssl=true");

    // Validate Neon host format (ep-xxx.region.aws.neon.tech)
    if (!host.endsWith(".neon.tech")) {
      return {
        valid: false,
        error: `Host ${host} does not appear to be a Neon endpoint. Expected format: ep-xxx.region.aws.neon.tech`,
      };
    }

    if (!database) {
      return { valid: false, error: "Missing database name in connection string" };
    }

    return {
      valid: true,
      host,
      database,
      hasSSL,
    };
  } catch (err) {
    return {
      valid: false,
      error: `Invalid connection string format: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Generate a Neon-optimized pool configuration.
 *
 * Neon recommends specific connection pool settings for optimal performance:
 * - SSL is required for all connections
 * - Connection pooling via PgBouncer is built-in
 * - Idle connections are cleaned up aggressively
 *
 * @param connectionString - Neon PostgreSQL connection string
 * @param options - Additional pool configuration options
 * @returns Pool configuration for use with pg Pool
 */
export function createNeonPoolConfig(
  connectionString: string,
  options: {
    maxConnections?: number;
    idleTimeoutMs?: number;
    connectionTimeoutMs?: number;
  } = {}
): PoolConfig {
  const validation = validateNeonConnectionString(connectionString);
  if (!validation.valid) {
    throw new Error(`Invalid Neon connection string: ${validation.error}`);
  }

  return {
    connectionString,
    ssl: { rejectUnauthorized: true },
    max: options.maxConnections ?? 10,
    idleTimeoutMillis: options.idleTimeoutMs ?? 30_000,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 10_000,
    // Neon handles connection pooling server-side, so we keep client-side pool small
  };
}

/**
 * Check if a database URL is a Neon endpoint.
 *
 * @param connectionString - The PostgreSQL connection string to check
 * @returns True if the connection string points to a Neon endpoint
 */
export function isNeonConnectionString(connectionString: string): boolean {
  try {
    const url = new URL(connectionString);
    return url.hostname.endsWith(".neon.tech");
  } catch {
    return false;
  }
}

/**
 * Neon branching utilities.
 *
 * Neon supports database branching for development workflows.
 * Branches are created via the Neon API and accessed via separate connection strings.
 */
export const NEON_BRANCHING = {
  /**
   * Main branch name in Neon.
   */
  MAIN_BRANCH: "main",

  /**
   * Prefix for development branch names.
   */
  DEV_BRANCH_PREFIX: "dev-",

  /**
   * Prefix for preview branch names (used with Vercel/Netlify preview deployments).
   */
  PREVIEW_BRANCH_PREFIX: "preview-",
} as const;
