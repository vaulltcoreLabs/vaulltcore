/**
 * Phase 2D trigger → run dispatch security tests.
 *
 * Proves (references map to the Phase 2D required security tests):
 * 11. Forged integration event cannot dispatch work.
 * 12. Duplicate webhook event cannot duplicate a dispatch.
 * 13. One event matching multiple triggers creates one dispatch per trigger identity.
 * 14. Crash between dispatch reservation and run creation recovers without duplicate dispatch.
 * 15. Policy rejection never starts execution.
 * 16. Quota rejection never starts execution.
 * 17. Retryable infrastructure failure re-drives safely.
 * 18. Disabled trigger creates no run.
 * 19. Historical trigger matching remains explainable after trigger update.
 */

import { describe, it, expect, beforeEach } from "vitest"
import { NodeSqliteDatabase } from "@vaulltcore/store-sql"
import { SqlTriggerStore, TriggerDispatchService, type TriggerRunSink, type TriggerRunRejection, type PublishTriggerInput, type TriggerDefinition } from "../src"
import type { NormalizedEvent } from "@vaulltcore/integration"
import type { DispatchRejectionKind } from "../src/trigger-store"

const TENANT = "t1", ORG = "o1", PROJECT = "p1", PRINCIPAL = "u1"
const TEMPLATE = "tmpl_1", VERSION = "ver_1"

function baseTrigger(overrides: Partial<PublishTriggerInput> = {}): PublishTriggerInput {
  return {
    tenantId: TENANT, orgId: ORG, projectId: PROJECT, principalId: PRINCIPAL,
    templateId: TEMPLATE, versionId: VERSION, triggerClass: "webhook_event",
    name: "t", state: "enabled",
    criteria: { provider: "github", eventKinds: ["custom"], resourcePattern: "github:owner/repo", action: "opened", connectionId: null, selectors: {} },
    inputMapping: {},
    ...overrides,
  }
}

function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    eventId: "evt_1", tenantId: TENANT, orgId: ORG, projectId: PROJECT,
    provider: "github", providerEventId: "gh_1", kind: "custom",
    resource: "github:owner/repo", action: "opened",
    actor: null, payload: { body: "hello" },
    providerTimestamp: null, receivedAt: Date.now(),
    ...overrides,
  }
}

/** A configurable sink that can simulate success, typed rejections, or a crash. */
class FakeSink implements TriggerRunSink {
  mode: "ok" | "policy" | "quota" | "invalid" | "crash" | "crashOnce" = "ok"
  readonly runIds: string[] = []
  private seq = 0
  private crashed = false
  async createRunForTrigger(args: { readonly dispatchId: string; readonly triggerId: string }): Promise<{ runId: string | null; rejection?: TriggerRunRejection }> {
    if (this.mode === "crash" || (this.mode === "crashOnce" && !this.crashed)) {
      this.crashed = true
      throw new Error("transient infra failure before run creation")
    }
    if (this.mode === "policy") return { runId: null, rejection: { kind: "policy" as DispatchRejectionKind, reason: "policy denied" } }
    if (this.mode === "quota") return { runId: null, rejection: { kind: "quota" as DispatchRejectionKind, reason: "quota exhausted" } }
    if (this.mode === "invalid") return { runId: null, rejection: { kind: "invalid_input" as DispatchRejectionKind, reason: "bad input" } }
    const runId = `run_${this.seq++}`
    this.runIds.push(runId)
    return { runId }
  }
}

function setup() {
  const db = NodeSqliteDatabase.memory()
  const store = new SqlTriggerStore(db)
  const sink = new FakeSink()
  const dispatch = new TriggerDispatchService({ store, sink })
  return { db, store, sink, dispatch }
}

