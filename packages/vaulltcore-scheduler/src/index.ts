/**
 * Vaulltcore Durable Scheduler (Phase 2B).
 *
 * One-time + recurring, timezone-aware, versioned automation scheduling with
 * idempotent occurrence firing. A scheduler crash + restart never creates
 * duplicate runs: the durable (scheduleId, occurrenceId) identity is the
 * admission boundary (UNIQUE). Cron parsing + tz-aware next-run are
 * dependency-free (Intl DateTimeFormat).
 *
 * Dependency direction: scheduler → {store-sql, audit, automation (types)}. It
 * never depends on the runner, identity, or control plane. Admittance is
 * delegated to a neutral {@link ScheduleAdmitter} seam (the automation layer).
 *
 * This is NOT a general workflow engine.
 */

export * from "./contracts"
export * from "./cron"
export { SqlScheduleStore, type SqlScheduleStoreOptions } from "./store"
export { Scheduler, type SchedulerOptions } from "./scheduler"
