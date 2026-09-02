/**
 * Vaulltcore Reliability Layer (Phase 2E).
 *
 * Production reliability, operations, recovery, and tenant-safe backpressure
 * over the existing durable B2B automation system. Strengthens everything
 * AROUND the Phase 1–2D path: durability → recovery → retries → leases →
 * dead-letter handling → reconciliation → observability → operational controls
 * → tenant-safe backpressure. When processes crash, workers restart, queues
 * duplicate messages, databases temporarily fail, providers send duplicate
 * events, or execution becomes overloaded, Vaulltcore recovers predictably
 * without silently losing customer work.
 *
 * Dependency direction (enforced, acyclic):
 *   reliability → {ops, automation (types + service seams), quota, audit,
 *                  store-sql}
 *   control → reliability
 * The runner imports NONE of these. The hard seam holds. No second agent
 * runtime, no second authorization model, no provider SDK in core.
 *
 * Invariants that must not regress (Phase 2E additions):
 *   - A process being alive is never proof it still owns work; every
 *     recoverable worker-owned operation has a durable fenced lease (ops claim
 *     generation, dispatch redrive generation, quota reservation version).
 *   - A stale worker (older generation/version) can never finalize, overwrite,
 *     or transition work after a newer generation took over (CAS fencing).
 *   - Policy/quota/auth/validation/cancelled/timeout rejections are NEVER
 *     retried as infrastructure failures (explicit failure classification).
 *   - Retries are bounded + persisted (next-attempt timestamps, attempt
 *     history); recovery after restart derives pending retries from durable
 *     state alone (no in-memory timers as source of truth).
 *   - Exhausted/poisoned work enters an explicit terminal dead-letter state;
 *     operator redrive is authorized, tenant-isolated, idempotent, never
 *     resurrects terminal work, never creates duplicate durable identities.
 *   - Reconciliation is safe to run repeatedly + concurrently; every repair is
 *     a fenced/idempotent transition; bounded batch + continuation so it is
 *     never an unbounded DB operation; never invokes agent execution.
 *   - Per-tenant + global capacity ceilings; capacity released on terminal
 *     completion; leaked capacity recovered after crashes; one tenant cannot
 *     consume another tenant's reserved capacity; delayed work gets an honest
 *     state, never silently dropped.
 *   - Cancellation/timeout race behavior is durable-ordered (fenced CAS), not
 *     process-timed; a late worker cannot resurrect cancelled/terminal work.
 *   - Telemetry never emits credentials, auth headers, API keys, tokens,
 *     secret references, or unrestricted raw payloads (sanitizeMetadata +
 *     metadata builders never put secrets in).
 *   - Cross-tenant reads return nothing (404 indistinguishable from absence).
 */

export * from "./telemetry"
export * from "./cancellation"
export * from "./reconciliation"
export * from "./redrive"
export * from "./health"
