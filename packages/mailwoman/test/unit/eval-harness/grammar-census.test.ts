import {
	completeSpanRegistryReceipt,
	detectC6Violations,
	gradeBoundaryTruth,
	locateUniqueComponentTruth,
	spansFromBIO,
	summarizeC6,
} from "mailwoman/eval-harness/grammar-census"
import { describe, expect, it } from "vitest"

describe("detectC6Violations", () => {
	it("reports a nested country match at a boundary covered by a locality match", () => {
		const matches = [
			{
				startPiece: 0,
				endPiece: 3,
				startWord: 0,
				endWord: 3,
				entries: [{ wofID: 1, placetype: "locality", referential: 0.7 }],
			},
			{
				startPiece: 2,
				endPiece: 3,
				startWord: 2,
				endWord: 3,
				entries: [{ wofID: 2, placetype: "country", referential: 0.9 }],
			},
		]

		const spans = [
			{ tag: "locality", start: 0, end: 2 },
			{ tag: "country", start: 2, end: 3 },
		]

		expect(detectC6Violations(spans, matches)).toEqual([
			expect.objectContaining({ boundary: 2, nestedSide: "right", covering: matches[0], nested: matches[1] }),
		])
	})

	it("does not report a covering match without a tag-aligned nested match", () => {
		const matches = [
			{
				startPiece: 0,
				endPiece: 2,
				startWord: 0,
				endWord: 2,
				entries: [{ wofID: 1, placetype: "locality", referential: 0.7 }],
			},
		]

		expect(
			detectC6Violations(
				[
					{ tag: "locality", start: 0, end: 1 },
					{ tag: "region", start: 1, end: 2 },
				],
				matches
			)
		).toEqual([])
	})
})

describe("partial boundary truth", () => {
	it("grades a split inside a uniquely located expected component as a true positive", () => {
		const truth = locateUniqueComponentTruth("Port of Spain", { locality: "Port of Spain" })
		expect(gradeBoundaryTruth(8, truth)).toBe("true_positive")
	})

	it("grades an expected component edge as a false positive", () => {
		const truth = locateUniqueComponentTruth("Paris, France", { locality: "Paris", country: "France" })
		expect(gradeBoundaryTruth(5, truth)).toBe("false_positive")
	})

	it("leaves repeated and absent component truth unclassified", () => {
		const truth = locateUniqueComponentTruth("St Mary's, St Mary's", { venue: "St Mary's", locality: "Shrewsbury" })
		expect(truth).toEqual([])
		expect(gradeBoundaryTruth(10, truth)).toBe("unclassified")
	})
})

describe("C6 census aggregation", () => {
	it("reports the board and artifact denominators separately", () => {
		const violation = {
			boundary: 1,
			boundaryCharacter: 5,
			grade: "true_positive" as const,
			left: { tag: "locality", start: 0, end: 1 },
			right: { tag: "country", start: 1, end: 2 },
			covering: { startPiece: 0, endPiece: 2, startWord: 0, endWord: 2, entries: [] },
			nested: { startPiece: 1, endPiece: 2, startWord: 1, endWord: 2, entries: [] },
			nestedSide: "right" as const,
			nestedEntries: [],
			coveringReferential: 0.7,
			nestedReferential: 0.9,
			referentialDelta: -0.2,
		}

		expect(
			summarizeC6([
				{ id: "a", input: "A B", fstAvailable: true, violations: [violation] },
				{ id: "b", input: "C", fstAvailable: false, violations: [] },
			])
		).toEqual({
			rows: 2,
			rowsWithFST: 1,
			rowsFlagged: 1,
			boundariesFlagged: 1,
			truePositive: 1,
			falsePositive: 0,
			unclassified: 0,
		})
	})

	it("turns final BIO labels into piece-coordinate spans", () => {
		const tokens = [
			{ piece: "▁Port", start: 0, end: 4, label: "B-locality", confidence: 0.8 },
			{ piece: "▁of", start: 5, end: 7, label: "I-locality", confidence: 0.7 },
			{ piece: "▁Spain", start: 8, end: 13, label: "B-country", confidence: 0.9 },
		] as const

		expect(spansFromBIO(tokens)).toEqual([
			{ tag: "locality", start: 0, end: 2 },
			{ tag: "country", start: 2, end: 3 },
		])
	})

	it("keeps absent complete-span evidence separate from a measured zero", () => {
		const receipt = completeSpanRegistryReceipt(
			[
				{
					startPiece: 2,
					endPiece: 3,
					startWord: 2,
					endWord: 3,
					entries: [{ wofID: 2, placetype: "country", referential: 0 }],
				},
			],
			3
		)

		expect(receipt).toMatchObject({
			bestCoveringReferential: null,
			bestNestedReferential: 0,
			referentialDelta: null,
		})
	})

	it("reports complete-span referential minus the best nested score", () => {
		const receipt = completeSpanRegistryReceipt(
			[
				{
					startPiece: 0,
					endPiece: 3,
					startWord: 0,
					endWord: 3,
					entries: [{ wofID: 1, placetype: "locality", referential: 0.7 }],
				},
				{
					startPiece: 2,
					endPiece: 3,
					startWord: 2,
					endWord: 3,
					entries: [{ wofID: 2, placetype: "country", referential: 0.9 }],
				},
			],
			3
		)

		expect(receipt).toMatchObject({
			bestCoveringReferential: 0.7,
			bestNestedReferential: 0.9,
		})

		expect(receipt.referentialDelta).toBeCloseTo(-0.2)
	})
})
