// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { buildFSTEmissionPriors, findFSTAcceptedMatches } from "@mailwoman/neural/prior/fst"
import { describe, expect, it } from "vitest"

import { buildFixtureFST } from "#test-kit/fst-fixture"
import {
	completeSpanRegistryReceipt,
	detectC6Violations,
	fstVotes,
	maximumVote,
	gradeBoundaryTruth,
	locateUniqueComponentTruth,
	spansFromBIO,
	summarizeC6,
} from "#tools/eval-harness/grammar/census"

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
				{
					id: "a",
					input: "A B",
					fstAvailable: true,
					violations: [violation],
					completeSpanRegistry: null,
					sourceGazetteer: null,
				},
				{ id: "b", input: "C", fstAvailable: false, violations: [], completeSpanRegistry: null, sourceGazetteer: null },
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

describe("fstVotes", () => {
	it("attributes the same per-tag maximum the FST emission prior applies", () => {
		const fst = buildFixtureFST([
			{ wofID: 1, placetype: "locality", name: "Springfield", referential: 0.6, parentChain: [] },
			{ wofID: 2, placetype: "neighbourhood", name: "Springfield", referential: 0.9, parentChain: [] },
			{ wofID: 3, placetype: "neighbourhood", name: "Springfield Road", referential: 0.95, parentChain: [] },
			{ wofID: 4, placetype: "region", name: "Oak", referential: 0.5, parentChain: [] },
			// One WOF id under two surfaces votes only at the first match that reaches it.
			{ wofID: 5, placetype: "locality", name: "Oak", referential: 0.2, parentChain: [] },
			{ wofID: 5, placetype: "locality", name: "Oak Springfield", referential: 0.2, parentChain: [] },
		])

		const words = ["▁Oak", "▁Spring", "field", "▁Road"]
		let offset = 0

		const pieces = words.map((piece) => {
			const start = offset
			offset += piece.length

			return { piece, start, end: offset }
		})

		const labels = ["O", "B-locality", "I-locality", "B-region", "I-region", "B-street", "I-street"]
		const matrix = buildFSTEmissionPriors(fst, pieces, labels)
		const votes = fstVotes(findFSTAcceptedMatches(fst, pieces), pieces)

		expect(votes.filter((vote) => vote.entry.wofID === 5)).toHaveLength(1)
		expect(votes.some((vote) => vote.entry.wofID === 3)).toBe(false)

		for (const [piece] of pieces.entries()) {
			for (const tag of ["locality", "region"]) {
				const { vote } = maximumVote(votes, tag, piece, piece + 1)

				const applied = Math.max(
					matrix[piece]![labels.indexOf(`B-${tag}`)]!,
					matrix[piece]![labels.indexOf(`I-${tag}`)]!
				)

				expect(applied).toBeCloseTo(vote ? vote.entry.referential * 3 : 0)
			}
		}
	})
})
