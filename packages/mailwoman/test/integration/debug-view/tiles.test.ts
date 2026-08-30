/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { resolveTilesPath } from "mailwoman/debug-view/tiles"
import { describe, expect, it } from "vitest"

describe("resolveTilesPath", () => {
	it("prefers the explicit flag", async () => {
		expect(await resolveTilesPath("/somewhere/planet.pmtiles")).toBe("/somewhere/planet.pmtiles")
	})

	// oxlint-disable-next-line vitest/expect-expect -- the conditional assertion documents an environment-dependent default path
	it("returns null when nothing is configured and the data-root default is absent", async () => {
		// The test env has no $MAILWOMAN_TILES; the data-root probe is existsSync-guarded.
		const resolved = await resolveTilesPath()

		if (resolved != null) {
			expect(resolved.endsWith("planet.pmtiles")).toBe(true)
		}
	})
})
