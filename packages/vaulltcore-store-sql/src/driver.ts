/**
 * Minimal relational-driver seam for the SQL job store.
 *
 * The store speaks only this interface plus a {@link SqlDialect}; it never
 * references node:sqlite (or any driver) directly. SQLite via node:sqlite is
 * the reference implementation (zero dependencies, single file, real
 * transactions); a PostgreSQL driver implements the same three methods with
 * `$n` placeholders and `BEGIN` isolation semantics — no store changes.
 */

// node:sqlite is an experimental builtin (Node >= 22.5) that is missing from
// the exported builtinModules list; build-time resolvers (vite/vitest) that
// strip the `node:` prefix fail on it. Loading through createRequire keeps the
// specifier opaque to bundlers while `typeof import(...)` keeps full types.
import { createRequire } from "node:module"

const nodeRequire = createRequire(import.meta.url)
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite")
type DatabaseSync = import("node:sqlite").DatabaseSync

export type SqlValue = null | number | bigint | string | Uint8Array
export type SqlRow = Record<string, unknown>

export interface SqlStatement {
  run(...params: SqlValue[]): { changes: number }
  get(...params: SqlValue[]): SqlRow | undefined
  all(...params: SqlValue[]): SqlRow[]
}

export interface SqlDatabase {
  exec(sql: string): void
  prepare(sql: string): SqlStatement
  close(): void
}

export interface SqlDialect {
  readonly name: string
  /** Opens a transaction that takes the write lock immediately, so the
   * read-modify-write fencing checks inside it are race-free. */
  beginImmediateStatement(): string
  /** Rewrite `?` positional placeholders into the driver's native style
   * (`?` for SQLite/MySQL, `$1..$n` for PostgreSQL). */
  parameterize(sql: string): string
}

export const sqliteDialect: SqlDialect = {
  name: "sqlite",
  beginImmediateStatement: () => "BEGIN IMMEDIATE",
  parameterize: (sql) => sql,
}

/** Dialect descriptor for a future PostgreSQL driver (DDL/migration
 * boundaries already assume ANSI-ish SQL; statements remain `?`-style in the
 * store and are rewritten here). */
export const postgresDialect: SqlDialect = {
  name: "postgres",
  beginImmediateStatement: () => "BEGIN",
  parameterize: (sql) => {
    let index = 0
    return sql.replace(/\?/g, () => `$${++index}`)
  },
}

/** node:sqlite reference driver. Requires Node >= 22.5. */
export class NodeSqliteDatabase implements SqlDatabase {
  private readonly db: DatabaseSync

  private constructor(db: DatabaseSync) {
    this.db = db
  }

  static open(path: string): NodeSqliteDatabase {
    const db = new DatabaseSync(path)
    db.exec("PRAGMA journal_mode = WAL")
    db.exec("PRAGMA foreign_keys = ON")
    db.exec("PRAGMA busy_timeout = 5000")
    return new NodeSqliteDatabase(db)
  }

  static memory(): NodeSqliteDatabase {
    return NodeSqliteDatabase.open(":memory:")
  }

  exec(sql: string): void {
    this.db.exec(sql)
  }

  prepare(sql: string): SqlStatement {
    const statement = this.db.prepare(sql)
    return {
      run: (...params) => {
        const result = statement.run(...params)
        return { changes: Number(result.changes) }
      },
      get: (...params) => statement.get(...params) as SqlRow | undefined,
      all: (...params) => statement.all(...params) as SqlRow[],
    }
  }

  close(): void {
    this.db.close()
  }
}
