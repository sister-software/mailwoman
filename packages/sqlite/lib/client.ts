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
} from "node:sqlite"

import { Kysely, type KyselyConfig } from "kysely"
import { PathBuilder, type PathBuilderLike } from "path-ts"

import type { Database } from "#database-schema"
import type { SqliteDialectConfig } from "#dialect/config"
import { SqliteDialect } from "#dialect/index"

/**
 * A connection's non-Kysely surface: the statements Kysely does not model, plus ending the connection.
 *
 * Schema-agnostic because Kysely is invariant in `DB`: a parameter typed
 * `DatabaseClient` would reject every real client.
 */
export type RawStatements = Pick<DatabaseClient, "exec" | "prepare" | "function" | "destroy"> & Disposable

/**
 * A SQLite client for one database file: a Kysely query builder over `node:sqlite`,
 * plus the two raw statements Kysely cannot express.
 */
export class DatabaseClient<DB = Database> extends Kysely<DB> implements Disposable {
	/**
	 * A memory-only database, for tests and other ephemeral work.
	 */
	public static temp<DB = Database>(): DatabaseClient<DB> {
		return new DatabaseClient<DB>(":memory:")
	}

	readonly #database: DatabaseSync

	constructor(location: PathBuilderLike, options?: DatabaseSyncOptions, config?: Partial<KyselyConfig>)
	constructor(database: DatabaseSync, config?: Partial<KyselyConfig>)
	constructor(dialectConfig: SqliteDialectConfig, config?: Partial<KyselyConfig>)
	constructor(
		source: PathBuilderLike | DatabaseSync | SqliteDialectConfig,
		optionsOrConfig?: DatabaseSyncOptions | Partial<KyselyConfig>,
		config?: Partial<KyselyConfig>
	) {
		let database: DatabaseSync
		let kyselyConfig: Partial<KyselyConfig> | undefined

		if (typeof source === "string" || source instanceof PathBuilder) {
			const location = source.toString()
			const options = optionsOrConfig as DatabaseSyncOptions | undefined
			// node:sqlite checks the argument count rather than the value: `new DatabaseSync(path, undefined)` throws.
			const openArgs: [string, DatabaseSyncOptions?] = options ? [location, options] : [location]

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
	 * Run a statement Kysely does not model: `pragma`, `vacuum`, `analyze`, `attach`, FTS5 virtual-table DDL.
	 */
	exec(sql: string): void {
		this.#database.exec(sql)
	}

	/**
	 * A prepared statement on this client's connection, for the bulk-write path.
	 */
	prepare(sql: string): StatementSync {
		return this.#database.prepare(sql)
	}

	/**
	 * Register a user-defined SQL function on this client's connection, callable from any statement it runs.
	 *
	 * SQLite resolves the name at statement-compile time, so registration must
	 * precede the first query that uses it.
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
	 * `destroy()` returns a promise that `Symbol.dispose` cannot await,
	 * and `node:sqlite`'s `close()` is synchronous.
	 */
	[Symbol.dispose](): void {
		this.#database[Symbol.dispose]()
	}
}

/**
 * The `node:sqlite` types a caller needs when it holds a statement or binds a value.
 */
export type { DatabaseSyncOptions, SQLInputValue, SQLOutputValue, StatementSync } from "node:sqlite"
