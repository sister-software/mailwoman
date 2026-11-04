// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The corpus street index: every street name a premise register publishes, by country and locality.
 */

import { sql, type Kysely } from "kysely"

/**
 * One street name in one locality of one country.
 */
export interface StreetNameTable {
	/**
	 * The upper-case ISO 3166-1 alpha-2 country.
	 */
	country: string
	/**
	 * The street line folded by `foldStreetSurface` from `@mailwoman/resolver`,
	 * the fold the reader applies to a probe.
	 */
	name_key: string
	/**
	 * The locality folded the same way, or the empty string for a row without a locality.
	 */
	locality_key: string
}

/**
 * The street-index database schema.
 */
export interface StreetIndexDatabase {
	street_name: StreetNameTable
}

/**
 * The `street_name` columns in insert order.
 */
export const STREET_NAME_COLUMNS = ["country", "name_key", "locality_key"] as const

/**
 * Creates the `street_name` table, keyed by country, name and locality, before the bulk load.
 *
 * The rows are short and probed by key, so the table is clustered on its key.
 */
export async function createStreetNameTable(db: Kysely<StreetIndexDatabase>): Promise<void> {
	await db.schema
		.createTable("street_name")
		.addColumn("country", "text", (c) => c.notNull())
		.addColumn("name_key", "text", (c) => c.notNull())
		.addColumn("locality_key", "text", (c) => c.notNull())
		.addPrimaryKeyConstraint("street_name_pk", ["country", "name_key", "locality_key"])
		.modifyEnd(sql`without rowid`)
		.execute()
}
