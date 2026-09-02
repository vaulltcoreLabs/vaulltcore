/**
 * Vaulltcore Webhook Gateway + Fan-Out (Phase 2C).
 *
 * Durable webhook ingestion + event subscription matching. Never executes an
 * agent in the request path. Provider-neutral, tenant-scoped, deduplicated.
 *
 * Dependency direction: webhooks → {integration, credentials, audit,
 * store-sql}. Never depends on the runner, the control plane, or a provider
 * SDK.
 */

export type {
  WebhookEventState,
  WebhookEventRecord,
  WebhookIngestResult,
  WebhookRouteResolver,
  QuarantinedRawEvent,
} from "./contracts"
export { SqlWebhookStore, type SqlWebhookStoreOptions, redactHeaders } from "./store"
export { WebhookGateway, type WebhookGatewayOptions } from "./gateway"
export { SubscriptionMatcher, globMatch, type Subscription, type TriggerRequest } from "./fanout"
