/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { calendarDateUTC, plusDays } from "#dates"

describe("calendar dates", () => {
	it("reads a unix second as a UTC calendar date", () => {
		expect(calendarDateUTC(1_790_000_000)).toBe("2026-09-21")
		expect(calendarDateUTC(Date.UTC(2026, 11, 31, 23, 59, 59) / 1000)).toBe("2026-12-31")
	})

	it("adds days across a month end, a year end, and February 29", () => {
		expect(plusDays("2026-10-31", 14)).toBe("2026-11-14")
		expect(plusDays("2026-12-25", 14)).toBe("2027-01-08")
		expect(plusDays("2028-02-20", 14)).toBe("2028-03-05")
		expect(plusDays("2027-02-20", 14)).toBe("2027-03-06")
	})
})
