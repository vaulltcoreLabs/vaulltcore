/**
 * Durable reconciliation store (Phase 1F). Owns the `reconciliation_runs` and
 * `reconciliation_gaps` tables (migration v9). The run row's `watermark` is the
 * SOLE durable progress source: an interrupted reconciliation run resumes from
 * the last committed watermark without re-projecting or dropping records. No
 * in-memory cursor is authoritative.
 *
 * Gaps carry a UNIQUE identity `(tenant_id, kind, ref_type, ref_id, ref_seq)` so
 * detecting the same gap across runs records it exactly once; repairing a gap
 * flips its state to `repaired` (idempotent).
 */

import { SqlStoreBase, type SqlStoreBaseOptions, type SqlDatabase, MIGRATIONS } from "@vaulltcore/store-sql"
import { randomBytes } from "node:crypto"

export const RECONCILIATION_STATES = ["running", "completed", "failed", "interrupted"] as const
export type ReconciliationRunState = (typeof RECONCILIATION_STATES)[number]

export const GAP_STATES = ["open", "repaired", "unresolved"] as const
export type GapState = (typeof GAP_STATES)[number]

export const GAP_KINDS = [
  "missing_usage_event",
  "unpriced_usage",
  "missing_ledger_entry",
  "duplicate_candidate",
  "orphaned_reservation",
  "terminal_unsettled_reservation",
  "invalid_identity_ref",
] as const
export type GapKind = (typeof GAP_KINDS)[number]

export interface ReconciliationRun {
  readonly runId: string
  readonly tenantId: string
  readonly scope: string
  readonly startedAt: number
  readonly finishedAt: number | null
  readonly status: ReconciliationRunState
  readonly watermark: number
  readonly gapsFound: number
  readonly gapsRepaired: number
  readonly error: string | null
}

export interface ReconciliationGap {
  readonly gapId: string
  readonly tenantId: string
  readonly kind: GapKind
  readonly refType: string
  readonly refId: string
  readonly refSeq: number | null
  readonly state: GapState
  readonly detail: string | null
  readonly detectedAt: number
  readonly repairedAt: number | null
  readonly runId: string | null
}

interface RunRow {
  run_id: string
  tenant_id: string
  scope: string
  started_at: number
  finished_at: number | null
  status: string
  watermark: number
  gaps_found: number
  gaps_repaired: number
  error: string | null
}

interface GapRow {
  gap_id: string
  tenant_id: string
  kind: string
  ref_type: string
  ref_id: string
  ref_seq: number | null
  state: string
  detail: string | null
  detected_at: number
  repaired_at: number | null
  run_id: string | null
}

function toRun(r: RunRow): ReconciliationRun {
  return {
    runId: r.run_id,
    tenantId: r.tenant_id,
    scope: r.scope,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    status: r.status as ReconciliationRunState,
    watermark: r.watermark,
    gapsFound: r.gaps_found,
    gapsRepaired: r.gaps_repaired,
    error: r.error,
  }
}

function toGap(r: GapRow): ReconciliationGap {
  return {
    gapId: r.gap_id,
    tenantId: r.tenant_id,
    kind: r.kind as GapKind,
    refType: r.ref_type,
    refId: r.ref_id,
    refSeq: r.ref_seq,
    state: r.state as GapState,
    detail: r.detail,
    detectedAt: r.detected_at,
    repairedAt: r.repaired_at,
    runId: r.run_id,
  }
}

/** Durable reconciliation ledger (run history + detected gaps). */
export class SqlReconciliationStore extends SqlStoreBase {
  constructor(db: SqlDatabase, options: SqlStoreBaseOptions = {}) {
    super(db, MIGRATIONS, options)
  }

