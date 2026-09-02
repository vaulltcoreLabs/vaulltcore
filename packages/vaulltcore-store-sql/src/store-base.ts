/**
 * Shared transaction + dialect plumbing for SQL-backed stores (Phase 1E).
 *
 * Every durable business store (identity, quota, metering, billing, audit)
 * wraps the same {@link SqlDatabase} through this base so the atomic-commit
 * boundary, dialect-aware placeholder rewriting, and rollback semantics are
 * identical to {@link SqlJobStore}. No business logic lives here — only the
 * transaction primitive, so the fencing/rollback invariants cannot drift.
 */

import { applyMigrations, type Migration } from "./migrations"
import { type SqlDatabase, type SqlDialect, type SqlStatement, sqliteDialect } from "./driver"

export interface SqlStoreBaseOptions {
  readonly dialect?: SqlDialect
  /** Fault-injection hook invoked inside the transaction immediately before
   * COMMIT; throwing forces a full rollback (used to prove no partial writes). */
  readonly beforeCommit?: (op: string) => void
}

export class SqlStoreBase {
  protected readonly dialect: SqlDialect
  readonly dialectName: string

  constructor(
    protected readonly db: SqlDatabase,
    migrations: readonly Migration[],
    options: SqlStoreBaseOptions = {},
  ) {
    this.dialect = options.dialect ?? sqliteDialect
    this.dialectName = this.dialect.name
    this.beforeCommit = options.beforeCommit
    applyMigrations(db, migrations, this.dialect)
  }

  protected readonly beforeCommit?: (op: string) => void

  /** Escape hatch for infrastructure concerns (tests, ops tooling). */
  database(): SqlDatabase {
    return this.db
  }

  close(): void {
    this.db.close()
  }

  /** Statements are written with `?` placeholders and rewritten per dialect. */
  protected prepare(sql: string): SqlStatement {
    return this.db.prepare(this.dialect.parameterize(sql))
  }

  /**
   * One atomic commit boundary. All driver statements are synchronous, so the
   * whole critical section executes without an await point: no interleaving is
   * possible between in-transaction checks and the writes they guard. A fault
   * thrown by {@link beforeCommit} rolls back everything — no partial writes.
   */
  protected atomic<T>(op: string, fn: () => T): T {
    this.db.exec(this.dialect.beginImmediateStatement())
    try {
      const result = fn()
      this.beforeCommit?.(op)
      this.db.exec("COMMIT")
      return result
    } catch (error) {
      try {
        this.db.exec("ROLLBACK")
      } catch {
        // rollback after a failed BEGIN is harmless
      }
      throw error
    }
  }
}

/** SQLite/PostgreSQL share the same UNIQUE-violation surface in practice. */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /unique constraint failed|duplicate key/i.test(error.message)
}
