/**
 * Automation product-layer ID generation (Phase 2A).
 *
 * Reuses the neutral monotonic {@link ascending} generator from the runner so
 * all Vaulltcore IDs share one sortable, dependency-free format. The product
 * prefixes (`tmpl_`, `ver_`, …) keep product identity distinct from execution
 * identity (`job_`) at a glance.
 */

import { ascending } from "@vaulltcore/runner"

export const newTemplateId = (): string => "tmpl_" + ascending()
export const newVersionId = (): string => "ver_" + ascending()
export const newRunId = (): string => "run_" + ascending()
export const newInputRevisionId = (): string => "inp_" + ascending()
export const newArtifactId = (): string => "art_" + ascending()
export const newApprovalId = (): string => "apr_" + ascending()
export const newDeliveryId = (): string => "dlv_" + ascending()
export const newMappingId = (): string => "map_" + ascending()
// Phase 2D: trigger + dispatch identity.
export const newTriggerId = (): string => "trg_" + ascending()
export const newDispatchId = (): string => "dsp_" + ascending()

/** Deterministic idempotency key for a (run, step) job creation. A restart
 *  re-derives the same key, so the admission pipeline's idempotency registry
 *  collapses a duplicate create into the original job — no duplicate work. */
export const stepIdempotencyKey = (runId: string, stepId: string): string => `auto:${runId}:${stepId}`
