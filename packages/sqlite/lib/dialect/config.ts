// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { DatabaseSync } from "node:sqlite"

import type { DatabaseConnection } from "kysely"

/**
 * Config for the SQLite dialect.
 */
export interface SqliteDialectConfig {
	/**
	 * A node:sqlite DatabaseSync instance or a function that returns one.
	 *
	 * If a function is provided, it's called once when the first query is executed.
	 *
	 * https://nodejs.org/api/sqlite.html#class-databasesync
	 */
	database: DatabaseSync | (() => Promise<DatabaseSync>)

	/**
	 * Called once when the first query is executed.
	 *
	 * This is a Kysely specific feature and doesn't come from the `node:sqlite` module.
	 */
	onCreateConnection?: (connection: DatabaseConnection) => Promise<void>
}
