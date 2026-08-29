/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import {
	DatabaseSync,
	type DatabaseSyncOptions,
	type FunctionOptions,
	type SQLInputValue,
	type SQLOutputValue,
	type StatementSync,
} from "@mailwoman/platform/sqlite"
import { Kysely, type KyselyConfig } from "kysely"

import type { Database } from "./database-schema.ts"
import type { SqliteDialectConfig } from "./dialect-config.ts"
import { SqliteDialect } from "./dialect.ts"

/**
 * A SQLite client for one database file: a Kysely query builder over `node:sqlite`, plus the two raw statements Kysely
 * cannot express.
 *
 * The client opens the file. A caller says which file and which schema; it never builds the connection itself.
 *
 * ```ts
 * using kdb = new DatabaseClient<MySchema>("db.sqlite", { readOnly: true })
 * ```
 *
 * Handing that job to callers is what let one database be described by two schemas — the type argument here and a
 * second one on the handle — with nothing to make them agree. It also split ownership: `SqliteDriver.destroy()` closes
 * whatever connection it was given, so a shared handle has two owners and the first `destroy()` closes it under the
 * other. One construction gives one schema, one owner, and a lifetime `using` can end.
 *
 * `exec` and `prepare` reach the same connection for the work Kysely does not model. See `core/db/schema.ts`.
 */
/**
 * A connection's non-Kysely surface: the statements Kysely does not model, plus ending the connection.
 *
 * Schema-agnostic by construction — none of these members mentions `DB` — so a `DatabaseClient<AnySchema>` satisfies it
 * and a helper need not name its caller's schema. That matters because Kysely is INVARIANT in `DB`: a parameter typed
 * `DatabaseClient` (the empty default) would reject every real client. This is the narrowing the
 * `mailwoman/no-database-handle-cast` rule prescribes, applied to the raw side.
 */
export type RawStatements = Pick<DatabaseClient, "exec" | "prepare" | "function" | "destroy"> & Disposable

export class DatabaseClient<DB = Database> extends Kysely<DB> implements Disposable {
	readonly #database: DatabaseSync

	constructor(location: string, options?: DatabaseSyncOptions, config?: Partial<KyselyConfig>)
	constructor(database: DatabaseSync, config?: Partial<KyselyConfig>)
	constructor(dialectConfig: SqliteDialectConfig, config?: Partial<KyselyConfig>)
	constructor(
		source: string | DatabaseSync | SqliteDialectConfig,
		optionsOrConfig?: DatabaseSyncOptions | Partial<KyselyConfig>,
		config?: Partial<KyselyConfig>
	) {
		let database: DatabaseSync
		let kyselyConfig: Partial<KyselyConfig> | undefined

		if (typeof source === "string") {
			const options = optionsOrConfig as DatabaseSyncOptions | undefined
			// node:sqlite checks the argument count, not the value: `new DatabaseSync(path, undefined)` throws.
			const openArgs: [string, DatabaseSyncOptions?] = options ? [source, options] : [source]

			database = new DatabaseSync(...openArgs)
			kyselyConfig = config
		} else {
			const dialectConfig = "database" in source ? source : { database: source }

			if (typeof dialectConfig.database === "function") {
				throw new TypeError(
					"DatabaseClient needs an open connection: a lazy `() => Promise<DatabaseSync>` leaves `exec` and " +
						"`prepare` with nothing to reach. Pass the database path instead."
				)
			}

			database = dialectConfig.database
			kyselyConfig = optionsOrConfig as Partial<KyselyConfig> | undefined
		}

		super({
			...kyselyConfig,
			dialect: new SqliteDialect({ database }),
		})

		this.#database = database
	}

	/**
	 * Run a statement Kysely does not model: `PRAGMA`, `VACUUM`, `ANALYZE`, `ATTACH`, FTS5 virtual-table DDL.
	 *
	 * Not to be confused with Kysely's `execute()`, which runs a compiled query. This one takes SQL text and returns
	 * nothing.
	 */
	exec(sql: string): void {
		this.#database.exec(sql)
	}

	/**
	 * A prepared statement on this client's connection, for the bulk-write path.
	 *
	 * Kysely compiles per call, which a positional insert loop over millions of rows cannot afford. Reach for this only
	 * there and in the other cases `AGENTS.md` lists as deliberately raw; everything cold goes through the query builder,
	 * where the schema is checked.
	 */
	prepare(sql: string): StatementSync {
		return this.#database.prepare(sql)
	}

	/**
	 * Register a user-defined SQL function on this client's connection, callable from any statement it runs.
	 *
	 * SQLite resolves the name at statement-compile time, so registration must precede the first query that uses it.
	 */
	function(name: string, options: FunctionOptions, fn: (...args: SQLOutputValue[]) => SQLInputValue): void
	function(name: string, fn: (...args: SQLOutputValue[]) => SQLInputValue): void
	function(
		name: string,
		optionsOrFn: FunctionOptions | ((...args: SQLOutputValue[]) => SQLInputValue),
		fn?: (...args: SQLOutputValue[]) => SQLInputValue
	): void {
		if (typeof optionsOrFn === "function") {
			this.#database.function(name, optionsOrFn)

			return
		}

		this.#database.function(name, optionsOrFn, fn!)
	}

	/**
	 * End the connection at scope exit, synchronously.
	 *
	 * `destroy()` is Kysely's teardown and returns a promise, which `Symbol.dispose` cannot await — calling it here would
	 * return with the file still open, and the next thing to touch that path (a `sealDatabase`, a reader expecting a
	 * finalized statement) would see a connection that should have been gone. `node:sqlite`'s `close()` is synchronous,
	 * so `using` closes the file before the scope ends.
	 *
	 * Kysely's own driver state is not unwound here. It holds this one connection and nothing else, and a query issued
	 * afterwards fails on the closed handle rather than on a pool that thinks it is alive.
	 */
	[Symbol.dispose](): void {
		this.#database.close()
	}
}

/**
 * The `node:sqlite` types a caller needs when it holds a statement or binds a value. Re-exported so nothing has to
 * reach past this package for them.
 */
export type { DatabaseSyncOptions, SQLInputValue, SQLOutputValue, StatementSync } from "@mailwoman/platform/sqlite"
