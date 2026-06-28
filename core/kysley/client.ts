/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Kysely, type KyselyConfig } from "kysely"

import type { Database } from "#db/schema"
import { SqliteDialect } from "#kysley/dialect"
import type { SqliteDialectConfig } from "#kysley/dialect-config"

/**
 * A Kysely client for SQLite that uses the `node:sqlite` library.
 *
 * Generic over the schema: pass a concrete `Database` interface (`new DatabaseClient<MySchema>(...)`) for compile-time
 * table typing, or omit it for the empty default. See `core/db/schema.ts`.
 */
export class DatabaseClient<DB = Database> extends Kysely<DB> implements Disposable {
	constructor(dialectConfig: SqliteDialectConfig, config?: Partial<KyselyConfig>) {
		super({
			...config,
			dialect: new SqliteDialect(dialectConfig),
		})
	}

	[Symbol.dispose](): void {
		this.destroy()
	}
}
