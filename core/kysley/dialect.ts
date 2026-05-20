/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import {
	SqliteAdapter,
	SqliteIntrospector,
	SqliteQueryCompiler,
	type DatabaseIntrospector,
	type Dialect,
	type DialectAdapter,
	type Driver,
	type Kysely,
	type QueryCompiler,
} from "kysely"

import type { SqliteDialectConfig } from "#kysley/dialect-config"
import { SqliteDriver } from "#kysley/driver"

/**
 * SQLite dialect that uses the [`node:sqlite`](https://nodejs.org/api/sqlite.html) library.
 *
 * The constructor takes an instance of {@link SqliteDialectConfig}.
 *
 * ```ts
 * import { DatabaseSync } from 'node:sqlite'
 *
 * new SqliteDialect({
 *   database: new DatabaseSync("db.sqlite")
 * })
 * ```
 *
 * If you want the pool to only be created once it's first used, `database` can be a function:
 *
 * ```ts
 * import { DatabaseSync } from 'node:sqlite'
 *
 * new SqliteDialect({
 *   database: async () => new DatabaseSync("db.sqlite")
 * })
 * ```
 */
export class SqliteDialect implements Dialect {
	protected config: SqliteDialectConfig

	constructor(config: SqliteDialectConfig) {
		this.config = Object.freeze({ ...config })
	}

	createDriver(): Driver {
		return new SqliteDriver(this.config)
	}

	createQueryCompiler(): QueryCompiler {
		return new SqliteQueryCompiler()
	}

	createAdapter(): DialectAdapter {
		return new SqliteAdapter()
	}

	createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
		return new SqliteIntrospector(db)
	}
}
