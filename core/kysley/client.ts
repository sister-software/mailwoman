// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

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
