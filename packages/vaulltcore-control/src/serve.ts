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
import { ModelRegistry, ModelConnectionService } from "@vaulltcore/models"
import { SqlCredentialStore, CredentialResolver, EnvSecretProvider, SqlAuthorizationAttemptStore, ConnectionLifecycle, OAuthAdapterRegistry } from "@vaulltcore/credentials"
import { SqlTriggerStore, TriggerDispatchService } from "@vaulltcore/automation"
import { SqlB2bAuthStore, BetterAuthAdapter, ActorResolver, ServiceIdentityService, type EmailServiceLike } from "@vaulltcore/auth"
import { DefaultEmailService, ResendEmailProvider, DevelopmentEmailProvider } from "@vaulltcore/email"
import { GitHubOAuthAdapter, GitLabOAuthAdapter } from "@vaulltcore/git"
import { SqlWebhookStore } from "@vaulltcore/webhooks"
import { SqlAdmissionIdempotencyRegistry } from "@vaulltcore/store-sql"
import { AdmissionPipeline } from "./admission.js"
import { buildAutomationLayer } from "./automation-routes.js"
import { TriggerRunSinkImpl } from "./phase2d-routes.js"
import type { ControlAuthenticator } from "./auth.js"

const PORT = Number(process.env.PORT ?? 3000)
const HOST = "0.0.0.0"

async function resolveActor(
  req: import("node:http").IncomingMessage,
  resolver: ActorResolver,
): Promise<import("./auth").AuthnPrincipal | null> {
  const actor = await resolver.resolve({
    authorization: req.headers["authorization"],
    cookie: req.headers["cookie"],
    requestedOrgId: req.headers["x-vc-org"] as string | undefined,
    ip: req.socket?.remoteAddress,
    userAgent: req.headers["user-agent"],
  })
  if (!actor) return null
  // Map the actor to the legacy AuthnPrincipal shape (tenant/org/project/admin),the
  // backend authorization is STILL authoritative — the UI cannot widen scope.
  // Project scope is NEVER synthesized from absence: no grant ⇒ null project
  // (legacy routes must treat null as no-project access, not as org-wide).”.
  return { tenantId: actor.tenantId, orgId: actor.orgId, projectId: actor.projectScope.length > 0 ? actor.projectScope[0]! : null, admin: actor.admin }
}

/** Production fallback authenticator when no session layer (phase2g) is
 *  configured: machine credentials only via the durable API-key store.
 *
 *  The header box (`HeaderAuthenticator`) is test/dev-only; it must never
 *  be the blind default for a serve without explicit headers — a client
 *  could otherwise self-assert tenant identity. The bearer secret is
 *  verified against `api_keys` (fingerprint-only, server-side authority),
 *  which is the same path phase2g uses for machine credentials. */