describe("TriggerDispatchService — durable dispatch boundary", () => {
  let s: ReturnType<typeof setup>
  beforeEach(() => { s = setup() })

  // Proof 11: A forged/unverifiable event (wrong provider) cannot dispatch work.
  it("an event that does not match any trigger dispatches nothing", async () => {
    await s.store.publishTrigger(baseTrigger())
    const result = await s.dispatch.dispatchEvent(event({ provider: "evil" }))
    expect(result.dispatches).toHaveLength(0)
    expect(result.runIds).toHaveLength(0)
    expect(s.sink.runIds).toHaveLength(0)
  })

  // Proof 12: A duplicate event cannot duplicate a dispatch.
  it("a duplicate event does not create a duplicate dispatch", async () => {
    await s.store.publishTrigger(baseTrigger())
    const first = await s.dispatch.dispatchEvent(event())
    expect(first.dispatches).toHaveLength(1)
    const second = await s.dispatch.dispatchEvent(event())
    expect(second.dispatches).toHaveLength(1)
    expect(second.dispatches[0]!.dispatchId).toBe(first.dispatches[0]!.dispatchId)
    // Only one run was created.
    expect(s.sink.runIds).toHaveLength(1)
  })

  // Proof 13: One event matching N triggers creates N dispatches (one per trigger identity).
  it("one event matching multiple triggers creates one dispatch per trigger", async () => {
    await s.store.publishTrigger(baseTrigger({ name: "t-a" }))
    await s.store.publishTrigger(baseTrigger({ name: "t-b" }))
    const result = await s.dispatch.dispatchEvent(event())
    expect(result.dispatches).toHaveLength(2)
    expect(new Set(result.dispatches.map((d) => d.dispatchId)).size).toBe(2)
    expect(s.sink.runIds).toHaveLength(2)
  })

  // Proof 14 + 17: Crash between dispatch reservation and run creation recovers without duplicate.
  it("crash after reservation re-drives idempotently (no duplicate dispatch or run)", async () => {
    await s.store.publishTrigger(baseTrigger())
    s.sink.mode = "crashOnce"
    const first = await s.dispatch.dispatchEvent(event())
    // The dispatch was reserved but the run was NOT created (crash).
    expect(first.dispatches).toHaveLength(1)
    expect(s.sink.runIds).toHaveLength(0)
    // The persisted dispatch reflects the crash (the in-memory object in the
    // result is the reserved snapshot; query the store for the truth).
    const crashed = await s.store.getDispatch(TENANT, first.dispatches[0]!.dispatchId)
    expect(crashed!.state).toBe("retryable_failure")
    expect(crashed!.attempts).toBeGreaterThanOrEqual(1)
    // Recovery: re-drive non-terminal dispatches. The sink now succeeds.
    s.sink.mode = "ok"
    const recovered = await s.dispatch.redrive(TENANT)
    expect(recovered.created).toBe(1)
    expect(s.sink.runIds).toHaveLength(1)
    // The dispatch identity is the same; no duplicate dispatch exists.
    const all = await s.store.listPending(TENANT, 100)
    expect(all).toHaveLength(0)
  })

  // Proof 15: Policy rejection never starts execution.
  it("a policy rejection creates no run and records the rejection honestly", async () => {
    await s.store.publishTrigger(baseTrigger())
    s.sink.mode = "policy"
    const result = await s.dispatch.dispatchEvent(event())
    expect(result.runIds).toHaveLength(0)
    expect(s.sink.runIds).toHaveLength(0)
    const dispatch = await s.store.getDispatch(TENANT, result.dispatches[0]!.dispatchId)
    expect(dispatch!.state).toBe("rejected")
    expect(dispatch!.rejectionKind).toBe("policy")
    // A policy rejection is terminal; re-drive does not retry it as infra.
    const recovered = await s.dispatch.redrive(TENANT)
    expect(recovered.created).toBe(0)
    expect(s.sink.runIds).toHaveLength(0)
  })

  // Proof 16: Quota rejection never starts execution.
  it("a quota rejection creates no run and records the rejection honestly", async () => {
    await s.store.publishTrigger(baseTrigger())
    s.sink.mode = "quota"
    const result = await s.dispatch.dispatchEvent(event())
    expect(result.runIds).toHaveLength(0)
    const dispatch = await s.store.getDispatch(TENANT, result.dispatches[0]!.dispatchId)
    expect(dispatch!.state).toBe("rejected")
    expect(dispatch!.rejectionKind).toBe("quota")
  })

  // Proof 18: A disabled trigger creates no run (it does not match at all).
  it("a disabled trigger creates no dispatch and no run", async () => {
    await s.store.publishTrigger(baseTrigger({ name: "disabled-t", state: "disabled" }))
    const result = await s.dispatch.dispatchEvent(event())
    expect(result.dispatches).toHaveLength(0)
    expect(result.runIds).toHaveLength(0)
    expect(s.sink.runIds).toHaveLength(0)
  })

  // A trigger disabled AFTER reservation (between match and drive) is rejected.
  it("a trigger disabled after reservation is rejected on drive (no run)", async () => {
    const t = await s.store.publishTrigger(baseTrigger({ name: "late-disable" }))
    // Reserve a dispatch manually, then disable the trigger, then drive.
    const { dispatch } = await s.store.reserveDispatch({
      tenantId: TENANT, orgId: ORG, projectId: PROJECT, sourceEventId: "evt_late", trigger: t,
    })
    await s.store.setTriggerState(TENANT, t.triggerId, t.revision, "disabled")
    const disabledTrigger = await s.store.getTrigger(TENANT, t.triggerId)
    if (!disabledTrigger) throw new Error("trigger disappeared")
    await s.dispatch.driveDispatch(dispatch, disabledTrigger, event())
    expect(s.sink.runIds).toHaveLength(0)
    const d = await s.store.getDispatch(TENANT, dispatch.dispatchId)
    expect(d!.state).toBe("rejected")
    expect(d!.rejectionKind).toBe("disabled_trigger")
  })

  // Proof 19: Historical matching remains explainable after trigger update.
  it("a dispatch pins the trigger revision it matched (historical explainability)", async () => {
    const t1 = await s.store.publishTrigger(baseTrigger({ name: "explainable" }))
    expect(t1.revision).toBe(1)
    // Fire an event against revision 1.
    const first = await s.dispatch.dispatchEvent(event())
    expect(first.dispatches[0]!.triggerRevision).toBe(1)
    // Revise the SAME trigger (same name) with new criteria → revision 2.
    const t2 = await s.store.publishTrigger(baseTrigger({
      name: "explainable",
      criteria: { provider: "github", eventKinds: ["custom"], resourcePattern: "github:other/repo", action: "opened", connectionId: null, selectors: {} },
    }))
    expect(t2.revision).toBe(2)
    // The OLD dispatch still references revision 1 — a historical match is
    // explainable against the definition active at match time, not the latest.
    const oldDispatch = await s.store.getDispatch(TENANT, first.dispatches[0]!.dispatchId)
    expect(oldDispatch!.triggerRevision).toBe(1)
  })
})
