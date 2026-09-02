# Phase 2C — OpenHands Study

Purpose: study OpenHands for **capabilities, UX patterns, integration
boundaries, authentication flows, BYOK behavior, repository operations, and
failure handling**, then reimplement only the useful concepts in Vaulltcore's
architecture.

**Copy capabilities, not code.** OpenHands is NOT a runtime dependency of
Vaulltcore. OpenHands source is NOT reproduced. Vaulltcore's durable execution,
economic enforcement, tenant isolation, integration contracts, recovery
semantics, and provider neutrality remain the source of truth.

Study sources (read-only, public docs + DeepWiki architectural summaries):
- OpenHands integrations (`openhands/integrations/provider.py`,
  `github_service.py`, `gitlab_service.py`, `service_types.py`)
- OpenHands LLM/BYOK settings (litellm-based `provider/model` prefix,
  `api_base`, custom models, local LLMs)
- OpenHands GitHub/GitLab Cloud installation + webhook flows

---

## 1. Authentication & token management

OpenHands capability
→ A central `ProviderHandler` validates a token against each provider to
  detect which provider it belongs to (`validate_provider_token()`), stores it
  in a read-only `ProviderToken` (Pydantic `SecretStr`), supports an
  `external_token_manager` for enterprise deployments, and exports the token
  to the runtime as an env var (`GITHUB_TOKEN`, …) so the agent's git CLI can
  authenticate. Token refresh is delegated externally for SaaS.

→ Vaulltcore interpretation
→ A **neutral `CredentialResolver` + `SecretProvider` seam**. A credential is
  tenant/org/project-scoped durable metadata + a secret held behind the
  `SecretProvider` interface (replaceable: env, KMS, vault). The resolver
  resolves a connection to a usable secret for an adapter; the secret never
  appears in responses, logs, audit, events, or errors. Validation is a
  provider-adapter capability (`verifyIdentity`), not a global probe loop.

→ Implementation location
→ `packages/vaulltcore-credentials` (`contracts.ts`, `resolver.ts`,
  `secret-provider.ts`, `store.ts`).

→ Why it belongs
→ Vaulltcore is multi-tenant: a credential belongs to one tenant and is
  authorized by the authenticated principal, never trusted from a request
  body. The secret boundary must be explicit so a leaked DB cannot mint
  provider calls and so audit/metering never carry secrets.

→ Deliberately rejected
→ **Exporting provider tokens to the agent runtime as env vars.** Vaulltcore
  automations execute durable Phase 1 jobs behind a narrow dispatcher seam;
  provider work is done by adapters under tenant scope, not by handing raw
  tokens to a shell. This keeps secrets out of process env (which is logged,
  inherited by child processes, and crash-dumped) and keeps every external
  mutation idempotent + auditable. We also reject the "probe every provider
  to detect which token you have" pattern — it leaks tenant secrets to
  unrelated providers and wastes rate limit; Vaulltcore records the provider
  at connection time.

---

## 2. GitHub / GitLab repository workflows

OpenHands capability
→ Authenticated git URLs constructed per provider (`https://{token}@github.com/...`,
  `https://oauth2:{token}@gitlab.com/...`), repo search, branch ops, PR/MR
  creation, issue/PR labeling + `@openhands` mention triggers, GitHub App
  installation (short-lived 8h tokens, scoped permissions), GitLab OAuth with
  reduced-scope agent token override (`GITLAB_TOKEN` secret overrides the
  high-perm token for the agent).

→ Vaulltcore interpretation
→ A **neutral `GitProvider` contract** (identity, repo listing, branch/file
  read, file write, commit, branch, PR, issue, webhook verify+normalize)
  implemented by `GitHubGitProvider` and `GitLabGitProvider` over a narrow
  HTTP seam (no provider SDK in core). Connection uses GitHub App installation
  OR PAT/OAuth token — recorded at connection time, rotated without changing
  connection identity. Every mutation carries tenant/project scope + an
  idempotency key (deterministic `tenant+connectionId+operationId`). Webhook
  verification is per-provider (HMAC) and normalization maps to a neutral
  `IntegrationEvent`.

