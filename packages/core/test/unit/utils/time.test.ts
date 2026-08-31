/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { isoDate, isoSecondsUTC } from "@mailwoman/core/utils"
import { describe, expect, it } from "vitest"

describe("time", () => {
	const instant = new Date("2026-08-31T13:45:12.345Z")

	it("isoDate answers the UTC calendar date", () => {
		expect(isoDate(instant)).toBe("2026-08-31")
	})

	it("isoSecondsUTC truncates to seconds with an explicit offset", () => {
		expect(isoSecondsUTC(instant)).toBe("2026-08-31T13:45:12+00:00")
	})

	it("both default to the current clock", () => {
		expect(isoDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
		expect(isoSecondsUTC()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/)
	})
})
