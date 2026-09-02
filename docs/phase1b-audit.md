# Vaulltcore — Phase 1B AX Audit and Capability Matrix

AX commit audited: **`703a79f2a55def5be183ad7bd54da7c38cc22cc5`** (2026-08-13,
"Bump dependencies to fix the broken build"), `google/ax`, Apache-2.0 license.
Clone depth: full clone to `/tmp`. No AX code imported; every extracted concept below is a
protocol/algorithm re-implemented as Vaulltcore TypeScript.

## AX source map (verified, not README-only)

- `internal/controller/controller.go` — single-writer orchestrator; `Exec` derives
  resumption state by scanning the log; harness identity pinned ("resumption not
  allowed: harness ID changed"); `logger` appends `StepEvent`s.
- `internal/controller/eventlog/{eventlog,sql,postgres,sqlite}.go` — `Append/Events/Close`;
  per-conversation monotonic `step` assigned in a DB transaction.
- `internal/server/server.go` — "single-writer" enforced by a **process-local**
  `inFlight map[string]struct{} + sync.Mutex` (rejects duplicate in-flight
  conversations within one server process).
- `internal/ate/client.go` — Agent Substrate Control API client: `CreateActor`,
  `ResumeActor` (schedules onto a worker, returns worker IP), `SuspendActor`.
  Snapshot read/write is delegated to Agent Substrate (external repo).
- `internal/harness/harness.go` — `Harness{Start→Execution}`, `Execution{Run, Queue,
  ID, Close}`, `Handler{OnMessage, OnComplete}`; doc: controller guarantees at most
  one `Execution` per conversation (single-writer expectation).
- `internal/harness/stream.go` — `DrainStream`: outputs → `OnMessage`; terminated by
  exactly one end frame; missing end frame = execution error.
- `proto/ax.proto` — `StepEvent{conversation_id, interaction_id, agent_id, steps,
  state}`, `HarnessService.Connect` (start|cancel in, outputs|exactly-one-end out),
  `State {UNSPECIFIED,PENDING,FAILED,COMPLETED,CANCELED}`, InteractionsService
  (client stream; afterSeq replay unimplemented — TODO in source).
- `internal/harness/antigravityinteractions/cursorstore.go` — resume cursor
  (`PrevInteractionID` chain tail), hashed-ID filename, atomic temp+rename writes;
  comment: last-write-wins is "correct only because there is a single writer per
  conversation" (depends on the server-level invariant).
- `internal/harness/antigravityinteractions/workspace.go` — WorkDir made authoritative
  (executor guarantees command placement; never ambient cwd).
- `internal/controller/registry.go` — harness registry with validated IDs.
- `manifests/` — Kubernetes manifests; AX demos target Agent Substrate on K8s.

## Capability matrix

| # | Capability | AX source path | Phase 1A capability | Decision |
|---|---|---|---|---|
| 1 | Event log storage, append/read/scan | `controller/eventlog/*` (SQL txn seq) | `FileJobStore` JSONL + CAS seq | KEEP PHASE 1A (AX = transaction-shaped validation; concepts align) |
| 2 | Single-writer/controller ownership | `server/server.go` `inFlight` map (process-local!) | attempt/fence + CAS in store | COMBINE — Phase 1A fencing is strictly stronger; formalize ownership generations via ActorController |
| 3 | Conversation/execution identity | `proto/ax.proto StepEvent` | JobRecord + executionId | KEEP PHASE 1A |
| 4 | Actor lifecycle | `ate/client.go` Create/Resume/Suspend | none (suspendJob only) | ADAPT AX → `ExecutionActorController` |
| 5 | Suspend/resume protocol | `ate` + controller `ResumptionState` | resumeJob + checkpoint validation | COMBINE |
| 6 | Recovery after interruption | controller scan of last state | Phase 1A checkpoint validation | KEEP PHASE 1A + full recovery algorithm (identity→fence→checkpoint→events→workspace→snapshot→reconcile) |
| 7 | Snapshot interfaces | external (Agent Substrate); absent from repo | `WorkspaceProvider.snapshot` | ADAPT — Vaulltcore-neutral `ExecutionSnapshot` w/ mandatory logical fallback |
| 8 | Resumable stream protocol | harness framed stream + cursor | monotonic `afterSeq` replay | KEEP PHASE 1A (already richer); add framed-end + dedup documentation |
| 9 | Last-step/watermark | `cursorstore.resumeCursor` | `checkpoint.lastEventSeq` | KEEP PHASE 1A |
| 10 | Harness abstraction | `harness/harness.go` | AgentEngine seam | KEEP PHASE 1A (parallels: Queue≈submitInput, framed end provenance) |
| 11 | Actor↔harness comms | `HarnessService.Connect` | in-process `EngineTurnEvent` | KEEP PHASE 1A |
| 12 | Server/controller boundary | `server/server.go` | Runner public API | COMBINE (ActorController as the durable boundary) |
| 13 | Compute/runtime abstraction | `ate` gRPC→Substrate | `WorkspaceProvider` | ADAPT — neutral `ExecutionEnvironment` iface (no K8s) |
| 14 | Workspace/environment ownership | `workspace.go` WorkDir authoritative | `WorkspaceHandle` | KEEP PHASE 1A + explicit `getState/snapshot/restore` binding |
| 15 | Retry/duplicate prevention | Exec pinned harnessId, rejects mismatch | idempotency table | KEEP PHASE 1A |
| 16 | Multi-tenant boundaries | ATE atespace namespace | immutable tenant/org/project | KEEP PHASE 1A |
| 17 | State authoritative after process loss | eventlog scan | checkpoint + events | KEEP PHASE 1A |
| 18 | K8s / Agent Substrate requirement | `manifests/`, `ate` client | none | REJECT — no K8s dependency introduced; concepts only |
| 19 | Portable concepts | `eventlog`, `harness`, `cursor`, `ate` lifecycle | — | ADAPT — re-implemented in TS |

## Extracted AX concepts

1. **Actor lifecycle API** (`ate/client.go`): create → resume (schedule onto worker) →
   suspend. Adapted as Vaulltcore's `ExecutionActorController`.
2. **Single-writer as a documented contract** (`harness` doc + `server.inFlight`):
   every execution mutation must be fenced by ownership generation/token. AX implements
   it process-locally; Vaulltcore implements it durably (Phase 1A attempt fencing,
   Phase 1B formalized through acquire/release).
3. **Framed stream end** (`harness/stream.go DrainStream`): an execution turn must
   terminate with exactly one completion frame; absence = error. Adopted by the runner
   (now requires a finish/terminal event per turn; ScriptEngine/OpenCodeEngine emit one).
4. **Resume cursor struct** (`cursorstore.go`): hashed-ID path + atomic write; the
   *struct grows into richer resume state later* — mirrors Vaulltcore's
   `ContinuationPoint` durability without pretending the cursor is a checkpoint.
5. **WorkDir authoritative** (`workspace.go`): workspace identity bound to the job,
   never ambient cwd. Phase 1B formalizes `getState/snapshot/restore` against this.
6. **Suspended/resumed compute on the control plane** (README + `ate`): suspension is a
   first-class, explicit state (not an error); compute-level restore is an optimization
   where infrastructure supports it, else logical.

## Rejected AX concepts

- **Kubernetes/Agent Substrate coupling** (`manifests/`, `internal/ate`): gated on K8s
  CRDs/CRDs-style substrate; Vaulltcore must not depend on it. Neutral interfaces carry
  the protocol.
- **Process-local single-writer mutex** (`server.inFlight`): anti-pattern per Phase 1B
  requirements; Vaulltcore uses durable fencing. Noted as AX-TODO in their own code.
- **Event-log scan for resumption** (controller `ResumptionState`): last-state-wins;
  insufficient for safe continuation vs Vaulltcore checkpoint validation.
- **In-repo snapshot layer**: none exists (delegated to Substrate); Vaulltcore defines
  its own `ExecutionSnapshot` reference.
- **SQL event backends** (`eventlog/{postgres,sqlite}.go`): Phase 1A's file store is
  sufficient; a DB-backed store belongs to Phase 1C behind the same `DurableJobStore`.
- **gRPC harness protocol** (`HarnessService`): Vaulltcore keeps in-process engine seam
  until a remote harness protocol is actually required (Phase 1C candidate).