  /** Begin a run: create a `running` row seeded with the previous run's
   *  watermark (resume boundary). Any prior `running`/`interrupted` run for the
   *  same (tenant, scope) is marked `interrupted` — it cannot remain
   *  authoritative once a new run starts. */
  beginRun(tenantId: string, scope: string): ReconciliationRun {
    const runId = randomBytes(8).toString("hex")
    const now = Date.now()
    return this.atomic("recon_begin_run", (): ReconciliationRun => {
      // Mark any still-running prior run for this scope as interrupted.
      this.prepare(
        "UPDATE reconciliation_runs SET status = 'interrupted', finished_at = ?, error = COALESCE(error, 'superseded by newer run') WHERE tenant_id = ? AND scope = ? AND status = 'running'",
      ).run(now, tenantId, scope)
      // Seed the new watermark from the last completed/interrupted run.
      const prev = this.prepare(
        "SELECT watermark FROM reconciliation_runs WHERE tenant_id = ? AND scope = ? AND status IN ('completed','interrupted') ORDER BY finished_at DESC, started_at DESC LIMIT 1",
      ).get(tenantId, scope) as { watermark: number } | undefined
      const watermark = prev?.watermark ?? 0
      this.prepare(
        "INSERT INTO reconciliation_runs (run_id, tenant_id, scope, started_at, finished_at, status, watermark, gaps_found, gaps_repaired, error) VALUES (?, ?, ?, ?, NULL, 'running', ?, 0, 0, NULL)",
      ).run(runId, tenantId, scope, now, watermark)
      return { runId, tenantId, scope, startedAt: now, finishedAt: null, status: "running", watermark, gapsFound: 0, gapsRepaired: 0, error: null }
    })
  }

  /** Advance the durable watermark mid-run (checkpoint). Idempotent: only
   *  moves the watermark forward. */
  advanceWatermark(runId: string, watermark: number): void {
    this.atomic("recon_advance", () => {
      this.prepare("UPDATE reconciliation_runs SET watermark = ? WHERE run_id = ? AND watermark < ?").run(watermark, runId, watermark)
    })
  }

  /** Record a detected gap (idempotent on identity). Returns whether this was a
   *  newly-opened gap (true) vs. an already-known gap (false). */
  recordGap(tenantId: string, kind: GapKind, refType: string, refId: string, refSeq: number | null, detail: string | null, runId: string): boolean {
    const gapId = randomBytes(8).toString("hex")
    const now = Date.now()
    return this.atomic("recon_record_gap", (): boolean => {
      const existing = this.prepare(
        "SELECT gap_id, state FROM reconciliation_gaps WHERE tenant_id = ? AND kind = ? AND ref_type = ? AND ref_id = ? AND COALESCE(ref_seq, -1) = ?",
      ).get(tenantId, kind, refType, refId, refSeq ?? -1) as { gap_id: string; state: string } | undefined
      if (existing) {
        // Already known: do not duplicate. Bump the run reference + detail.
        this.prepare("UPDATE reconciliation_gaps SET run_id = ?, detail = COALESCE(?, detail) WHERE gap_id = ?").run(runId, detail, existing.gap_id)
        return false
      }
      this.prepare(
        "INSERT INTO reconciliation_gaps (gap_id, tenant_id, kind, ref_type, ref_id, ref_seq, state, detail, detected_at, repaired_at, run_id) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, NULL, ?)",
      ).run(gapId, tenantId, kind, refType, refId, refSeq, detail, now, runId)
      this.prepare("UPDATE reconciliation_runs SET gaps_found = gaps_found + 1 WHERE run_id = ?").run(runId)
      return true
    })
  }

