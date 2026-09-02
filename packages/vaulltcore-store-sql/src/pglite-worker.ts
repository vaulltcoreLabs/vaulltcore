/**
 * PGlite worker for the synchronous PostgreSQL bridge (Phase 1F).
 *
 * Runs a single in-process {@link PGlite} instance (real PostgreSQL 18 WASM)
 * on a worker thread. The owning thread ({@link PgliteDatabase}) issues
 * synchronous query/exec calls by posting a request with a SharedArrayBuffer
 * and blocking on `Atomics.wait`; this worker executes the async PGlite call,
 * then writes the JSON-encoded result into the buffer and notifies.
 *
 * PGlite is real PostgreSQL (not an emulator), so any store built on the
 * {@link SqlDatabase} seam can be validated against genuine SERIALIZABLE
 * transactions, row-level locks, UNIQUE constraints, and partial indexes
 * without an external server — while keeping the store code unchanged.
 */

import { isMainThread, parentPort, workerData } from "node:worker_threads"
import { PGlite } from "@electric-sql/pglite"

if (isMainThread) {
  throw new Error("pglite-worker must run on a worker thread, not the main thread")
}

const port = parentPort
if (!port) throw new Error("parentPort unavailable")

/** Shared ready flag (Int32Array over a SharedArrayBuffer) passed from the
 *  driver. The worker sets index 0 to 1 once PGlite is initialized, so the
 *  driver can block on Atomics.wait without relying on message events. */
const readyFlag: Int32Array | null =
  workerData && workerData.readyFlag instanceof SharedArrayBuffer
    ? new Int32Array(workerData.readyFlag as SharedArrayBuffer)
    : null

const db = new PGlite()
let closing = false
let initialized = false

/** Mark the worker ready via shared memory and a message (the message is a
 *  backstop; the driver primarily waits on the shared flag). */
async function markReady(): Promise<void> {
  if (initialized) return
  await db.query("SELECT 1")
  initialized = true
  if (readyFlag) {
    Atomics.store(readyFlag, 0, 1)
    Atomics.notify(readyFlag, 0)
  }
  port!.postMessage({ type: "ready" })
}

// Initialize eagerly so the driver's first call does not wait on a query.
void markReady().catch((e) => {
  port.postMessage({ type: "error", error: e instanceof Error ? e.message : String(e) })
})

/** Serialize a result payload into the SharedArrayBuffer and signal the caller. */
function writeResult(sab: SharedArrayBuffer, payload: Buffer, state: number): void {
  const view = new Int32Array(sab)
  const HEADER = PGLITE_HEADER_BYTES
  if (payload.length > sab.byteLength - HEADER) {
    const errPayload = Buffer.from(
      JSON.stringify({ ok: false, error: `result too large for bridge buffer (${payload.length} bytes)` }),
      "utf8",
    )
    view[1] = errPayload.length
    new Uint8Array(sab, HEADER, errPayload.length).set(errPayload)
    Atomics.store(view, 0, 2)
    Atomics.notify(view, 0)
    return
  }
  view[1] = payload.length
  new Uint8Array(sab, HEADER, payload.length).set(payload)
  Atomics.store(view, 0, state)
  Atomics.notify(view, 0)
}

// Shared constants with the driver (kept in sync manually — both files live here).
const PGLITE_HEADER_BYTES = 8

port.on("message", async (msg: { type: string; sql?: string; params?: unknown[]; buf?: SharedArrayBuffer }) => {
  if (msg.type === "ready") {
    await markReady()
    return
  }
  if (msg.type === "close") {
    closing = true
    await db.close()
    port.postMessage({ type: "closed" })
    return
  }
  if (msg.type === "exec" || msg.type === "query") {
    if (closing || !msg.buf) return
    // Ensure initialization before serving queries.
    if (!initialized) {
      try {
        await markReady()
      } catch (e) {
        const payload = Buffer.from(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }), "utf8")
        writeResult(msg.buf, payload, 2)
        return
      }
    }
    try {
      const res = await db.query(msg.sql ?? "", msg.params ?? [])
      const payload = Buffer.from(
        JSON.stringify({
          ok: true,
          rows: res.rows as unknown[],
          rowCount: res.rowCount ?? res.rows.length,
        }),
        "utf8",
      )
      writeResult(msg.buf, payload, 1)
    } catch (error) {
      const payload = Buffer.from(
        JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
        "utf8",
      )
      writeResult(msg.buf, payload, 2)
    }
  }
})
