/**
 * Vaulltcore Credentials & Connection Lifecycle (Phase 2C + 2D).
 *
 * Durable, tenant-scoped credential/connection model behind a replaceable
 * SecretProvider seam. The plaintext secret NEVER persists in the credential
 * store, NEVER appears in API responses/logs/audit/events/errors. Rotation
 * changes the secret without changing connection identity. Revocation/expiry
 * is enforced authoritatively at resolve time.
 *
 * Phase 2D adds the OAuth/connection authorization lifecycle: durable
 * single-use authorization attempts (state/PKCE), one-time callback settlement
 * (replay-safe), provider identity verification before activation, refresh/
 * degraded/revoked transitions, and a neutral OAuth adapter seam. No raw token
 * ever enters the credential/attempt stores.
 *
 * Dependency direction: credentials → {store-sql, audit}. It never depends on
 * the runner, a provider SDK, or the control plane. No vendor is a dependency.
 */

export {
  PROVIDER_FAMILIES,
  CONNECTION_STATES,
  CONNECTION_TRANSITIONS,
  AUTHORIZATION_METHODS,
  AUTHORIZATION_ATTEMPT_STATES,
  type ProviderFamily,
  type ConnectionState,
  type ConnectionCapability,
  type AuthorizationMethod,
  type AuthorizationCapability,
  type AuthorizationAttempt,
  type AuthorizationAttemptState,
  type AuthorizationAttemptOutcome,
  type CreateAuthorizationAttemptInput,
  type ProviderAccountIdentity,
  type ResolvedCredential,
  type ProviderConnection,
  type CreateConnectionInput,
  CredentialError,
  assertConnectionTransition,
} from "./contracts"
export {
  SqlCredentialStore,
  CREDENTIAL_MIGRATIONS,
  type CredentialStoreOptions,
  type ConnectionPublicView,
  toPublicView,
} from "./store"
export {
  CredentialResolver,
  type CredentialResolverOptions,
} from "./resolver"
export {
  type SecretProvider,
  type StoredSecret,
  secretFingerprint,
  InMemorySecretProvider,
  EnvSecretProvider,
} from "./secret-provider"
export {
  SqlAuthorizationAttemptStore,
  type OAuthStoreOptions,
  type CallbackParams,
  type SettleAttemptInput,
  deriveCodeChallenge,
  safeEqualState,
} from "./oauth-store"
export {
  OAuthAdapterRegistry,
  type OAuthProviderAdapter,
  type ExchangeRequest,
  type ExchangeResult,
  isOAuthCodeFlow,
} from "./oauth-adapter"
export {
  ConnectionLifecycle,
  type ConnectionLifecycleOptions,
  type StartAuthorizationInput,
  type StartedAuthorization,
  type CompleteCallbackInput,
  type CompleteCallbackResult,
  sha256Base64Url,
  randomNonce,
} from "./lifecycle"
