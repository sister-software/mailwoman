/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { DATA_DIRECTORIES } from "#dev-mcp/data-directories"

describe("DATA_DIRECTORIES", () => {
	it("describes each directory once, under a relative path", () => {
		const paths = DATA_DIRECTORIES.map(({ path }) => path)

		expect(new Set(paths).size).toBe(paths.length)
		expect(paths.every((path) => !path.startsWith("/"))).toBe(true)
	})

	it("points a search for another country's Who's On First records at the full clones", () => {
		const subset = DATA_DIRECTORIES.find(({ path }) => path === "corpus/sources/wof/whosonfirst-data")

		expect(subset?.caution).toContain("src/wof-repos/whosonfirst-data")
	})
})
