import type { PhraseProposal } from "@mailwoman/core/pipeline"
import { Span } from "@mailwoman/core/tokenization"
import { computeQueryShape } from "@mailwoman/query-shape"
import { observeC4Boundaries, summarizeC4FeatureVectors } from "mailwoman/eval-harness/grammar-census-c4"
import { describe, expect, it } from "vitest"

/* oxlint-disable sister-software/multiline-statement-padding -- receipt fixtures keep setup beside their assertion */

const pieces = [
	{ piece: "▁Unter", start: 0, end: 5 },
	{ piece: "▁den", start: 6, end: 9 },
	{ piece: "▁Linden", start: 10, end: 16 },
]

const spans = [
	{ tag: "street", start: 0, end: 1 },
	{ tag: "locality", start: 1, end: 3 },
]

describe("observeC4Boundaries", () => {
	it("records overlapping phrase proposals without calling them a violation", () => {
		const proposals: PhraseProposal[] = [
			{ span: new Span("Unter den Linden", 0), kindHypothesis: "STREET_PHRASE", confidence: 0.81 },
			{ span: new Span("den Linden", 6), kindHypothesis: "LOCALITY_PHRASE", confidence: 0.62 },
		]
		const [boundary] = observeC4Boundaries(spans, pieces, proposals, computeQueryShape("Unter den Linden"), [], [])

		expect(boundary).not.toHaveProperty("violation")
		expect(boundary!.insidePhraseProposals).toEqual([{ kind: "STREET_PHRASE", confidence: 0.81, start: 0, end: 16 }])
	})

	it("records each authoritative edge family and keeps unavailable distinct from absent", () => {
		const shape = computeQueryShape("Paris, 75004")
		const localPieces = [
			{ piece: "▁Paris", start: 0, end: 5 },
			{ piece: "▁75004", start: 7, end: 12 },
		]
		const localSpans = [
			{ tag: "locality", start: 0, end: 1 },
			{ tag: "postcode", start: 1, end: 2 },
		]
		const registry = [
			{
				startPiece: 0,
				endPiece: 1,
				startWord: 0,
				endWord: 1,
				entries: [{ wofID: 1, placetype: "locality", referential: 0.9 }],
			},
		]
		const [available] = observeC4Boundaries(localSpans, localPieces, [], shape, registry, [])
		const [unavailable] = observeC4Boundaries(localSpans, localPieces, [], shape)

		expect(available!.delimiterSegmentEdges).toEqual([{ separator: "comma", leftSegmentEnd: 5, rightSegmentStart: 7 }])
		expect(available!.characterClassChange).toEqual({ from: "alpha", to: "digit" })
		expect(available!.knownFormatEdges).toEqual([
			expect.objectContaining({ format: "us_zip", edge: "start" }),
			expect.objectContaining({ format: "fr_postcode", edge: "start" }),
			expect.objectContaining({ format: "de_postcode", edge: "start" }),
		])
		expect(available!.registryFSTEdges).toEqual([expect.objectContaining({ edge: "end" })])
		expect(available!.streetAffixEdges).toEqual([])
		expect(unavailable!.registryFSTEdges).toBeNull()
		expect(unavailable!.streetAffixEdges).toBeNull()
	})
})

describe("summarizeC4FeatureVectors", () => {
	it("aggregates exact feature vectors by partial-truth grade without confidence thresholds", () => {
		const proposal: PhraseProposal = {
			span: new Span("Unter den Linden", 0),
			kindHypothesis: "STREET_PHRASE",
			confidence: 0.01,
		}
		const [boundary] = observeC4Boundaries(spans, pieces, [proposal], computeQueryShape("Unter den Linden"), [], [])
		const summary = summarizeC4FeatureVectors([
			{
				...boundary!,
				rowID: "de-one",
				input: "Unter den Linden",
				truthPosition: "inside_expected_component",
			},
			{ ...boundary!, rowID: "de-two", input: "Unter den Linden 2", truthPosition: "unclassified" },
		])

		expect(summary).toEqual([
			expect.objectContaining({ total: 2, insideExpectedComponent: 1, expectedComponentEdge: 0, unclassified: 1 }),
		])
		expect(summary[0]!.featureVector).toContain("phrase=STREET_PHRASE")
		expect(summary[0]!.examples).toEqual([
			{ rowID: "de-one", input: "Unter den Linden" },
			{ rowID: "de-two", input: "Unter den Linden 2" },
		])
	})
})
