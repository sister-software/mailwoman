/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * @file The behaviour half of the duplicate-avoidance pair: asking what a thing DOES rather than what it is called.
 *   The cases below are the questions a name search cannot answer, plus the two coverage defects the first index
 *   shipped with — a pathspec that dropped every file directly in `lib/`, and a cache key that could not see a staged
 *   or new file.
 */

import { repoRootPath } from "@mailwoman/core/paths"
import { firstSentence, loadPurposeIndex, searchPurpose } from "@mailwoman/dev-mcp/symbol/purpose"
import type { PurposeEntry } from "@mailwoman/dev-mcp/symbol/purpose"
import { beforeAll, describe, expect, it } from "vitest"

const REPO_ROOT = String(repoRootPath())

let entries: PurposeEntry[]

beforeAll(async () => {
	entries = await loadPurposeIndex(REPO_ROOT)
})

function namesFor(phrase: string, limit = 5): string[] {
	return searchPurpose(phrase, entries, limit).map((finding) => finding.name)
}

describe("firstSentence", () => {
	it("strips the comment furniture and stops at the first sentence", () => {
		const doc = "\n * Read and parse a manifest. A second sentence that should not appear.\n "

		expect(firstSentence(doc)).toBe("Read and parse a manifest.")
	})

	it("drops tag lines, so a `@param` block contributes nothing", () => {
		expect(firstSentence("\n * @param base The caller's URL.\n * @returns a path.\n ")).toBe("")
	})

	it("keeps a sentence that never ends in a period", () => {
		expect(firstSentence("\n * The arithmetic mean\n ")).toBe("The arithmetic mean")
	})
})

describe("the index over this repository", () => {
	it("covers a file sitting directly in a workspace lib/, not only a nested one", () => {
		const files = new Set(entries.map((entry) => entry.file))

		expect(files.has("packages/core/lib/stats.ts")).toBe(true)
		expect(files.has("packages/spatial/lib/distance.ts")).toBe(true)
		expect(files.has("packages/core/lib/module/resolve-from.ts")).toBe(true)
	})

	it("indexes exported declarations only, with the sentence that introduces each", () => {
		const percentile = entries.find((entry) => entry.name === "percentile")

		expect(percentile?.file).toBe("packages/core/lib/stats.ts")
		expect(percentile?.sentence).toContain("Nearest-rank percentile")
	})
})

describe("searchPurpose", () => {
	it("answers the question a name search could not: which function reads a manifest", () => {
		expect(namesFor("read a package.json manifest")).toContain("readPackageJSON")
	})

	it("ranks a declaration named by the query above one that merely shares its other words", () => {
		expect(namesFor("percentile of a list of numbers")[0]).toBe("percentile")
	})

	it("finds a distance helper from the behaviour rather than the spelling", () => {
		expect(namesFor("distance between two coordinates on Earth")).toContain("haversineKm")
	})

	it("says nothing for a phrase nothing in the tree describes", () => {
		expect(searchPurpose("tessellate a Voronoi diagram over Delaunay triangles", entries)).toEqual([])
	})

	it("refuses to match on a single shared sentence word", () => {
		const findings = searchPurpose("read", entries)

		expect(
			findings.every((finding) => finding.matched.length >= 2 || finding.name.toLowerCase().includes("read"))
		).toBe(true)
	})
})
