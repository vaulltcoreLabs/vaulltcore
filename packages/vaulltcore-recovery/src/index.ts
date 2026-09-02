/**
 * Vaulltcore Phase 2B Recovery (operational reapers + stuck-run scanner).
 *
 * Concrete {@link OpsReaper} implementations for approval expiry, delivery
 * retry, and abandoned runs, plus a {@link RecoveryScanner} that reads
 * authoritative automation state and enqueues ops work items. The scanner is
 * read-only; all repairs happen through the fenced ops worker + reapers, which
 * call the automation store/service's existing recovery-safe methods.
 *
 * Recovery never invokes agent execution. It re-projects durable state and
 * re-drives stuck runs via {@link AutomationService.reconcileRun} (idempotent:
 * the dispatcher deduplicates on (runId, stepId); delivery is idempotent on its
 * idempotencyKey).
 *
 * Dependency direction: recovery → {automation, ops, store-sql, audit}. It
 * never depends on the runner or the control plane.
 */

export {
  RecoveryScanner,
  buildReapers,
  type RecoveryScannerOptions,
  type RecoveryReapers,
  type ScanResult,
} from "./recovery"
export type { OpsReaper, OpsWorkItem, OpsClaim, OpsWorkResult } from "@vaulltcore/ops"
