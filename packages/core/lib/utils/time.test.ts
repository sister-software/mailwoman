// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { createPhaseClock, isoDate, isoSeconds, isoSecondsUTC } from "#utils"

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
})

describe("createPhaseClock", () => {
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
