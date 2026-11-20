// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { createPhaseClock, isoDate, isoSeconds, isoSecondsUTC, isRFC3339DateTime } from "#utils"

describe("time", () => {
	const instant = new Date("2026-08-31T13:45:12.345Z")

	it("isoDate answers the UTC calendar date", () => {
		expect(isoDate(instant)).toBe("2026-08-31")
	})

	it("isoSecondsUTC truncates to seconds with an explicit offset", () => {
		expect(isoSecondsUTC(instant)).toBe("2026-08-31T13:45:12+00:00")
	})

	it("isoSeconds truncates to seconds with the Z suffix", () => {
		expect(isoSeconds(instant)).toBe("2026-08-31T13:45:12Z")
	})

	it("both default to the current clock", () => {
		expect(isoDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
		expect(isoSecondsUTC()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/)
	})

	it.each([isoDate, isoSeconds, isoSecondsUTC])("%s rejects extended UTC years", (format) => {
		expect(() => format(new Date("+010000-01-01T00:00:00Z"))).toThrow(RangeError)
		expect(() => format(new Date("-000001-12-31T23:59:59Z"))).toThrow(RangeError)
	})
})

describe("isRFC3339DateTime", () => {
	it.each(["1990-12-31T23:59:60Z", "1990-12-31T15:59:60-08:00", "2017-01-01t05:29:60.125+05:30"])(
		"accepts a leap second at %s",
		(value) => {
			expect(isRFC3339DateTime(value)).toBe(true)
		}
	)

	it.each(["2026-08-31T12:34:60Z", "2016-12-31T23:58:60Z", "2017-01-01T23:59:60Z", "2016-12-31T23:59:60+01:00"])(
		"rejects an unannounced leap second at %s",
		(value) => {
			expect(isRFC3339DateTime(value)).toBe(false)
		}
	)
})

describe("createPhaseClock", () => {
	it("uses the same clock reading to end one phase and start the next", () => {
		let ms = -1000
		const clock = createPhaseClock(() => (ms += 1000))

		clock.mark("ingest")
		clock.mark("verify")

		expect(clock.finish()).toEqual([
			{ phase: "ingest", seconds: 1 },
			{ phase: "verify", seconds: 1 },
		])

		expect(ms).toBe(2000)
	})

	it("times each phase once across its progress lines, and adds a phase's later run to its first", () => {
		let ms = 0
		const clock = createPhaseClock(() => ms)

		clock.mark("ingest-wof")
		ms = 1000
		clock.mark("ingest-wof")
		ms = 3000
		clock.mark("fold-overture")
		ms = 3500
		clock.mark("verify")
		ms = 4000
		clock.mark("fold-overture")
		ms = 4200

		expect(clock.finish()).toEqual([
			{ phase: "ingest-wof", seconds: 3 },
			{ phase: "fold-overture", seconds: 0.7 },
			{ phase: "verify", seconds: 0.5 },
		])
	})
})