  /** Mark a gap repaired (idempotent; only flips open->repaired). */
  markGapRepaired(tenantId: string, kind: GapKind, refType: string, refId: string, refSeq: number | null): void {
    const now = Date.now()
    this.atomic("recon_repair_gap", () => {
      const result = this.prepare(
        "UPDATE reconciliation_gaps SET state = 'repaired', repaired_at = ? WHERE tenant_id = ? AND kind = ? AND ref_type = ? AND ref_id = ? AND COALESCE(ref_seq, -1) = ? AND state = 'open'",
      ).run(now, tenantId, kind, refType, refId, refSeq ?? -1)
      if (result.changes > 0) {
        // Find the run for accounting; repair counts against the latest run.
        const gap = this.prepare(
          "SELECT run_id FROM reconciliation_gaps WHERE tenant_id = ? AND kind = ? AND ref_type = ? AND ref_id = ? AND COALESCE(ref_seq, -1) = ?",
        ).get(tenantId, kind, refType, refId, refSeq ?? -1) as { run_id: string | null } | undefined
        if (gap?.run_id) {
          this.prepare("UPDATE reconciliation_runs SET gaps_repaired = gaps_repaired + 1 WHERE run_id = ?").run(gap.run_id)
        }
      }
    })
  }

  /** Mark a gap as durably unresolved (e.g. unresolvable pricing). */
  markGapUnresolved(tenantId: string, kind: GapKind, refType: string, refId: string, refSeq: number | null, detail: string | null): void {
    this.atomic("recon_unresolve_gap", () => {
      this.prepare(
        "UPDATE reconciliation_gaps SET state = 'unresolved', detail = COALESCE(?, detail) WHERE tenant_id = ? AND kind = ? AND ref_type = ? AND ref_id = ? AND COALESCE(ref_seq, -1) = ?",
      ).run(detail, tenantId, kind, refType, refId, refSeq ?? -1)
    })
  }

  /** Complete a run. */
  completeRun(runId: string, finalWatermark: number, error: string | null = null): ReconciliationRun {
    const now = Date.now()
    return this.atomic("recon_complete_run", (): ReconciliationRun => {
      this.prepare("UPDATE reconciliation_runs SET finished_at = ?, status = ?, watermark = CASE WHEN ? > watermark THEN ? ELSE watermark END, error = ? WHERE run_id = ?").run(
        now,
        error ? "failed" : "completed",
        finalWatermark,
        finalWatermark,
        error,
        runId,
      )
      const row = this.prepare("SELECT * FROM reconciliation_runs WHERE run_id = ?").get(runId) as unknown as RunRow
      return toRun(row)
    })
  }

  /** Last successful (completed) run for a (tenant, scope). */
  lastSuccessfulRun(tenantId: string, scope: string): ReconciliationRun | null {
    const row = this.prepare(
      "SELECT * FROM reconciliation_runs WHERE tenant_id = ? AND scope = ? AND status = 'completed' ORDER BY finished_at DESC LIMIT 1",
    ).get(tenantId, scope) as unknown as RunRow | undefined
    return row ? toRun(row) : null
  }

  getRun(runId: string): ReconciliationRun | null {
    const row = this.prepare("SELECT * FROM reconciliation_runs WHERE run_id = ?").get(runId) as unknown as RunRow | undefined
    return row ? toRun(row) : null
  }

  /** Open (unrepaired/unresolved) gaps for a tenant — operational backlog. */
  listOpenGaps(tenantId: string): ReconciliationGap[] {
    const rows = this.prepare(
      "SELECT * FROM reconciliation_gaps WHERE tenant_id = ? AND state IN ('open','unresolved') ORDER BY detected_at ASC",
    ).all(tenantId) as unknown as GapRow[]
    return rows.map(toGap)
  }

  /** All gaps for a tenant (inspection). */
  listGaps(tenantId: string): ReconciliationGap[] {
    const rows = this.prepare("SELECT * FROM reconciliation_gaps WHERE tenant_id = ? ORDER BY detected_at ASC").all(tenantId) as unknown as GapRow[]
    return rows.map(toGap)
  }

  /** Count of interrupted runs (H: interrupted reconciliation runs). */
  countInterruptedRuns(tenantId: string): number {
    const row = this.prepare("SELECT COUNT(*) AS c FROM reconciliation_runs WHERE tenant_id = ? AND status = 'interrupted'").get(tenantId) as { c: number }
    return row.c
  }
}