→ Implementation location
→ `packages/vaulltcore-git` (`contracts.ts`, `github.ts`, `gitlab.ts`,
  `http.ts`).

→ Why it belongs
→ A B2B customer connects its existing source control; governed automations
  react to real push/PR/issue events and perform governed mutations. The
  neutral contract lets GitLab/Jira-style systems share one fan-out + audit
  model.

→ Deliberately rejected
→ **Embedding the token in the git remote URL that the agent shell uses.**
  Rejected for the same reason as env-var export: the agent runtime must not
  hold raw provider secrets. Adapter-driven, idempotent, scoped mutations are
  the Vaulltcore way. Also rejected: a global `@openhands` mention bot —
  Vaulltcore triggers are explicit durable subscriptions with tenant
  authorization, not ambient mention parsing inside one product.

---

## 3. BYOK / model configuration

OpenHands capability
→ litellm-based `provider/model` naming (`openai/gpt-4`,
  `claude-sonnet-4-...`), `api_base` for OpenAI-compatible/local endpoints,
  per-agent `[llm.<profile>]` config (model, api_key, temperature,
  max_output_tokens), local LLMs via LM Studio/Ollama/vLLM with `openai/`
  prefix, an OpenHands-hosted LLM provider.

→ Vaulltcore interpretation
→ A **provider-neutral `ModelRegistry` → `CredentialResolver` →
  `ModelProviderAdapter` → existing `AgentEngine`/`ModelProvider` seam**.
  BYOK credentials flow only through the resolver. Adapters normalize
  provider capability metadata, model restrictions, usage/cost metadata, and
  rate-limit/error classification (reusing Phase 2B's `RetryClass`). The
  **existing `AgentEngine`/`ProviderRegistry` seam stays authoritative** —
  no second agent runtime is created.

→ Implementation location
→ `packages/vaulltcore-models` (`contracts.ts`, `registry.ts`,
  `adapters/openai-compatible.ts`, `adapters/anthropic.ts`, …).

→ Why it belongs
→ A customer must bring its own models; Vaulltcore must not be locked to one
  LLM vendor. BYOK selection is tenant/project-scoped and metered through
  Phase 1E/1F usage attribution so retries never double-charge.

→ Deliberately rejected
→ **Adopting litellm as a runtime dependency.** Vaulltcore keeps a narrow
  HTTP/protocol seam per provider family and normalizes events itself
  (mirroring the existing OpenCode kernel extraction). Also rejected:
  per-agent free-form model profiles in the runner — model selection is a
  durable, governed credential reference, not ad-hoc config baked into each
  job spec.

---

## 4. Webhook ingestion & event triggers

OpenHands capability
→ GitHub `@openhands` mention / label triggers run OpenHands from GitHub;
  GitLab webhook management table per group/project; signature verification
  proves sender identity but content is still treated as untrusted.

→ Vaulltcore interpretation
→ A **durable webhook gateway**: verify signature → resolve integration →
  tenant authorization → deduplicate provider event (deterministic event
  identity) → persist normalized event → enqueue → automation trigger. **The
  HTTP request never executes an agent.** Provider event-ID dedup + replay
  protection + timestamp validation + dead-letter + raw quarantine.

→ Implementation location
→ `packages/vaulltcore-webhooks` (`gateway.ts`, `verify.ts`, `store.ts`,
  `contracts.ts`); fan-out in `packages/vaulltcore-integration`
  (`subscriptions.ts`).

→ Why it belongs
→ A duplicate webhook must never create duplicate automation work; a forged
  webhook must never mutate; an integration outage must degrade/retry without
  duplicating business operations. These are Vaulltcore's existing durable
  invariants extended to external events.

→ Deliberately rejected
→ **Executing the agent inline in the webhook handler.** Rejected
  categorically: the handler persists + enqueues only; a durable worker drives
  the automation trigger. Also rejected: one-off trigger logic per provider —
  Vaulltcore uses deterministic event identity + a single subscription matcher.

---

## 5. Integration UX / organization-level configuration

OpenHands capability
→ Settings > Integrations page; configure repo access; webhook status table
  per GitLab group/project; token connection status; Slack app install.

→ Vaulltcore interpretation
→ **Tenant-scoped control-plane routes** for connections, credential
  metadata, OAuth lifecycle, repos, providers, webhook status,
  subscriptions, BYOK models, integration health. Tenant from authenticated
  principal; cross-tenant = 404 (no existence leak); idempotency on
  mutations.

→ Implementation location
→ `packages/vaulltcore-control/src/phase2c-routes.ts` (additive layer,
  requires business + automation layers).

→ Why it belongs
→ Governance: every integration is tenant-scoped and authorization-checked;
  no second authorization model (reuses Phase 1E role-rank).

→ Deliberately rejected
→ **A per-user personal integrations model.** Vaulltcore is B2B: connections
  belong to the tenant/org/project, not to an individual user, so rotations
  and revocations are governed, not lost when a person leaves.

---

## 6. Agent / tool integration boundaries

OpenHands capability
→ The agent gets tools (bash, file edit, …) and provider tokens to act on
  repositories; OpenCode-style engine streams fine-grained LLM events.

→ Vaulltcore interpretation
→ **Provider work is done by adapters behind neutral seams above the durable
  runner**, never by handing raw secrets to a generic agent shell. The runner
  owns durability/settlement/cancellation; the OpenCode engine adapter owns
  prompt/history + one-provider-turn streaming (already extracted in Phase 1A).

→ Implementation location
→ `packages/vaulltcore-git`, `packages/vaulltcore-connectors`,
  `packages/vaulltcore-models` — all sit above the runner, never inside it.

→ Why it belongs
→ Keeps the hard seam: the runner never imports GitHub/GitLab/Linear/Slack/
  credential-vault/control-plane. Provider neutrality + durable invariants
  cannot regress.

→ Deliberately rejected
→ **A "give the agent the token and let it run git" integration model.**
  Vaulltcore mutations are explicit, idempotent, scoped, audited adapter
  operations — not arbitrary agent shell actions against a customer's systems.

---

## Summary table

| OpenHands concept                       | Adopted? | Vaulltcore interpretation                          |
|-----------------------------------------|----------|----------------------------------------------------|
| Central provider token handler          | partial  | neutral CredentialResolver + replaceable SecretProvider (no env export) |
| Validate token by probing all providers | no       | record provider at connection time; adapter verifyIdentity |
| Authenticated git URLs to agent shell   | no       | adapter-driven idempotent scoped mutations        |
| GitHub App install / short-lived tokens | yes      | connection supports App-install + rotate-without-identity-change |
| litellm `provider/model` + api_base     | partial  | neutral ModelRegistry + per-family adapter seam (no litellm dep) |
| Per-agent `[llm.profile]`               | no       | durable governed BYOK credential reference         |
| `@openhands` mention/label triggers     | partial  | explicit durable subscriptions + deterministic event identity |
| Webhook signature verify                | yes      | durable gateway: verify→dedup→persist→enqueue→trigger |
| Inline agent execution on webhook       | no       | handler never executes agent; durable worker drives trigger |
| Per-user integrations                   | no       | tenant/org/project-owned connections              |
| External token manager (enterprise)     | yes      | replaceable SecretProvider seam (KMS/vault/env)    |

**Bottom line:** Vaulltcore adopts OpenHands's *capability surface* (connect a
customer's git/PM/chat systems + BYOK models + react to real events) but
implements it through Vaulltcore's durable, tenant-isolated, economically
enforced, provider-neutral architecture. OpenHands's trust-the-agent-with-
secrets execution model is deliberately rejected in favor of scoped, idempotent,
audited adapter operations.
