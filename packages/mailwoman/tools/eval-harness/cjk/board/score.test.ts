/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { formatBoardReport } from "#tools/eval-harness/cjk/board/report"
import { type BoardRow, scoreBoard, scoreRow } from "#tools/eval-harness/cjk/board/score"

const LABELS = ["O", "B-prefecture", "I-prefecture", "B-municipality", "I-municipality"]
const RESOLVE = ["prefecture", "municipality"] as const
const CENTROIDS = { "雲仙県|雲仙市": [130, 32] as const }

function row(raw: string, overrides: Partial<BoardRow> = {}): BoardRow {
	return {
		raw,
		span_starts: [0, 3],
		span_ends: [3, 6],
		span_tags: ["prefecture", "municipality"],
		register: "native",
		lon: 130,
		lat: 32,
		...overrides,
	}
}

const GOLD = [1, 2, 2, 3, 4, 4]

describe("the CJK board scorer", () => {
	it("accepts a predicted pair whose centroid is inside the radius", () => {
		const result = scoreRow(row("雲仙県雲仙市"), GOLD, CENTROIDS, { labels: LABELS, resolveTags: RESOLVE })

		expect(result).toMatchObject({ acceptable: true, unresolved: false, goldExact: false })
		expect(result.tagHits).toEqual(["prefecture", "municipality"])
	})

	it("reads a kana surface through the row's own kanji fields only as gold-exact", () => {
		const kana = row("雲仙県うんぜ", { pref: "雲仙県", muni: "雲仙市" })
		const result = scoreRow(kana, GOLD, CENTROIDS, { labels: LABELS, resolveTags: RESOLVE })

		expect(result).toMatchObject({ acceptable: false, unresolved: true, goldExact: true })
	})

	it("counts a predicted pair outside the radius as resolved and unacceptable", () => {
		const far = row("雲仙県雲仙市", { lon: 131 })
		const result = scoreRow(far, GOLD, CENTROIDS, { labels: LABELS, resolveTags: RESOLVE })

		expect(result).toMatchObject({ acceptable: false, unresolved: false })
	})

	it("prints fractions with Python's half-to-even rounding and pads names by code point", async () => {
		// 1 of 32 rows is 0.03125, a binary tie that `toFixed` rounds up and Python's `.4f` rounds to even.
		const rows = [row("雲仙県雲仙市"), ...Array.from({ length: 31 }, () => row("雲仙県雲仙市", { lon: 131 }))]
		const result = await scoreBoard(rows, () => GOLD, CENTROIDS, { labels: LABELS, resolveTags: RESOLVE })
		const report = formatBoardReport(result)

		expect(report).toContain("COORD-ACCEPTABILITY (<= 15 km): 0.0312  (1/32)")
		expect(report).toContain("    雲仙市          0.0312  (1/32)")
		expect(report).toContain("CHECK >= 0.70: FAIL")
	})
})
