# Phase 3A.1 — Real Execution Engine Activation + Architectural Cleanup

This phase activates the real OpenCode-backed engine path and removes stale,
duplicate, or misleading execution wiring. It **connects what already exists**:
the durable runner, the neutral `AgentEngine` seam, and the credential-backed
BYOK model adapters. It does **not** rebuild Vaulltcore and does **not** add a
competing execution architecture.

The completion principle: **connect what already exists; the correct result is
`DurableAgentRunner → AgentEngine(OpenCodeEngine) → ModelProvider →
ModelProviderAdapter (BYOK)`.**

---

## 1. Baseline

- Starting branch: `main`
- Starting commit: `4c3d3dc3f7d333c184a69b18846bf080b63a0d7b`
- Initial working tree: clean
- Baseline verification:
  - `npm run typecheck` — pass
  - `npm test` — 467 passed / 25 skipped / 0 failures (skips are the
    pre-existing environment-gated PG/Docker/live-conformance tests)

### Execution architecture inspected (actual current source)

- **`@vaulltcore/runner`** — `DurableAgentRunner` is the sole execution
  authority. It is neutral: it takes `engines: AgentEngine[]` via `RunnerDeps`,
  selects the engine by `spec.engine`, and owns all durable lifecycle (leases,
  ownership fencing, checkpoints, events, settlement, cancellation, recovery).
  It never names an OpenCode type. `AgentEngine` is defined in
  `packages/vaulltcore-runner/src/contracts.ts`. `ScriptEngine` (deterministic)
  lives in `packages/vaulltcore-runner/src/engine.ts`.
- **`@vaulltcore/runner-opencode`** — the OpenCode adapter. `OpenCodeEngine`
  already implemented `AgentEngine` correctly (session create/restore,
  one-provider-turn streaming, history projection). It consumed a
  `ProviderRegistry.resolve(model)` — a model-string-keyed registry populated
  only with a **deterministic** `ScriptModelProvider`. The package was well
  formed and already had 3 passing tests driving it through `DurableAgentRunner`,
  but it was **unwired from production**: `OpenCodeEngine` was never constructed
  outside tests.
- **`@vaulltcore/models`** — the real, provider-neutral BYOK model plane:
  `ModelRegistry.resolve({tenantId, orgId, projectId, connectionId, provider,
  model})` resolves a tenant's credential-backed `ModelProviderAdapter`
  (OpenAI-compatible, Anthropic, Google) through `CredentialResolver` (the
  authorized secret boundary). It uses its own neutral vocabulary
  (`ModelRequest` / `ModelStreamEvent`) distinct from the OpenCode wire
  vocabulary (`LLMRequest` / `LLMEvent`).
- **`@vaulltcore/control`** — the platform composition root. Depends on
  `@vaulltcore/runner` and `@vaulltcore/models` but **not**
  `@vaulltcore/runner-opencode`. It takes an injected `AgentRunner`; no
  production code composed `DurableAgentRunner` with `OpenCodeEngine`.

### Findings

| Area | State |
|---|---|
| `OpenCodeEngine` | Valid `AgentEngine`, but provider source was `ProviderRegistry.resolve(model)` only — not composable with per-tenant credential resolution, and never used in production. |
| `AgentEngine` contract | Correct, neutral, unchanged. `EngineInit` carries `identity` (tenant/org/project/job/execution) + `spec` (model, input, engineOptions). |
| `ScriptEngine` / `ScriptModelProvider` | Genuinely useful deterministic test engines; retained. Not the production path. |
| Production composition | **Missing.** No `AgentEngine = OpenCodeEngine`, no `ModelRegistry → OpenCodeEngine` wiring. |
| Wire vs neutral | Two vocabularies existed (`ModelStreamEvent` in models, `LLMEvent`/`LLMRequest` in the OpenCode kernel). No bridge between them. |
| Stale claims | No false claims found stating Gemini CLI is the active engine, nor that `@vaulltcore/engine` exists as a package, nor that real execution was already fully wired. One stale comment in `model-provider.ts` said "Phase 1A ships a deterministic provider" (corrected to describe the test vs production split). |

---

## 2. Implementation

### OpenCode changes (`@vaulltcore/runner-opencode`)

1. **`SessionProviderResolver` seam** (`model-provider.ts`)
   - New type `SessionProviderResolver = (init: EngineInit) => ModelProvider |
     Promise<ModelProvider>`.
   - `ProviderRegistry` keeps its deterministic role and gains `.resolver()`
     producing a `SessionProviderResolver` from `spec.model`. This is the
     deterministic test path.
