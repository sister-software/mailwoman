// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file A source added at a high weight lowers every other source's draws, and the comparison reports each source
 *   whose draws fell past the bound, so a run like v8.11.0 (41 sources at 0.559 of their draws) can't pass unseen.
 */

import { describe, expect, it } from "vitest"

import { drawFalls, expectedCountryDraws, type SourceDraws } from "./report.ts"

const draws = (entries: Record<string, number>, factors: Record<string, number> = {}): SourceDraws[] =>
	Object.entries(entries).map(([source, count]) => ({
		source,
		rows: 1_000_000,
		draws: count,
		emitFactor: factors[source] ?? 1,
	}))

describe("drawFalls", () => {
	it("reports each source whose draws fell past the bound, the largest fall first", () => {
		const previous = draws({ nad: 38_421, ban: 126_790, "wof-admin": 576_318 })
		const current = draws({ nad: 21_460, ban: 70_819, "wof-admin": 576_318, "overture-places-in": 3_680_899 })

		const falls = drawFalls(previous, current, 0.05)

		expect(falls.map(({ source }) => source)).toEqual(["nad", "ban"])
		expect(falls[0]!.fall).toBeCloseTo(1 - 21_460 / 38_421, 6)
	})

	it("reads a source the current run no longer draws as a fall of 1", () => {
		expect(drawFalls(draws({ gone: 100 }), draws({}), 0.05)).toEqual([
			{ source: "gone", previous: 100, current: 0, fall: 1 },
		])
	})

	it("leaves a fall within the bound unreported", () => {
		expect(drawFalls(draws({ nad: 100 }), draws({ nad: 96 }), 0.05)).toEqual([])
	})

	it("compares emitted rows under the current run's factors on both sides", () => {
		// usgs-structures emits 1.43 rows per draw.
		// Its 231,284 draws at the old weights emitted 331,000 rows, more than its target. 161,601
		// draws under the factor emit the 231,284 the target asks for, a real fall of 30%.
		const previous = draws({ "usgov-usgs-structures": 231_284 })
		const current = draws({ "usgov-usgs-structures": 231_284 / 1.4312 }, { "usgov-usgs-structures": 1.4312 })
		const [fall] = drawFalls(previous, current, 0.05)

		expect(fall!.previous).toBeCloseTo(231_284 * 1.4312, 3)
		expect(fall!.current).toBeCloseTo(231_284, 3)
		expect(fall!.fall).toBeCloseTo(1 - 1 / 1.4312, 6)
	})
})

describe("expectedCountryDraws", () => {
	it("shares a source's draws over its countries by rows times admission, and never draws a zero-weight country", () => {
		const rows = [
			{ source: "wof", country: "US", rows: 300 },
			{ source: "wof", country: "FR", rows: 100 },
			{ source: "wof", country: "XX", rows: 600 },
		]

		// FR is admitted at half US's chance, so the 1,000 draws split 300 : 50 between US and FR.
		const out = expectedCountryDraws(draws({ wof: 1000 }), rows, { US: 1, FR: 0.5, XX: 0 })

		expect(out.map(({ country, draws: drawn }) => [country, Math.round(drawn)])).toEqual([
			["US", 857],
			["FR", 143],
			["XX", 0],
		])
	})
})
