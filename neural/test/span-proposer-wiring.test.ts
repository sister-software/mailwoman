/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Contract tests for the Stage 2.7 consumption wiring: the codex-backed lexicon builder and the
 *   span-proposal emission priors. Load-bearing properties: the lexicon derives strictly from codex
 *   tables (no invented designators, no bare "MS" in the scan); the priors are soft additive biases
 *   with B-/I- structure; annotation O-bias respects its confidence floor; QUOTED_SPAN contributes
 *   no bias at all.
 */

import { describe, expect, it } from "vitest"

import { proposeSpans, type ProposedSpan } from "@mailwoman/core/pipeline"
import { buildSpanProposalPriors } from "../span-proposal-prior.js"
import { buildCodexSpanLexicon } from "../span-proposer-lexicon.js"

const LABELS = ["O", "B-unit", "I-unit", "B-po_box", "I-po_box", "B-house_number", "I-house_number"] as const

describe("buildCodexSpanLexicon", () => {
	const lexicon = buildCodexSpanLexicon()

	it("carries the USPS Pub-28 C2 unit designators", () => {
		for (const d of ["apt", "apartment", "ste", "suite", "unit", "rm"]) {
			expect(lexicon.unitDesignators.has(d), d).toBe(true)
		}
		expect(lexicon.levelDesignators.has("fl")).toBe(true)
		expect(lexicon.levelDesignators.has("floor")).toBe(true)
		expect(lexicon.weakDesignators.has("building")).toBe(true)
	})

	it("scan regex matches the Commonwealth + USPS delivery-service surfaces", () => {
		const re = lexicon.deliveryService!
		for (const s of ["PO Box 19", "P.O. Box 19", "GPO Box 2890", "Private Bag 39990", "Locked Bag 1797", "CMB B99"]) {
			re.lastIndex = 0
			expect(re.test(s), s).toBe(true)
		}
	})

	it("never matches the AU 'MS' honorific trap or numberless types", () => {
		const re = lexicon.deliveryService!
		for (const s of ["Ms Smith", "Counter Delivery", "Poste Restante"]) {
			re.lastIndex = 0
			expect(re.test(s), s).toBe(false)
		}
	})

	it("locale conditioning: a us-only lexicon proposes no AU bare-leading split", () => {
		const usOnly = buildCodexSpanLexicon(["us"])
		const spans = proposeSpans("3/45 Wattle St, Ultimo NSW 2007", usOnly)
		expect(spans.some((s) => s.kind === "SPLIT_UNIT")).toBe(false)
		const full = proposeSpans("3/45 Wattle St, Ultimo NSW 2007", buildCodexSpanLexicon())
		expect(full.some((s) => s.kind === "SPLIT_UNIT")).toBe(true)
	})
})

describe("buildSpanProposalPriors", () => {
	// Three fake pieces: [0,4) [5,7) [8,10)
	const pieces = [
		{ start: 0, end: 4 },
		{ start: 5, end: 7 },
		{ start: 8, end: 10 },
	]

	it("biases B- on the first covered piece and I- on the rest (unit phrase)", () => {
		const proposals: ProposedSpan[] = [
			{ start: 0, end: 7, kind: "UNIT_PHRASE", confidence: 0.85, source: "designator:unit" },
		]
		const m = buildSpanProposalPriors(proposals, pieces, LABELS)
		expect(m[0]![1]).toBeCloseTo(0.85 * 5.0) // B-unit on piece 0
		expect(m[1]![2]).toBeCloseTo(0.85 * 5.0) // I-unit on piece 1
		expect(m[2]!.every((v) => v === 0)).toBe(true) // piece 2 untouched
		expect(m[0]![0]).toBe(0) // no O bias
	})

	it("applies the annotation O-bias only above the confidence floor", () => {
		const low: ProposedSpan[] = [{ start: 0, end: 10, kind: "ANNOTATION_SPAN", confidence: 0.45, source: "paired:()" }]
		expect(
			buildSpanProposalPriors(low, pieces, LABELS)
				.flat()
				.every((v) => v === 0)
		).toBe(true)
		const high: ProposedSpan[] = [{ start: 0, end: 7, kind: "ANNOTATION_SPAN", confidence: 0.9, source: "paired:()" }]
		const m = buildSpanProposalPriors(high, pieces, LABELS)
		expect(m[0]![0]).toBeCloseTo(0.9 * 12.0)
		expect(m[1]![0]).toBeCloseTo(0.9 * 12.0)
		expect(m[2]![0]).toBe(0)
	})

	it("QUOTED_SPAN contributes no bias (typing the name is the classifier's job)", () => {
		const proposals: ProposedSpan[] = [
			{ start: 0, end: 10, kind: "QUOTED_SPAN", confidence: 0.8, source: "paired:quote" },
		]
		expect(
			buildSpanProposalPriors(proposals, pieces, LABELS)
				.flat()
				.every((v) => v === 0)
		).toBe(true)
	})

	it("dual-path alternatives bias their own spans — both readings stay alive", () => {
		// "Unit 4/22": SPLIT_UNIT [0,6) + SPLIT_HOUSE_NUMBER [7,9) + FUSED [5,9) at lower conf.
		const proposals: ProposedSpan[] = [
			{ start: 0, end: 6, kind: "SPLIT_UNIT", confidence: 0.85, alternativeGroup: 0, source: "slash" },
			{ start: 7, end: 9, kind: "SPLIT_HOUSE_NUMBER", confidence: 0.85, alternativeGroup: 0, source: "slash" },
			{ start: 5, end: 9, kind: "FUSED_NUMBER", confidence: 0.3, alternativeGroup: 0, source: "slash" },
		]
		const m = buildSpanProposalPriors(proposals, pieces, LABELS)
		expect(m[0]![1]).toBeCloseTo(0.85 * 5.0) // B-unit on "Unit"
		expect(m[1]![2]).toBeCloseTo(0.85 * 5.0) // I-unit on "4"
		expect(m[1]![5]).toBeCloseTo(0.3 * 5.0) // fused B-house_number ALSO alive on "4", weaker
		expect(m[2]![5]).toBeCloseTo(0.85 * 5.0) // split B-house_number on "22" (max over fused I-)
	})

	it("returns all-zeros for no proposals", () => {
		expect(
			buildSpanProposalPriors([], pieces, LABELS)
				.flat()
				.every((v) => v === 0)
		).toBe(true)
	})
})
