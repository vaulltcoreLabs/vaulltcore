/**
 * Synchronous PostgreSQL driver over PGlite (Phase 1F).
 *
 * PGlite is real PostgreSQL 18 compiled to WASM. It is async-only, but the
 * neutral {@link SqlDatabase} seam is synchronous (so every {@link SqlStoreBase}
 * store can reuse a single atomic-commit code path). This adapter bridges the
 * two by running PGlite on a `worker_threads` worker and blocking the caller
 * thread on `Atomics.wait` until the result is written into a shared buffer.
 *
 * `Atomics.wait` is permitted on the Node main thread (unlike browsers), so
 * this works under vitest without special setup. The result is that every
 * business store (identity, quota, metering, billing, audit, admission
 * idempotency, reconciliation) runs UNCHANGED against genuine PostgreSQL —
 * validating SERIALIZABLE transactions, row locks, UNIQUE constraints and
 * partial indexes for real — with no store duplication.
 *
 * Compatibility shim: SQLite-isms that appear in the shared migration SQL
 * (`INSERT OR IGNORE`, `INTEGER PRIMARY KEY` rowid tricks) are rewritten to
 * portable PostgreSQL here so the SAME migration statements run on both
 * backends. This is a portability adapter, not a second store implementation.
 */

import { Worker } from "node:worker_threads"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { existsSync } from "node:fs"
import type { SqlDatabase, SqlDialect, SqlRow, SqlStatement, SqlValue } from "./driver"

/** Header layout in the shared result buffer: [0]=state, [1]=byte length. */
const HEADER_BYTES = 8
/** 0 = idle/pending, 1 = ok, 2 = error. */
const STATE_OK = 1
const STATE_ERR = 2

const RESULT_BUFFER_BYTES = 4 * 1024 * 1024

interface BridgeResult {
  ok: boolean
  rows?: unknown[]
  rowCount?: number
  error?: string
}

/** Rewrite SQLite-specific syntax in shared migration SQL to portable PG.
 *
 * The shared migration DDL is written for SQLite, where `INTEGER` is 64-bit.
 * PostgreSQL `INTEGER` is 32-bit and overflows for millisecond-epoch timestamp
 * columns, so DDL is rewritten to use `BIGINT` for integer columns. Only true
 * SQLite-isms are otherwise translated (`INSERT OR IGNORE`); the stores' DML is
 * already portable ANSI SQL (`ON CONFLICT (...) DO ...`, partial UNIQUE
 * indexes). This is a portability adapter, not a second store implementation. */
export function toPostgresSql(sql: string): string {
  let out = sql
  // `INSERT OR IGNORE INTO ...` (no existing conflict clause) becomes
  // `INSERT INTO ... ON CONFLICT DO NOTHING`. "OR IGNORE" is dropped.
  if (/^\s*INSERT\s+OR\s+IGNORE\s+INTO\s+/i.test(out) && !/ON\s+CONFLICT/i.test(out)) {
    const rewritten = out.replace(/^\s*INSERT\s+OR\s+IGNORE\s+INTO\s+/i, "INSERT INTO ")
    return /;\s*$/.test(rewritten) ? rewritten.replace(/;\s*$/, " ON CONFLICT DO NOTHING;") : `${rewritten} ON CONFLICT DO NOTHING`
  }
  // In DDL, widen INTEGER to BIGINT so 64-bit ms timestamps don't overflow
  // PostgreSQL's 32-bit INTEGER. (SQLite INTEGER is already 64-bit.)
  if (/^\s*CREATE\s+(TABLE|INDEX|UNIQUE)/i.test(out)) {
    out = out.replace(/\bINTEGER\b/g, "BIGINT")
  }
  return out
}

/** Dialect descriptor for PGlite (same as the async postgres dialect). */
export const pgliteDialect: SqlDialect = {
  name: "postgres",
  beginImmediateStatement: () => "BEGIN",
  parameterize: (sql) => {
    let index = 0
    return sql.replace(/\?/g, () => `$${++index}`)
  },
}

export interface PgliteDatabaseOptions {
  /** Reserved for future on-disk PGlite (default: in-memory). */
  readonly dataDir?: string
}

/**
 * Synchronous {@link SqlDatabase} over PGlite. Lazily spawns a worker that owns
 * the PGlite instance; each `exec`/`prepare().run|get|all` call blocks the
 * calling thread until the worker writes the result. `close()` terminates the
 * worker (and its PGlite instance).
 */
