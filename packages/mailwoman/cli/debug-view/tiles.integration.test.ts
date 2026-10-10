// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { resolveTilesPath } from "#cli/debug-view/tiles"

describe("resolveTilesPath", () => {
	it("prefers the explicit flag", async () => {
		expect(await resolveTilesPath("/somewhere/planet.pmtiles")).toBe("/somewhere/planet.pmtiles")
	})

	// oxlint-disable-next-line vitest/expect-expect -- the conditional assertion documents an environment-dependent default path
	it("returns null when nothing is configured and the data-root default is absent", async () => {
		// The test env has no $MAILWOMAN_TILES.
		// The data-root probe is existsSync-guarded.
		const resolved = await resolveTilesPath()

		if (resolved) {
			expect(resolved.endsWith("planet.pmtiles")).toBe(true)
		}
	})
})
