/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { countedPieces, decodeWithCardinalityFilter, repeatsSingletonTag } from "#cardinality-filter"
import { buildBIOEndMask, buildBIOStartMask, buildBIOTransitionMask } from "#viterbi"

const LABELS = ["O", "B-street", "I-street", "B-unit", "I-unit"]

const index = (label: string) => LABELS.indexOf(label)

const all = (n: number) => new Array<boolean>(n).fill(true)

describe("repeatsSingletonTag", () => {
	it("counts a span where the tag changes, and adjacent labels of one tag as one span", () => {
		expect(repeatsSingletonTag(["B-street", "I-street", "O"].map(index), LABELS, all(3))).toBe(false)
		expect(repeatsSingletonTag(["B-street", "B-street", "I-street"].map(index), LABELS, all(3))).toBe(false)
		expect(repeatsSingletonTag(["B-street", "O", "B-street"].map(index), LABELS, all(3))).toBe(true)
		expect(repeatsSingletonTag(["I-street", "O", "I-street"].map(index), LABELS, all(3))).toBe(true)
		expect(repeatsSingletonTag(["B-street", "B-unit", "B-street"].map(index), LABELS, all(3))).toBe(true)
	})

	it("lets a tag outside the singleton set repeat", () => {
		expect(repeatsSingletonTag(["B-unit", "O", "B-unit"].map(index), LABELS, all(3))).toBe(false)
	})

	it("reads one span across an uncounted piece", () => {
		// `Forbes Auto ▁ Electrical`: a whitespace piece decoded O between two venue words.
		const path = ["B-street", "I-street", "O", "B-street"].map(index)

		expect(repeatsSingletonTag(path, LABELS, [true, true, false, true])).toBe(false)
		expect(repeatsSingletonTag(path, LABELS, all(4))).toBe(true)
	})
})

describe("countedPieces", () => {
	it("leaves out whitespace and punctuation pieces", () => {
		const text = "Forbes Auto Electrical, 17"

		const pieces = [
			{ start: 0, end: 6 },
			{ start: 12, end: 12 },
			{ start: 12, end: 22 },
			{ start: 22, end: 23 },
			{ start: 24, end: 26 },
		]

		expect(countedPieces(text, pieces)).toEqual([true, false, true, false, true])
	})
})

describe("decodeWithCardinalityFilter", () => {
	const masks = {
		transitions: buildBIOTransitionMask(LABELS),
		startTransitions: buildBIOStartMask(LABELS),
		endTransitions: buildBIOEndMask(LABELS),
	}

	// The best path reads street · O · street.
	// The second-best path relabels the third token as a unit.
	const emissions = [
		[0, 5, 0, 0, 0],
		[5, 0, 0, 0, 0],
		[0, 5, 0, 4, 0],
	]

	it("takes the best path that opens one street", () => {
		const choice = decodeWithCardinalityFilter({ emissions, ...masks }, LABELS, all(3))

		expect(choice.result.path.map((i) => LABELS[i])).toEqual(["B-street", "O", "B-unit"])
		expect(choice.rank).toBeGreaterThan(0)
		expect(choice.fellBack).toBe(false)
	})

	it("keeps the best path when every path it reads repeats a singleton tag", () => {
		const choice = decodeWithCardinalityFilter({ emissions, ...masks }, LABELS, all(3), 1)

		expect(choice.result.path.map((i) => LABELS[i])).toEqual(["B-street", "O", "B-street"])
		expect(choice.rank).toBe(0)
		expect(choice.fellBack).toBe(true)
	})

	it("keeps the best path when its O piece is uncounted", () => {
		const choice = decodeWithCardinalityFilter({ emissions, ...masks }, LABELS, [true, false, true])

		expect(choice.rank).toBe(0)
		expect(choice.fellBack).toBe(false)
	})
})
