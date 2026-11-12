// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { DATA_DIRECTORIES } from "#dev-mcp/data-directories"

describe("DATA_DIRECTORIES", () => {
	it("describes each directory once, under a relative path", () => {
		const paths = DATA_DIRECTORIES.map(({ path }) => path)

		expect(new Set(paths).size).toBe(paths.length)
		expect(paths.every((path) => !path.startsWith("/"))).toBe(true)
	})

	it("points every Who's On First search at the one repositories root", () => {
		const wof = DATA_DIRECTORIES.filter(({ holds }) => holds.includes("Who's On First"))

		expect(wof.map(({ path, root }) => [root, path])).toEqual([["cache", "sources/wof-repos"]])
	})
})
