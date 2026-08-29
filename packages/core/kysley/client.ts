/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { DatabaseSync, type DatabaseSyncOptions } from "@mailwoman/platform/sqlite"
import { Kysely, type KyselyConfig } from "kysely"

import type { Database } from "../db/schema.ts"
import type { SqliteDialectConfig } from "./dialect-config.ts"
import { SqliteDialect } from "./dialect.ts"

/**
 * A Kysely client for SQLite that uses the `node:sqlite` library.
 *
 * Generic over the schema: pass a concrete `Database` interface for compile-time table typing, or omit it for the empty
 * default. A path and native SQLite options are accepted directly:
 *
 * ```ts
 * using db = new DatabaseClient<MySchema>("db.sqlite", { readOnly: true })
 * ```
 *
 * An existing `DatabaseSync` handle or a full {@link SqliteDialectConfig} remains available when callers need raw
 * pragmas, shared ownership, or lazy connection creation. See `core/db/schema.ts`.
 */
export class DatabaseClient<DB = Database> extends Kysely<DB> implements Disposable {
	constructor(location: string, options?: DatabaseSyncOptions, config?: Partial<KyselyConfig>)
	constructor(database: DatabaseSync, config?: Partial<KyselyConfig>)
	constructor(dialectConfig: SqliteDialectConfig, config?: Partial<KyselyConfig>)
	constructor(
		source: string | DatabaseSync | SqliteDialectConfig,
		optionsOrConfig?: DatabaseSyncOptions | Partial<KyselyConfig>,
		config?: Partial<KyselyConfig>
	) {
		let dialectConfig: SqliteDialectConfig
		let kyselyConfig: Partial<KyselyConfig> | undefined

		if (typeof source === "string") {
			const options = optionsOrConfig as DatabaseSyncOptions | undefined
			// node:sqlite checks the argument count, not the value: `new DatabaseSync(path, undefined)` throws.
			const openArgs: [string, DatabaseSyncOptions?] = options ? [source, options] : [source]

			dialectConfig = { database: new DatabaseSync<DB>(...openArgs) }
			kyselyConfig = config
		} else {
			dialectConfig = "database" in source ? source : { database: source }
			kyselyConfig = optionsOrConfig as Partial<KyselyConfig> | undefined
		}

		super({
			...kyselyConfig,
			dialect: new SqliteDialect(dialectConfig),
		})
	}

	[Symbol.dispose](): void {
		this.destroy()
	}
}
