/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `post_office_source` table of `post-offices.db`: one row per contributing source.
 *
 *   Each POI row's `gers_id` reads `<source_id>:<record id>`, so a row joins to its source's
 *   country, terms and provenance class here.
 */

import type { Kysely } from "kysely"

/**
 * One contributing source.
 */
export interface PostOfficeSourceTable {
	source_id: string
	country: string
	publisher: string
	/**
	 * `postal-operator` or `mapping-agency`.
	 */
	provenance: string
	license: string
	attribution: string
	register_source: string
	vintage: string
	/**
	 * Records the source's input held.
	 */
	input_records: number
	/**
	 * Of those, records with no point.
	 * The layer leaves them out.
	 */
	records_without_point: number
}

export interface PostOfficeSourceDatabase {
	post_office_source: PostOfficeSourceTable
}

export async function createPostOfficeSourceTable<DB extends PostOfficeSourceDatabase>(db: Kysely<DB>): Promise<void> {
	await db.schema
		.createTable("post_office_source")
		.addColumn("source_id", "text", (c) => c.primaryKey())
		.addColumn("country", "text", (c) => c.notNull())
		.addColumn("publisher", "text", (c) => c.notNull())
		.addColumn("provenance", "text", (c) => c.notNull())
		.addColumn("license", "text", (c) => c.notNull())
		.addColumn("attribution", "text", (c) => c.notNull())
		.addColumn("register_source", "text", (c) => c.notNull())
		.addColumn("vintage", "text", (c) => c.notNull())
		.addColumn("input_records", "integer", (c) => c.notNull())
		.addColumn("records_without_point", "integer", (c) => c.notNull())
		.execute()
}