2. **`OpenCodeEngine` consumes the resolver seam** (`opencode-engine.ts`)
   - Constructor changed from `(providers: ProviderRegistry)` to
     `(resolveProvider: SessionProviderResolver)`. `createSession` /
     `restoreSession` `await` the resolver.
   - The engine never hard-codes a provider source; the wire
     `ModelProvider`/`LLMRequest`/`LLMEvent` vocabulary is unchanged.
3. **Models bridge** (`models-bridge.ts`, new)
   - `modelStreamEventToWire`: maps a models `ModelStreamEvent` → OpenCode
     wire `LLMEvent` (step-start, text-delta, reasoning-delta, tool-input-delta,
     tool-call, usage, step-finish, finish, error→`provider-error` with a
     sanitized message that preserves the retry class and never includes
     credential material).
   - `llmRequestToModel` / `wireMessagesToModel`: translate the OpenCode wire
     history + tool definitions into a models `ModelRequest`. Tool results are
     split into `role: "tool"` messages (the shape the real adapters require);
     assistant text + tool calls stay on one message. Malformed content is
     rejected (no unsafe casts).
   - `modelsAdapterToProvider`: wraps a `ModelProviderAdapter` as the wire
     `ModelProvider`.
   - `modelsProviderResolver(registry)`: produces a `SessionProviderResolver`
     that reads public identifiers `connectionId` / `provider` from
     `spec.engineOptions` and calls `ModelRegistry.resolve(...)` for the job's
     tenant, wrapping the resolved adapter. Secrets cross only the
     `CredentialResolver` boundary inside the adapter; this function never
     serializes credential material.
4. **Production composition** (`compose.ts`, new)
   - `buildOpenCodeEngine(registry, options?)` → `AgentEngine`, i.e.
     `new OpenCodeEngine(modelsProviderResolver(registry))`. This is the
     explicit `AgentEngine = OpenCodeEngine` production selection.

Dependency direction: `runner-opencode → runner`, `runner-opencode → models`.
No cycle (`models` never imports `runner` or `runner-opencode`); the neutral
runner is untouched and never imports OpenCode.

### Control-plane composition (`@vaulltcore/control`)

- `execution.ts` (new): `buildOpenCodeRunner(options)` → a fully assembled
  `DurableAgentRunner` with `engines: [buildOpenCodeEngine(registry)]`, plus the
  store/tools/workspace/environment. This is the explicit platform composition
  root a future worker/daemon will consume.
- `package.json`: added `@vaulltcore/runner-opencode` dependency.
- `index.ts`: exported `buildOpenCodeRunner` + `OpenCodeExecutionOptions`.

### Test composition path

Deterministic tests continue to use `ScriptEngine` (runner) /
`ScriptModelProvider` via `ProviderRegistry.resolver()` (adapter). Production
uses `buildOpenCodeEngine` / `buildOpenCodeRunner` with the BYOK registry. The
neutral runner is not changed to know either engine.

### Development vs production composition (summary)

```
PRODUCTION:
  buildOpenCodeRunner          (control/future worker)
    → buildOpenCodeEngine      (runner-opencode)
      → OpenCodeEngine         (AgentEngine)
        → modelsProviderResolver → ModelRegistry.resolve (BYOK credential)
          → modelsAdapterToProvider (bridge) → ModelProviderAdapter

TEST:
  DurableAgentRunner + engines: [new OpenCodeEngine(registry.resolver())]
    → ScriptModelProvider      (deterministic, no network)
```

### Configuration and secret boundaries

- Public identifiers (`connectionId`, `provider`) are carried in
  `JobSpec.engineOptions` — configuration, not secrets.
- The production path resolves the tenant's secret through the existing
  authoritative `CredentialResolver` inside `ModelRegistry`; the adapter holds
  the secret transiently.
- The bridge, engine, and narrow composition factory never serialize credential
  material into job events, checkpoints, continuation state, audit records,
  metrics, logs, thrown/surfaced errors, persisted configuration, or API
  responses.
- No ambient-secret convention was introduced. No new credential authority was
  created (existing credential infrastructure remains authoritative).

### Error, cancellation, recovery semantics

- **Engine failure**: a models `error{IntegrationError}` maps to the wire
  `provider-error` event; `normalizeTurnEvent` throws a sanitized error. The
  runner transitions the job to terminal `failed` (non-simulated engine error
  → `failJob`), emitting a sanitized `error` event. No fabricated success, no
  swallowed errors.
- **Cancellation**: the runner owns cancellation. `OpenCodeEngine` threads the
  runner's `AbortSignal` into `ModelProvider.stream`; the adapter observes it.
  The runner produces exactly one terminal outcome.
- **Retry**: no engine-level retry was introduced. The bridge and engine do not
  bypass durable state, policy, reliability controls, or existing
  retry/recovery semantics.
- **Recovery**: recovery remains runner-controlled. The adapter adds no second
  checkpoint/resume mechanism; it rebuilds a session from the runner's committed
  history projection.
