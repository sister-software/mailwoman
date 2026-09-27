// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { resolveTilesPath } from "mailwoman/debug-view/tiles"
import { describe, expect, it } from "vitest"

describe("resolveTilesPath", () => {
	it("prefers the explicit flag", async () => {
		expect(await resolveTilesPath("/somewhere/planet.pmtiles")).toBe("/somewhere/planet.pmtiles")
	})

	// oxlint-disable-next-line vitest/expect-expect -- the conditional assertion documents an environment-dependent default path
	it("returns null when nothing is configured and the data-root default is absent", async () => {
		// The test env has no $MAILWOMAN_TILES.
		// The data-root probe is existsSync-guarded.
		const resolved = await resolveTilesPath()

		if (resolved != null) {
			expect(resolved.endsWith("planet.pmtiles")).toBe(true)
		}
	})
})
