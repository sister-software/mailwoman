/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The spec's acceptance list against the shipped `docs/build/search-index.db.gz`. The test throws in CI
 *   when the file is absent rather than passing on an empty index.
 */

import { gunzip } from "@mailwoman/core/fs/compression"
import { pathExists, readLocalBuffer } from "@mailwoman/core/fs/readers"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { repoRootPath } from "@mailwoman/core/paths"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { resolvePath } from "path-ts"
import { afterAll, beforeAll, describe, expect, test } from "vitest"

import type { SearchIndexDatabase } from "../../plugins/search-index/schema.ts"
import { SEARCH_INDEX_FILENAME } from "./constants.ts"
import { nodeSearchDatabase } from "./database.node.ts"
import type { SearchDatabase } from "./database.ts"
import { search } from "./search.ts"

const INDEX_FILE = repoRootPath("docs", "build", SEARCH_INDEX_FILENAME)
const WITHIN = 3
const MIN_RECORDS = 1000

const ACCEPTANCE: [query: string, url: string][] = [
	["locales and tiers", "/docs/developers/reference/locales-and-tiers"],
	["viterbi", "/docs/developers/knowledge-base/address-intelligence/decoding-and-viterbi"],
	["validate addresses", "/docs/developers/how-to/validate-addresses"],
	["mcp server", "/docs/developers/how-to/use-the-mcp-server"],
	["parse in the browser", "/docs/developers/tutorials/parse-in-the-browser"],
	["vitrebi", "/docs/developers/knowledge-base/address-intelligence/decoding-and-viterbi"],
]

// The acceptance suite needs a docs build.
// CI has one in the docs-build job and refuses its absence.
// A local checkout without a build skips and reports that.
const indexAbsent = !(await pathExists(INDEX_FILE))
// oxlint-disable-next-line sister-software/no-process-globals -- the runner's `CI` flag is not a project setting
const skipSuite = indexAbsent && !process.env.CI

let scratch: TemporaryDirectory | undefined
let client: DatabaseClient<SearchIndexDatabase> | undefined
let db: SearchDatabase

beforeAll(async () => {
	if (skipSuite) return

	if (indexAbsent) throw new Error(`${INDEX_FILE} is absent; run yarn workspace @mailwoman/docs build first`)

	scratch = await temporaryDirectory("search-acceptance-")
	const plainPath = resolvePath(scratch.path, "search-index.db")

	await writeLocalFile(await gunzip(await readLocalBuffer(INDEX_FILE)), plainPath)

	client = new DatabaseClient<SearchIndexDatabase>(plainPath, { readOnly: true })

	const { n } = client.prepare("SELECT count(*) AS n FROM records").get() as { n: number }
	const { records } = client.prepare("SELECT records FROM build").get() as { records: number }

	if (n <= MIN_RECORDS) throw new Error(`${INDEX_FILE} holds ${n} records; expected more than ${MIN_RECORDS}`)

	if (records !== n) throw new Error(`${INDEX_FILE} build row says ${records} records; the records table holds ${n}`)

	db = nodeSearchDatabase(client)
}, 120_000)

afterAll(async () => {
	client?.[Symbol.dispose]()
	await scratch?.[Symbol.asyncDispose]()
})

describe.skipIf(skipSuite)("the acceptance list", () => {
	test.each(ACCEPTANCE)(`returns the page for "%s" within the first ${WITHIN} hits`, async (query, url) => {
		const response = await search(db, query, WITHIN)

		expect(response.hits.map((hit) => hit.url)).toContain(url)
	})
})
