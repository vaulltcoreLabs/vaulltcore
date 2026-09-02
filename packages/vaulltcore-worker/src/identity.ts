/**
 * Worker identity + heartbeat primitives (Phase 1D).
 *
 * A worker's stable execution identity: `workerId` is durable (a supervisor
 * can list known workers), `bootToken` rotates on every process start so a
 * reincarnated worker is distinguishable from a zombie still holding an old job
 * in memory. The lease-renewal loop is fenced: an old worker waking up after a
 * network partition can never reclaim authority merely because it still has the
 * old job in memory — its stale token is rejected by the dispatcher/store.
 *
 * The contract types live in the neutral runner package
 * ({@link WorkerIdentity}, {@link WorkerHeartbeat}) so the control plane and
 * workers share one definition without the worker package gaining runtime deps.
 */

export type { WorkerIdentity, WorkerHeartbeat, WorkerLease, LeaseExpiry } from "@vaulltcore/runner"
import { newWorkerId, newBootToken } from "@vaulltcore/runner"
import type { WorkerIdentity } from "@vaulltcore/runner"

/** Mint a fresh worker identity (call once per process start). */
export function newWorkerIdentity(label?: string): WorkerIdentity {
  return { workerId: newWorkerId(), bootToken: newBootToken(), label }
}
