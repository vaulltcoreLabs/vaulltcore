/**
 * Vaulltcore Production Delivery Providers (Phase 2B).
 *
 * Provider-neutral delivery with production providers (HTTP webhook, email,
 * Slack), retry classification, bounded backoff, and SSRF protection. Sits
 * behind the neutral {@link ProductionDeliveryProvider} seam; no vendor is a
 * core dependency.
 *
 * Dependency direction: delivery → {audit (sanitizer), automation (types)}.
 * It never depends on the runner, store-sql, identity, or control plane.
 */

export * from "./contracts"
export { SsrfGuard, type SsrfGuardOptions } from "./ssrf"
export { RetryPolicy, defaultClassifier, type RetryPolicyOptions, type RetryDecision } from "./retry"
export {
  WebhookDeliveryProvider,
  EmailDeliveryProvider,
  SlackDeliveryProvider,
  type WebhookDeliveryProviderOptions,
  type EmailDeliveryProviderOptions,
  type SlackDeliveryProviderOptions,
  type SmtpTransport,
} from "./providers"
