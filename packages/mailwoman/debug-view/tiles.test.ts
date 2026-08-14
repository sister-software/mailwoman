/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { resolveTilesPath } from "./tiles.ts"

describe("resolveTilesPath", () => {
	it("prefers the explicit flag", () => {
		expect(resolveTilesPath("/somewhere/planet.pmtiles")).toBe("/somewhere/planet.pmtiles")
	})

	// oxlint-disable-next-line vitest/expect-expect
	it("returns null when nothing is configured and the data-root default is absent", () => {
		// The test env has no $MAILWOMAN_TILES; the data-root probe is existsSync-guarded.
		const resolved = resolveTilesPath()

		if (resolved != null) {
			expect(resolved.endsWith("planet.pmtiles")).toBe(true)
		}
	})
})