export class PgliteDatabase implements SqlDatabase {
  private worker: Worker | null = null
  /** Shared ready flag set by the worker once PGlite is initialized. The
   *  driver cannot receive 'message' events while blocked in Atomics.wait, so
   *  readiness is signaled through shared memory (not a message). */
  private readyFlag: Int32Array | null = null

  constructor(_options: PgliteDatabaseOptions = {}) {
    // dataDir is accepted for API symmetry; PGlite defaults to in-memory here.
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const here = dirname(fileURLToPath(import.meta.url))
    // Resolve the worker entry. A built .js is preferred; otherwise the .ts
    // source is loaded with Node's type-stripping (Node >= 22.6).
    const tsPath = join(here, "pglite-worker.ts")
    const jsPath = join(here, "pglite-worker.js")
    const chosen = existsSync(jsPath) ? jsPath : tsPath
    const execArgv = chosen.endsWith(".ts") ? ["--experimental-strip-types"] : []
    // The ready flag is passed to the worker via workerData so the worker can
    // signal readiness through shared memory (the driver blocks on it).
    this.readyFlag = new Int32Array(new SharedArrayBuffer(8))
    this.worker = new Worker(chosen, { execArgv, workerData: { readyFlag: this.readyFlag.buffer } })
    return this.worker
  }

  /** Block the calling thread until the worker sets the ready flag. Worker
   *  errors are observed between waits (the 'error' listener fires when the
   *  loop is briefly unblocked). */
  private blockUntilReady(): void {
    const worker = this.ensureWorker()
    const flag = this.readyFlag!
    if (Atomics.load(flag, 0) === 1) return
    const state: { error: Error | null } = { error: null }
    const onErr = (e: Error): void => {
      state.error = e
    }
    worker.on("error", onErr)
    try {
      const deadline = Date.now() + 30_000
      while (Atomics.load(flag, 0) !== 1 && !state.error && Date.now() < deadline) {
        Atomics.wait(flag, 0, 0, 10)
      }
    } finally {
      worker.off("error", onErr)
    }
    if (state.error) throw new Error(`PGlite worker error: ${state.error.message}`)
    if (Atomics.load(flag, 0) !== 1) throw new Error("PGlite worker failed to initialize within 30s")
  }

  /** Synchronous round-trip: post request, block on Atomics.wait, parse result. */
  private syncRoundTrip(type: "exec" | "query", sql: string, params: readonly SqlValue[]): BridgeResult {
    if (!this.readyFlag || Atomics.load(this.readyFlag, 0) !== 1) this.blockUntilReady()
    const worker = this.worker!
    const sab = new SharedArrayBuffer(RESULT_BUFFER_BYTES)
    const view = new Int32Array(sab)
    Atomics.store(view, 0, 0)
    worker.postMessage({ type, sql, params: params as unknown[], buf: sab })
    const res = Atomics.wait(view, 0, 0, 30_000)
    const state = Atomics.load(view, 0)
    if (state === 0) {
      throw new Error(`PGlite bridge timed out (${res}) executing: ${sql.slice(0, 120)}`)
    }
    const len = view[1]
    const payload = Buffer.from(sab, HEADER_BYTES, len).toString("utf8")
    return JSON.parse(payload) as BridgeResult
  }

  exec(sql: string): void {
    const result = this.syncRoundTrip("exec", toPostgresSql(sql), [])
    if (!result.ok) throw new Error(result.error ?? "PGlite exec failed")
  }

  prepare(sql: string): SqlStatement {
    const compiled = toPostgresSql(sql)
    return {
      run: (...params: SqlValue[]) => {
        const result = this.syncRoundTrip("query", compiled, params)
        if (!result.ok) throw new Error(result.error ?? "PGlite run failed")
        return { changes: result.rowCount ?? (result.rows?.length ?? 0) }
      },
      get: (...params: SqlValue[]) => {
        const result = this.syncRoundTrip("query", compiled, params)
        if (!result.ok) throw new Error(result.error ?? "PGlite get failed")
        const row = result.rows?.[0]
        return (row ?? undefined) as SqlRow | undefined
      },
      all: (...params: SqlValue[]) => {
        const result = this.syncRoundTrip("query", compiled, params)
        if (!result.ok) throw new Error(result.error ?? "PGlite all failed")
        return (result.rows ?? []) as SqlRow[]
      },
    }
  }

  close(): void {
    if (this.worker) {
      try {
        this.worker.postMessage({ type: "close" })
      } catch {
        // ignore
      }
      this.worker.terminate().catch(() => {})
      this.worker = null
    }
    this.readyFlag = null
  }
}
