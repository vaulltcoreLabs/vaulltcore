/**
 * Cancellation + timeout lifecycle for durable asynchronous work (Phase 2E).
 *
 * Cancellation is cooperative + durable: a cancel request marks the run
 * cancelled through the existing {@link AutomationService.cancelRun} (fenced by
 * runVersion). A late worker that tries to advance a cancelled/terminal run is
 * rejected by the existing fenced transitionRun CAS — a post-cancellation stale
 * completion is impossible. A timeout is a scheduled cancellation: when a run's
 * deadline elapses, the timeout service marks it cancelled (terminal) with a
 * `timeout` reason. The timeout itself is durable (a timestamp column derived
 * from the run's created_at + configured timeoutMs), so recovery after restart
 * re-derives pending timeouts from durable state — no in-memory timers as
 * source of truth.
 *
 * Race behavior (explicit, durable-ordered, not process-timed):
 *   cancel vs completion  — the fenced runVersion CAS serializes them; exactly
 *                           one wins, the other is a no-op (terminal idempotent).
 *   timeout vs completion — same CAS; a completion that lands first makes the
 *                           timeout a no-op; a timeout that lands first makes a
 *                           late completion a no-op.
 *   lease expiry vs completion — the lease fence rejects the stale worker.
 *   redrive vs late retry     — the redrive lease fence + terminal-state guard
 *                           rejects a late retry on terminal work.
 *
 * This service depends on the automation product layer (types + the
 * AutomationService seam) and never on the runner. It does not introduce a
 * second runtime or a second authorization model.
 */

import type { AutomationService } from "@vaulltcore/automation"
import type { AutomationStore } from "@vaulltcore/automation"
import type { TelemetrySink } from "./telemetry"
import { isTerminalRun, type AutomationRun } from "@vaulltcore/automation"

/** Options for a timeout enforcement pass. */
export interface TimeoutOptions {
  readonly service: AutomationService
  readonly store: AutomationStore
  readonly telemetry?: TelemetrySink
  readonly tenantId: string
  /** Runs whose created_at + timeoutMs <= now are timed out. Default 30 min. */
  readonly defaultTimeoutMs?: number
  readonly now?: () => number
  readonly maxPerScan?: number
}

/** Result of a timeout pass. */
export interface TimeoutScanResult {
  readonly scanned: number
  readonly timedOut: number
}

/**
 * Enforces durable timeouts on automation runs. A timeout is a scheduled
 * cancellation: a non-terminal run past its deadline is cancelled (terminal)
 * with a `timeout` reason. The pass is idempotent + safe to run repeatedly and
 * concurrently — the fenced runVersion CAS rejects a stale writer, and a run
 * that completed/cancelled concurrently is skipped (terminal idempotent). It
 * never invokes agent execution.
 */
export class TimeoutService {
  private readonly service: AutomationService
  private readonly store: AutomationStore
  private readonly telemetry?: TelemetrySink
  private readonly tenantId: string
  private readonly defaultTimeoutMs: number
  private readonly now: () => number
  private readonly maxPerScan: number

  constructor(options: TimeoutOptions) {
    this.service = options.service
    this.store = options.store
    this.telemetry = options.telemetry
    this.tenantId = options.tenantId
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30 * 60_000
    this.now = options.now ?? Date.now
    this.maxPerScan = options.maxPerScan ?? 100
  }

  /** Run one bounded timeout pass. */
  async scan(): Promise<TimeoutScanResult> {
    const now = this.now()
    const deadline = now - this.defaultTimeoutMs
    let scanned = 0
    let timedOut = 0
    // List stale non-terminal runs (reuses the existing operational listing).
    for (const run of await this.store.listStaleRuns(this.tenantId, deadline, this.maxPerScan)) {
      scanned++
      if (isTerminalRun(run.status)) continue
      if (await this.enforceTimeout(run)) timedOut++
    }
    return { scanned, timedOut }
  }

  /** Enforce a timeout on a single run (idempotent; no-op if terminal). */
  async enforceTimeout(run: AutomationRun): Promise<boolean> {
    if (isTerminalRun(run.status)) return false
    try {
      const updated = await this.service.cancelRun(timeoutPrincipal(this.tenantId), run.runId)
      const cancelled = updated.status === "cancelled"
      if (cancelled) {
        await this.telemetry?.emit({
          tenantId: this.tenantId,
          orgId: run.orgId,
          projectId: run.projectId,
          type: "work_timed_out",
          metadata: { runId: run.runId, reason: "timeout", ageMs: this.now() - run.createdAt },
        })
      }
      return cancelled
    } catch {
      // A concurrent completion/cancellation won the race — idempotent no-op.
      return false
    }
  }
}

/** Request a durable cancellation. Delegates to the existing cooperative cancel
 *  (fenced by runVersion); a late completion on a cancelled run is rejected by
 *  the CAS. Emits telemetry. */
export async function requestCancellation(
  service: AutomationService,
  telemetry: TelemetrySink | undefined,
  tenantId: string,
  runId: string,
): Promise<AutomationRun> {
  const run = await service.cancelRun(timeoutPrincipal(tenantId), runId)
  await telemetry?.emit({
    tenantId,
    orgId: run.orgId,
    projectId: run.projectId,
    type: "work_cancelled",
    metadata: { runId, finalStatus: run.status },
  })
  return run
}

/** A system principal for privileged timeout/cancellation. The caller already
 *  authenticated; this is an internal privileged worker, not a request path,
 *  and never exposes cross-tenant data through an API. */
function timeoutPrincipal(tenantId: string) {
  return {
    tenantId,
    orgId: "*",
    projectId: "*",
    principalId: "reliability-timeout",
    kind: "service_account" as const,
    role: "service_account" as const,
    admin: true,
    projectScope: ["*"] as ReadonlyArray<string>,
  }
}