- **Unknown/malformed responses**: malformed wire content throws / is mapped to
  a safe representation; unknown data is never cast into trusted internal
  contracts.
- **Bounds**: externally produced data is bounded by the existing adapters and
  runner limits; no arbitrary new limits were invented.

### Lifecycle / checkpoint / event ownership

- `DurableAgentRunner` remains the sole execution authority: leases, ownership
  fencing, checkpoints, durable events, settlement, recovery orchestration, and
  cancellation authority all stay in the runner.
- `OpenCodeEngine` owns only prompt/history assembly and one-provider-turn-per-
  step streaming. It is an adapter (a `ModelProvider` / `AgentEngine` boundary);
  it creates no durable job state.

---

## 3. Cleanup

### Deleted

- Nothing was deleted. The existing architecture was sound; only two cosmetic
  comment corrections were made.

### Retained

- `ScriptEngine` (runner) and `ScriptModelProvider` / `ProviderRegistry`
  (adapter) — genuine deterministic test infrastructure.
- `ProviderRegistry` — kept as the deterministic provider source, with a new
  `.resolver()` seam.
- The extracted OpenCode kernel (`kernel/llm.ts`, `kernel/normalize.ts`) — the
  wire vocabulary, untouched except unchanged usage.

### Corrected

- `model-provider.ts` header comment: the stale "Phase 1A ships a deterministic
  provider" framing was corrected to describe the deterministic/test path vs the
  production BYOK path and the `SessionProviderResolver` seam.

---

## 4. Tests

New deterministic tests (no network, no live providers):

- `packages/vaulltcore-runner-opencode/test/models-bridge.test.ts` (8 tests):
  contract conformance of the bridge, normal text/tool-call normalization,
  wire→models request translation (tool results split, text joined), malformed
  content rejection (no unsafe casts), end-to-end through `DurableAgentRunner`
  with a fake adapter, provider-error → honest runner failure path with secret
  redaction, AbortSignal passthrough (runner owns cancellation), no fabricated
  success on missing finish.
- `packages/vaulltcore-control/test/execution.test.ts` (3 tests): the full
  production composition `buildOpenCodeRunner → buildOpenCodeEngine →
  ModelRegistry → CredentialResolver` with the REAL credential-backed stack
  (`SqlCredentialStore` + `InMemorySecretProvider` + `CredentialResolver` +
  `ModelRegistry` + `ModelConnectionService`) and a deterministic adapter.
  Proves a real job runs end-to-end, config errors surface honestly (no
  fabricated run), and the credential never leaks across any serialized runner
  output.

Existing `opencode-adapter.test.ts` (3 tests) updated for the resolver seam
(`registry.resolver()`), unchanged in coverage.

### Verification results (exact)

- `npm run typecheck` — **pass** (zero TypeScript errors).
- `npm test` — **478 passed / 25 skipped / 0 failures** (was 467 passed).
  The 25 skips are unchanged environment-gated tests: 10 PG multi-connection,
  7 Docker, 1 pglite-server, 7 live-conformance (GitHub/GitLab/Linear/
  Slack/OpenAI/Anthropic/Google) — skipped honestly because their services are
  unavailable in the sandbox; they were already gated before this phase and are
  reported as skips, never passes.
- lint/format: **N/A** — the repository has no lint or format scripts
  configured (`ls .eslintrc* .prettierrc*` empty, no `lint`/`format` npm
  scripts). No compiler settings were weakened; no ESLint rules disabled.

Targeted runs: `runner-opencode` (11 tests, pass), `control/execution.test.ts`
(3 tests, pass).

---

## 5. Deferred Work

Explicitly out of scope and **not implemented** here:

- **Phase 3A.2**: real production tools (filesystem/shell) and the Docker
  execution environment.
- **Phase 3A.3**: a real worker/daemon runtime and the complete control-plane →
  execution end-to-end durable path.

`docs/phase2d.md` Phase 2D recommendations for "bridge ModelStreamEvent → runner
ModelProvider adapter" and "webhook trigger → run dispatch" are also not part of
this phase's activation scope beyond the engine path assembled here.

---

## 6. Completion Summary

- **Git**: starting `4c3d3dc` → see final commit in section 7 of the completion
  message; clean working tree after commit.
- **Architecture**: production engine path is `DurableAgentRunner →
  OpenCodeEngine (AgentEngine) → modelsProviderResolver → ModelRegistry →
  modelsAdapterToProvider → ModelProviderAdapter`. `DurableAgentRunner` remains
  the lifecycle authority. OpenCode remains an adapter; the neutral runner is
  unchanged and provider/runtime neutral.
- **Invariants**: no Phase 1–2G invariant weakened (see completion message).