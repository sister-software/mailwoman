// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { Database } from "#db/schema"
import { SqliteDialect } from "#kysley/dialect"
import type { SqliteDialectConfig } from "#kysley/dialect-config"
import { Kysely, type KyselyConfig } from "kysely"

/**
 * A Kysely client for SQLite that uses the `node:sqlite` library.
 */
export class DatabaseClient extends Kysely<Database> implements Disposable {
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