function apiKeyAuthenticator(verify: (secret: string) => Promise<import("@vaulltcore/identity").ResolvedPrincipal | null>): ControlAuthenticator {
  return {
    async authenticate(request) {
      const auth = request.headers["authorization"]
      const token = typeof auth === "string" && auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null
      if (!token) return null
      const resolved = await verify(token)
      if (!resolved) return null
      return {
        tenantId: resolved.tenantId,
        orgId: resolved.orgId,
        projectId: resolved.projectScope[0] ?? "*",
        admin: resolved.admin,
      }
    },
  }
}

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
  const isNodeSqlite = !databaseUrl

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
  
  // Model registry (BYOK
  const credentialStore = new SqlCredentialStore(database)
  const attemptStore = new SqlAuthorizationAttemptStore(database)
  // Provider secrets come from the environment (opaque refs + fingerprints
  // only persist in the store; plaintext secrets never appear in responses,
  // logs, audit, events, or errors.)
  const secretProvider = new EnvSecretProvider()
  const credentialResolver = new CredentialResolver({ store: credentialStore, secrets: secretProvider })
  const registry = new ModelRegistry({ credentialResolver })
  const modelConnections = new ModelConnectionService({ connections: credentialStore, resolver: credentialResolver, registry, audit })

  // OAuth adapters (Phase 2D: provider-neutral; wired only when env
  // config for a provider is present. Missing providers → capabilities simply
  // don't advertise that provider; no routes are lost.)
  const oauthAdapters = new OAuthAdapterRegistry()
  const ghrClientId = process.env.GITHUB_OAUTH_CLIENT_ID
  const gitlabClientId = process.env.GITLAB_OAUTH_CLIENT_ID
  const linearClientId = process.env.LINEAR_OAUTH_CLIENT_ID
  const slackClientId = process.env.SLACK_OAUTH_CLIENT_ID
  if (ghrClientId) {
    oauthAdapters.register(new GitHubOAuthAdapter({
      clientId: ghrClientId,
      clientSecretProvider: () => process.env.GITHUB_OAUTH_CLIENT_SECRET,
    }))
  }
  if (gitlabClientId) {
    oauthAdapters.register(new GitLabOAuthAdapter({
      clientId: gitlabClientId,
      clientSecretProvider: () => process.env.GITLAB_OAUTH_CLIENT_SECRET,
    }))
  }
  if (linearClientId) {
    const { LinearOAuthAdapter } = await import("@vaulltcore/connectors")
    oauthAdapters.register(new LinearOAuthAdapter({
      clientId: linearClientId,
      clientSecretProvider: () => process.env.LINEAR_OAUTH_CLIENT_SECRET,
    }))
  }
  if (slackClientId) {
    const { SlackOAuthAdapter } = await import("@vaulltcore/connectors")
    oauthAdapters.register(new SlackOAuthAdapter({
      clientId: slackClientId,
      clientSecretProvider: () => process.env.SLACK_OAUTH_CLIENT_SECRET,
    }))
  }

  // Phase 2D: trigger store + connection lifecycle (bound durably before
  // redirect; validated at settlement — never trusted from the callback scoped.)
  const triggerStore = new SqlTriggerStore(database)
  const lifecycle = new ConnectionLifecycle({
    connections: credentialStore,
    attempts: attemptStore,
    secrets: secretProvider,
    oauth: oauthAdapters,
    audit,
  })

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

  // The admission pipeline authenticates→authorizes→policy→quota→create; the
  // automation dispatcher drives every automation step through it, so it MUST
  // be a real pipeline here — a null stand-in would crash any automation run.
  const admission = new AdmissionPipeline({
    runner,
    identity,
    policy,
    quota,
    audit,
    idempotency: new SqlAdmissionIdempotencyRegistry(database),
  })
  const automationLayer = buildAutomationLayer({
    store: automationStore,
    admission,
    runner,
    audit,
  })


  // Phase 2G: B2B auth (Better Auth owns sessions; Vaulltcore owns
  // authorization). Explicitly wired only when ALL required env is present:
  // betterAuth.secret + baseURL. Missing config → no /auth/* bridge, no
  // session resolution — the API-key path remains fully functional.

  const authBaseUrl = process.env.AUTH_BASE_URL ?? `http://localhost:${PORT}`
  const authSecret = process.env.AUTH_BETTER_AUTH_SECRET
  let betterAuth: BetterAuthAdapter | null = null
  let authStore: SqlB2bAuthStore | null = null
  if (authSecret && authSecret.length >= 32) {
    authStore = new SqlB2bAuthStore(database)
    // Phase 3/4 — Email delivery. Production wires Resend (server-only
    // RESEND_API_KEY; never in frontend env vars/logs/errors); dev wires the
    // explicit dev sink ONLY. There is deliberately NO silent fallback from
    // Resend to the sink: if RESEND_API_KEY is configured the Resend provider is
    // constructed and any delivery failure FAILS LOUDLY (non-2xx throws)..
    const resendKey = process.env.RESEND_API_KEY
    const devEmail = process.env.NODE_ENV !== "production" && process.env.AUTH_DEV_EMAIL_SINK === "true"
    let emailService: EmailServiceLike | null = null
    const toEmailService = (
      svc: InstanceType<typeof DefaultEmailService>,
    ): EmailServiceLike => ({
      providerId: svc.providerId,
      send: async (email) => {
        const { toEmail, ...rest } = email
        return svc.send({ ...rest, to: toEmail })
      },
    })
    if (resendKey) {
      emailService = toEmailService(new DefaultEmailService(new ResendEmailProvider({
        apiKey: resendKey,
        from: process.env.RESEND_FROM_EMAIL ?? "auth@vaulltcore.app",
        fromName: process.env.RESEND_FROM_NAME ?? "Vaulltcore",
      })))
    } else if (devEmail) {
      emailService = toEmailService(new DefaultEmailService(new DevelopmentEmailProvider({ enabled: true, allowInProduction: true })))
    }
    const trustedOrigins = (process.env.AUTH_TRUSTED_ORIGINS ?? "")
      .split(",").map((o) => o.trim()).filter(Boolean)
    const genericOidc = (process.env.AUTH_OIDC_PROVIDERS ?? "").split(",").map((raw) => raw.trim()).filter(Boolean).map((id) => {
      const env = "AUTH_OIDC_" + id.toUpperCase().replace(/-/g, "_")
      return {
        providerId: id,
        name: process.env[env + "_NAME"],
        discoveryUrl: process.env[env + "_DISCOVERY_URL"] ?? "",
        clientId: process.env[env + "_CLIENT_ID"] ?? "",
        clientSecret: process.env[env + "_CLIENT_SECRET"],
        scopes: (process.env[env + "_SCOPES"] ?? "").split(",").map((sc) => sc.trim()).filter(Boolean),
        requireEmailVerification: process.env.AUTH_REQUIRE_EMAIL_VERIFICATION === "true",
      }
    }).filter((cfg) => Boolean(cfg.discoveryUrl && cfg.clientId))
    betterAuth = new BetterAuthAdapter({
      // Better Auth's kysely adapter needs the CONCRETE node:sqlite driver
      // (`DatabaseSync`); for PostgreSQL we reuse the pg Pool the SqlStore seam
      // already drives (better-auth/kysely auto-detects the dialect).
      database:isNodeSqlite ? (database as NodeSqliteDatabase).raw() : database,
      secret: authSecret,
      baseURL: authBaseUrl,
      ...(trustedOrigins.length ? { trustedOrigins } : {}),
      ...(emailService ? { emailService } : {}),
      requireEmailVerification: process.env.AUTH_REQUIRE_EMAIL_VERIFICATION === "true",
      ...(process.env.AUTH_SESSION_MAX_AGE_SECONDS ? { sessionMaxAge: Number(process.env.AUTH_SESSION_MAX_AGE_SECONDS) } : {}),
      ...(process.env.AUTH_SESSION_UPDATE_AGE_SECONDS ? { sessionUpdateAge: Number(process.env.AUTH_SESSION_UPDATE_AGE_SECONDS) } : {}),
      ...(process.env.AUTH_SECURE_COOKIES ? { useSecureCookies: process.env.AUTH_SECURE_COOKIES === "true" } : {}),
      ...(process.env.AUTH_RATE_LIMIT_MAX ? { rateLimit: { windowSec: Number(process.env.AUTH_RATE_LIMIT_WINDOW_SECONDS ?? 60), max: Number(process.env.AUTH_RATE_LIMIT_MAX), enabled: process.env.AUTH_RATE_LIMIT_ENABLED !== "false" } } : {}),
      ...(process.env.AUTH_GOOGLE_CLIENT_ID && process.env.AUTH_GOOGLE_CLIENT_SECRET ? { google: { clientId: process.env.AUTH_GOOGLE_CLIENT_ID, clientSecret: process.env.AUTH_GOOGLE_CLIENT_SECRET } } : {}),
      ...(process.env.AUTH_GITHUB_CLIENT_ID && process.env.AUTH_GITHUB_CLIENT_SECRET ? { github: { clientId: process.env.AUTH_GITHUB_CLIENT_ID, clientSecret: process.env.AUTH_GITHUB_CLIENT_SECRET } } : {}),
      ...(genericOidc.length ? { genericOidc } : {}),
      ...(process.env.AUTH_TWO_FACTOR_ENFORCE === "true" ? { twoFactor: {
        issuer: process.env.AUTH_TWO_FACTOR_ISSUER ?? "Vaulltcore",
        ...(process.env.AUTH_2FA_COOKIE_MAX_AGE_SECONDS ? { twoFactorCookieMaxAge: Number(process.env.AUTH_2FA_COOKIE_MAX_AGE_SECONDS) } : {}),
        ...(process.env.AUTH_2FA_TRUST_DEVICE_MAX_AGE_SECONDS ? { trustDeviceMaxAge: Number(process.env.AUTH_2FA_TRUST_DEVICE_MAX_AGE_SECONDS) } : {}),
        ...(process.env.AUTH_2FA_BACKUP_CODE_AMOUNT ? { backupCodeAmount: Number(process.env.AUTH_2FA_BACKUP_CODE_AMOUNT) } : {}),
        enforceForEmailPassword: true,
        allowedPasswordlessMethods: ["magic-link", "email-otp", "oauth"],
      } } : {}),
    })
    await betterAuth.migrate()
  }
  const serviceIdentities = authStore ? new ServiceIdentityService({ identity, authStore, audit }) : null
  const resolver = authStore && betterAuth && serviceIdentities
    ? new ActorResolver({ identity, authStore, sessions: betterAuth, serviceIdentities, audit })
    : null

  // OAuth callback redirect URI the adapters exchange codes against. The
  // control plane exposes GET /oauth/callback on this same origin.

  const redirectUri = process.env.OAUTH_REDIRECT_URI ?? `${authBaseUrl}/oauth/callback`

  // Phase 2D dispatcher: durable trigger→run sink over the automation
  // service (admission still applies; realm sink applies the idempotency
  // boundary on dispatch identity — never a duplicate run at the durable edge.)
  const triggerSink = new TriggerRunSinkImpl(automationLayer.service, audit)
  const dispatchService = new TriggerDispatchService({ store: triggerStore, sink: triggerSink, audit })
  const webhookStore = new SqlWebhookStore(database)

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
      admissionIdempotency: new SqlAdmissionIdempotencyRegistry(database),
      apiKeyAuthenticator: (secret) => identity.authenticateApiKey(secret),
    },
    automation: {
      store: automationStore,
    },
    authenticator: resolver ? { authenticate: (req) => resolveActor(req, resolver) } : apiKeyAuthenticator((secret) => identity.authenticateApiKey(secret)),
    ...((process.env.AUTH_TRUSTED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean).length ? { trustedOrigins: (process.env.AUTH_TRUSTED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean) } : {}),
    headerAuthTrusted: false,
    phase2b: {
      schedulerStore,
      opsStore,
    },
    phase2d: {
      credentialStore,
      attemptStore,
      lifecycle,
      oauthAdapters,
      triggerStore,
      dispatchService,
      modelConnections,
      webhookStore,
      audit,
    },
    phase2e: {
      opsStore,
      audit,
      automationStore: automationStore,
      storage: jobStore.database() as any,
      service: automationLayer.service,
      triggerStore,
      dispatchService,
      quotaStore: quota,
    },
    phase2f: {
      metering,
      billing,
      audit,
    },
    ...(resolver && authStore && betterAuth && serviceIdentities ? { phase2g: { resolver, authStore, identity, serviceIdentities, audit, betterAuth } } : {}),
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
