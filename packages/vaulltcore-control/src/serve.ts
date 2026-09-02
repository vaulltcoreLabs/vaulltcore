/**
 * Vaulltcore production server entrypoint.
 *
 * Wires up the durable stores, execution runner, and control plane,
 * then starts the HTTP server. This is the process that Fly.io runs.
 */

import { createServer } from "node:http"
import { ControlPlane } from "./server.js"
import { NodeSqliteDatabase, SqlJobStore, DistributedSqlStore, SqlDispatcher, SqlStoreBase } from "@vaulltcore/store-sql"
import { WorkerHost, newWorkerIdentity } from "@vaulltcore/worker"
import { buildOpenCodeRunner } from "./execution.js"
import { SqlIdentityStore } from "@vaulltcore/identity"
import { SqlPolicyStore } from "@vaulltcore/policy"
import { SqlQuotaStore } from "@vaulltcore/quota"
import { SqlMeteringStore } from "@vaulltcore/metering"
import { SqlBillingStore } from "@vaulltcore/billing"
import { SqlAuditStore } from "@vaulltcore/audit"
import { SqlAutomationStore, type AutomationStore } from "@vaulltcore/automation"
import { SqlScheduleStore } from "@vaulltcore/scheduler"
import { SqlOpsStore } from "@vaulltcore/ops"
import { ModelRegistry } from "@vaulltcore/models"
import { SqlCredentialStore, CredentialResolver, InMemorySecretProvider } from "@vaulltcore/credentials"
import { buildAutomationLayer } from "./automation-routes.js"

const PORT = Number(process.env.PORT ?? 3000)
const HOST = "0.0.0.0"

async function main(): Promise<void> {
  console.log(`[vaulltcore] Starting server on ${HOST}:${PORT}...`)

  // Database: use PostgreSQL in production, SQLite for local/dev
  const databaseUrl = process.env.DATABASE_URL
  let database: any

  if (databaseUrl) {
    // PostgreSQL via pg driver (Neon or standard PostgreSQL)
    const { Pool } = await import("pg")
    const isNeon = databaseUrl.includes(".neon.tech")
    const poolConfig: import("pg").PoolConfig = {
      connectionString: databaseUrl,
      ssl: isNeon ? { rejectUnauthorized: true } : undefined,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    }
    const pool = new Pool(poolConfig)
    database = pool
    console.log(`[vaulltcore] Connected to ${isNeon ? "Neon" : "PostgreSQL"} database`)
  } else {
    // SQLite fallback for development
    database = NodeSqliteDatabase.open("./vaulltcore.db")
    console.log("[vaulltcore] Using SQLite database")
  }

  // Initialize stores
  const jobStore = new SqlJobStore(database)
  const dist = new DistributedSqlStore(database)
  const dispatcher = new SqlDispatcher(dist)
  const identity = new SqlIdentityStore(database)
  const policy = new SqlPolicyStore(database)
  const quota = new SqlQuotaStore(database)
  const metering = new SqlMeteringStore(database)
  const billing = new SqlBillingStore(database)
  const audit = new SqlAuditStore(database)
  const automationStore = new SqlAutomationStore(database)
  const schedulerStore = new SqlScheduleStore(database)
  const opsStore = new SqlOpsStore(database)

  // Model registry (BYOK)
  const credentialStore = new SqlCredentialStore(database)
  const secretProvider = new InMemorySecretProvider()
  const credentialResolver = new CredentialResolver({ store: credentialStore, secrets: secretProvider })
  const registry = new ModelRegistry({ credentialResolver })

  // Build the production runner
  const runner = buildOpenCodeRunner({
    store: jobStore,
    registry,
    tools: [], // Add tools as needed
    workspace: null,
    environment: null,
  })

  // Start the worker in background
  const workerIdentity = newWorkerIdentity("fly-worker")
  dist.registerWorker(workerIdentity)
  const worker = new WorkerHost({
    identity: workerIdentity,
    dispatcher,
    runner,
    leaseMs: 30000,
    heartbeatIntervalMs: 10000,
  })

  // Run the worker loop in background (non-blocking)
  worker.runLoop().catch((err) => {
    console.error("[vaulltcore] Worker error:", err)
  })

  // Build automation layer (requires admission pipeline from control plane)
  const automationLayer = buildAutomationLayer({
    store: automationStore,
    admission: null as any, // Will be set by ControlPlane
    runner,
    audit,
  })

  // Wire up the control plane
  const controlPlane = new ControlPlane({
    runner,
    business: {
      identity,
      policy,
      quota,
      metering,
      billing,
      audit,
      jobs: jobStore,
    },
    automation: {
      store: automationStore,
    },
    phase2b: {
      schedulerStore,
      opsStore,
    },
    phase2e: {
      opsStore,
      audit,
      automationStore: automationStore,
      storage: jobStore.database() as any,
      service: automationLayer.service,
    },
    phase2f: {
      metering,
      billing,
      audit,
    },
  })

  // Start the HTTP server
  const server = createServer(async (req, res) => {
    await controlPlane["dispatch"](req, res)
  })

  server.listen(PORT, HOST, () => {
    console.log(`[vaulltcore] Server ready on http://${HOST}:${PORT}`)
    console.log("[vaulltcore] Health check: GET /health")
  })

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    console.log("[vaulltcore] Shutting down...")
    worker.stop()
    server.close()
    process.exit(0)
  }

  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

main().catch((err) => {
  console.error("[vaulltcore] Fatal error:", err)
  process.exit(1)
})
