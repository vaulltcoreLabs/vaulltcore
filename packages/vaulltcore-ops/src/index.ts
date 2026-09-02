/**
 * Vaulltcore Operational Workers (Phase 2B).
 *
 * A durable, fenced operational work-item queue for retry/reaper work: approval
 * expiry, delivery retry, abandoned runs, expired reservations, stale
 * idempotency records, and artifact lifecycle cleanup. Reuses the Phase 1D
 * lease/heartbeat/fencing model; a crashed worker is safely replaceable.
 *
 * Dependency direction: ops → {store-sql (SqlStoreBase), audit}. It never
 * depends on the runner, automation, identity, or control plane. Reapers are
 * pluggable and perform only safe, idempotent operational cleanup — never agent
 * execution.
 */

export * from "./contracts"
export { SqlOpsStore, type SqlOpsStoreOptions } from "./store"
export { OperationalWorker, type OperationalWorkerDeps, type OpsWorkJobResult } from "./worker"
