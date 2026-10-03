/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Writes the search records to a gzip-compressed SQLite file. The whole file is republished with every
 *   site deploy, so the writer builds from scratch in a temporary file and compresses the result.
 */

import { gzipSync } from "@mailwoman/core/fs/compression"
import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import type { SearchRecord } from "@mailwoman/react/search/types"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { type PathBuilderLike, resolvePath } from "path-ts"

import { FILL_SQL, SCHEMA_SQL, type SearchIndexDatabase } from "./schema.ts"

/**
 * The index is read whole into memory in the browser, so the page size is tuned for
 * in-memory b-tree depth rather than for range requests.
 */
const PAGE_SIZE = 4096

export interface BuildStamp {
	commit: string
	builtAt: string
}

export function headingsText(record: Pick<SearchRecord, "hierarchy">): string {
	return record.hierarchy.filter((entry): entry is string => entry !== null).join("\n")
}

/**
 * Inserts the rows into a database that already holds the schema.
 *
 * A `DatabaseClient` or a bare `node:sqlite` connection both satisfy the parameter.
 */
export function insertRecords(
	db: Pick<DatabaseClient, "exec" | "prepare">,
	records: readonly SearchRecord[],
	build: BuildStamp
): void {
	const insert = db.prepare("INSERT INTO records VALUES (?, ?, ?, ?, ?, ?, ?, ?)")

	db.exec("BEGIN")

	for (const record of records) {
		insert.run(
			record.id,
			record.url,
			record.anchor,
			stringifyJSON(record.hierarchy),
			headingsText(record),
			record.content,
			record.level,
			record.position
		)
	}

	db.prepare("INSERT INTO build VALUES (?, ?, ?)").run(build.commit, build.builtAt, records.length)
	db.exec("COMMIT")
}

export async function writeSearchIndex(
	records: readonly SearchRecord[],
	output: PathBuilderLike,
	build: BuildStamp
): Promise<{ bytes: number; gzipBytes: number }> {
	if (!records.length) throw new Error("search-index: the build produced zero records")

	const seen = new Map<string, string>()

	for (const record of records) {
		const earlier = seen.get(record.id)

		if (earlier) throw new Error(`search-index: duplicate record id ${record.id} on ${record.url} and ${earlier}`)

		seen.set(record.id, record.url)
	}

	await using scratch = await temporaryDirectory("search-index-")
	const plain = resolvePath(scratch.path, "search-index.db")

	{
		using db = new DatabaseClient<SearchIndexDatabase>(plain)

		db.exec(`PRAGMA page_size = ${PAGE_SIZE};`)
		db.exec(SCHEMA_SQL)
		insertRecords(db, records, build)
		db.exec(FILL_SQL)
		db.exec("VACUUM")
	}

	const bytes = await readLocalBuffer(plain)
	const compressed = gzipSync(bytes, { level: 9 })

	await writeLocalFile(compressed, output)

	return { bytes: bytes.byteLength, gzipBytes: compressed.byteLength }
}
