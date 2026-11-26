// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file A source added at a high weight lowers every other source's draws, and the comparison reports each source
 *   whose draws fell past the bound, so a run like v8.11.0 (41 sources at 0.559 of their draws) can't pass unseen.
 */

import { describe, expect, it } from "vitest"

import { drawFalls, type SourceDraws } from "./report.ts"

const draws = (entries: Record<string, number>): SourceDraws[] =>
	Object.entries(entries).map(([source, count]) => ({ source, rows: 1_000_000, draws: count }))

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
})
