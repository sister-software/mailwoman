/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import {
	decidingStage,
	foldStreetLabels,
	goldPieceLabels,
	labelsMatchGold,
	ReplayStage,
} from "#tools/eval-harness/osm-suites/replay"

describe("the suite replay's stage attribution", () => {
	const raw = "Friggs gate 6"

	const pieces = [
		{ start: 0, end: 6 },
		{ start: 6, end: 7 },
		{ start: 7, end: 11 },
		{ start: 11, end: 13 },
	]

	it("compares by tag, so a word-initial B inside a span matches", () => {
		expect(
			labelsMatchGold(["B-street", "O", "B-street", "B-house_number"], ["B-street", null, "I-street", "B-house_number"])
		).toBe(true)

		expect(
			goldPieceLabels(
				"Rue, 6",
				[
					{ start: 0, end: 3 },
					{ start: 3, end: 4 },
					{ start: 4, end: 6 },
				],
				[{ tag: "street", start: 0, end: 3 }]
			)
		).toEqual(["B-street", null, "O"])
	})

	it("aligns gold spans to pieces by their trimmed text, leaving whitespace-only pieces ungraded", () => {
		const gold = goldPieceLabels(raw, pieces, [
			{ tag: "street", start: 0, end: 11 },
			{ tag: "house_number", start: 12, end: 13 },
		])

		expect(gold).toEqual(["B-street", null, "I-street", "B-house_number"])
	})

	it("reports no gold path when a piece straddles a span boundary", () => {
		expect(goldPieceLabels(raw, [{ start: 0, end: 13 }], [{ tag: "street", start: 0, end: 6 }])).toBeNull()
	})

	it("folds street affixes so a split street equals a whole one", () => {
		expect(foldStreetLabels(["B-street", "B-street_suffix", "B-house_number"])).toEqual([
			"B-street",
			"I-street",
			"B-house_number",
		])

		expect(
			labelsMatchGold(
				["B-street", "O", "B-street_suffix", "B-house_number"],
				["B-street", null, "I-street", "B-house_number"]
			)
		).toBe(true)

		expect(
			labelsMatchGold(["B-street", "O", "B-unit", "I-unit"], ["B-street", null, "I-street", "B-house_number"])
		).toBe(false)
	})

	it("attributes a row to the stage after its last matching sequence", () => {
		expect(decidingStage([false, false, false, false], false)).toBe(ReplayStage.Model)
		expect(decidingStage([true, false, false, false], false)).toBe(ReplayStage.Prior)
		expect(decidingStage([false, false, true, false], false)).toBe(ReplayStage.Repair)
		expect(decidingStage([true, true, true, true], false)).toBe(ReplayStage.TreeOrGrade)
		expect(decidingStage([true, true, true, true], true)).toBe(ReplayStage.None)
	})
})
