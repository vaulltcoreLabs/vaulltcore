/**
 * Worker heartbeat sink — where a {@link WorkerHost} reports liveness. The
 * control-plane supervisor/reconciler implements this (or reads the durable
 * worker_heartbeats table) to classify worker loss.
 */

import type { WorkerHeartbeat } from "@vaulltcore/runner"

export interface WorkerHeartbeatSink {
  record(hb: WorkerHeartbeat): void
}
