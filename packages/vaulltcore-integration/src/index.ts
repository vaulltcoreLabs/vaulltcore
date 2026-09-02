/**
 * Vaulltcore Neutral Integration Plane (Phase 2C).
 *
 * Provider-neutral contracts every external-system adapter implements:
 * IntegrationProvider (identity/webhook verify/normalize), NormalizedEvent
 * (single fan-out event shape, deterministic identity), ExternalMutation
 * (idempotent mutation boundary), ProviderRegistry, a SSRF-guarded HTTP seam,
 * and durable subscriptions + fan-out.
 *
 * Dependency direction: integration → {credentials, delivery (ssrf/retry),
 * audit, store-sql}. It never depends on the runner, a provider SDK, or the
 * control plane. No vendor is a dependency.
 */

export {
  NORMALIZED_EVENT_KINDS,
  type NormalizedEventKind,
  type NormalizedEvent,
  type ProviderKind,
  type ProviderIdentity,
  type IntegrationProvider,
  type RawWebhook,
  type WebhookVerifyResult,
  type ExternalMutation,
  type ExternalResource,
  IntegrationError,
  ProviderRegistry,
  deterministicEventId,
  verifyHmacSha256,
} from "./contracts"
export {
  ProviderHttpClient,
  classifyResponse,
  type ProviderHttpOptions,
  type ProviderHttpTransportOptions,
  type ProviderHttpResponse,
} from "./http"
export {
  SqlSubscriptionStore,
  SUBSCRIPTION_MIGRATIONS,
  SUBSCRIPTION_STATES,
  type SubscriptionState,
  type Subscription,
  type CreateSubscriptionInput,
  type SubscriptionStoreOptions,
  globMatch,
} from "./subscriptions"
export {
  FanOutService,
  type AutomationTriggerSink,
  type FanOutOptions,
} from "./fanout"
