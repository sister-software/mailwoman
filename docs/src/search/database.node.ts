/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Node-side `SearchDatabase` over the repository's SQLite client, for the tests. Imported by no browser
 *   module.
 */

import type { SearchRecord } from "@mailwoman/react/search/types"
import { DatabaseClient } from "@mailwoman/sqlite/client"

import { FILL_SQL, SCHEMA_SQL, type SearchIndexDatabase } from "../../plugins/search-index/schema.ts"
import { insertRecords } from "../../plugins/search-index/write-index.ts"
import type { SearchDatabase, SQLValue } from "./database.ts"

export function nodeSearchDatabase(db: Pick<DatabaseClient, "prepare">): SearchDatabase {
	return {
		async query<Row>(sql: string, parameters: readonly SQLValue[] = []): Promise<Row[]> {
			return db.prepare(sql).all(...parameters) as Row[]
		},
	}
}

/**
 * An in-memory index built from the records.
 * Its connection stays open for the process.
 */
export function fixtureDatabase(records: readonly SearchRecord[]): SearchDatabase {
	const db = new DatabaseClient<SearchIndexDatabase>(":memory:")

	db.exec(SCHEMA_SQL)
	insertRecords(db, records, { commit: "fixture", builtAt: "2026-10-03T00:00:00Z" })
	db.exec(FILL_SQL)

	return nodeSearchDatabase(db)
}
