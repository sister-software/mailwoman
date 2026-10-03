/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { gunzip } from "@mailwoman/core/fs/compression"
import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { resolvePath } from "path-ts"
import { describe, expect, test } from "vitest"

import { SEARCH_INDEX_FILENAME } from "../../src/search/constants.ts"
import { FIXTURE_RECORDS } from "../../src/search/fixtures.ts"
import type { SearchIndexDatabase } from "./schema.ts"
import { writeSearchIndex } from "./write-index.ts"

const STAMP = { commit: "abc1234", builtAt: "2026-10-03T00:00:00Z" }

describe("writeSearchIndex", () => {
	test("writes a gzip SQLite file with the records, the vocabulary and the build row", async () => {
		await using scratch = await temporaryDirectory("search-index-")
		const output = resolvePath(scratch.path, SEARCH_INDEX_FILENAME)
		const report = await writeSearchIndex(FIXTURE_RECORDS, output, STAMP)
		const bytes = await gunzip(await readLocalBuffer(output))
		const plainPath = resolvePath(scratch.path, "plain.db")

		expect(report.gzipBytes).toBeLessThan(report.bytes)
		expect(bytes.byteLength).toBe(report.bytes)

		await writeLocalFile(bytes, plainPath)

		using db = new DatabaseClient<SearchIndexDatabase>(plainPath, { readOnly: true })

		expect(db.prepare("SELECT count(*) AS n FROM records").get()).toEqual({ n: FIXTURE_RECORDS.length })

		expect(db.prepare(`SELECT count(*) AS n FROM records_fts WHERE records_fts MATCH '"viterbi"'`).get()).toEqual({
			n: 2,
		})

		expect(db.prepare("SELECT documents FROM terms WHERE term = 'viterbi'").get()).toEqual({ documents: 2 })

		expect(db.prepare(`SELECT count(*) AS n FROM terms_trigram WHERE terms_trigram MATCH '"ter"'`).get()).toEqual({
			n: 1,
		})

		expect(db.prepare("SELECT commit_sha, records FROM build").get()).toEqual({
			commit_sha: "abc1234",
			records: FIXTURE_RECORDS.length,
		})
	})

	test("throws on a duplicate record id", async () => {
		await using scratch = await temporaryDirectory("search-index-")
		const twice = [FIXTURE_RECORDS[0]!, FIXTURE_RECORDS[0]!]

		await expect(writeSearchIndex(twice, resolvePath(scratch.path, SEARCH_INDEX_FILENAME), STAMP)).rejects.toThrow(
			/duplicate record id/
		)
	})

	test("throws on zero records", async () => {
		await using scratch = await temporaryDirectory("search-index-")

		await expect(writeSearchIndex([], resolvePath(scratch.path, SEARCH_INDEX_FILENAME), STAMP)).rejects.toThrow(
			/zero records/
		)
	})
})
