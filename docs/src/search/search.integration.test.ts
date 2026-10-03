/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The spec's acceptance list against an index built from the real `docs/build`. The test throws when
 *   the build directory is absent rather than passing on an empty index.
 */

import { readdir } from "node:fs/promises"

import { pathExists, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { repoRootPath } from "@mailwoman/core/paths"
import { resolvePath } from "path-ts"
import { beforeAll, describe, expect, test } from "vitest"

import { extractRecords } from "../../plugins/search-index/extract.ts"
import { fixtureDatabase } from "./database.node.ts"
import type { SearchDatabase } from "./database.ts"
import { search } from "./search.ts"

const BUILD_DIR = repoRootPath("docs", "build")
const WITHIN = 3

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
// A local checkout without a build skips and says so.
const buildAbsent = !(await pathExists(BUILD_DIR))
// oxlint-disable-next-line sister-software/no-process-globals -- the runner's `CI` flag is not a project setting
const skipSuite = buildAbsent && !process.env.CI

let db: SearchDatabase

beforeAll(async () => {
	if (skipSuite) return

	if (buildAbsent) throw new Error(`${BUILD_DIR} is absent; run yarn workspace @mailwoman/docs build first`)

	const records = []
	const entries = await readdir(BUILD_DIR.toString(), { recursive: true })
	const htmlEntries = entries.filter((name) => name.endsWith(".html")).toSorted()

	for (const entry of htmlEntries) {
		const route = `/${entry}`.replace(/\/index\.html$/, "").replace(/\.html$/, "")

		if (route === "/404") continue

		records.push(...extractRecords(await readLocalTextFile(resolvePath(BUILD_DIR, entry)), route === "" ? "/" : route))
	}

	if (records.length <= 1000)
		throw new Error(
			`${BUILD_DIR} yielded ${records.length} records from ${htmlEntries.length} HTML files; expected more than 1000`
		)

	db = fixtureDatabase(records)
}, 120_000)

describe.skipIf(skipSuite)("the acceptance list", () => {
	test.each(ACCEPTANCE)(`returns the page for "%s" within the first ${WITHIN} hits`, async (query, url) => {
		const response = await search(db, query, WITHIN)

		expect(response.hits.map((hit) => hit.url)).toContain(url)
	})
})
