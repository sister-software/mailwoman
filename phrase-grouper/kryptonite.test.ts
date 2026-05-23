/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Kryptonite-catalogue fixture for the phrase grouper. Each fixture is one of the operator's
 *   adversarial examples — inputs where v0.4.0's joint boundary+type classification got the
 *   boundaries wrong and produced cascading classification errors.
 *
 *   The phrase grouper's job here is the easier half of the eventual joint decode: propose the right
 *   phrase boundaries WITH a structural kind hypothesis. Disambiguating which proposal wins when
 *   several overlap is Stage 5 reconcile's job (Thread D); this file asserts only that the grouper
 *   SURFACES the correct proposals at usable confidence ranges.
 *
 *   See `docs/articles/plan/phases/PHASE_8_v0_5_0_fresh_slate.md` § E for the v0.5.0 context. See
 *   `docs/articles/concepts/the-knowledge-ladder.md` for the design rationale.
 */

import { computeQueryShape } from "@mailwoman/query-shape"
import { describe, expect, it } from "vitest"
import { groupPhrasesSync } from "./group.js"
import type { NormalizedInputLite, PhraseKind, PhraseProposal } from "./types.js"

function input(text: string): NormalizedInputLite {
	return { raw: text, normalized: text }
}

interface Assertion {
	kind: PhraseKind
	body: string
	/** Confidence floor — the proposal's confidence must be ≥ this value. */
	minConfidence?: number
	/** Confidence ceiling — the proposal's confidence must be ≤ this value. */
	maxConfidence?: number
}

function expectProposal(proposals: PhraseProposal[], assertion: Assertion): PhraseProposal {
	const match = proposals.find((p) => p.kindHypothesis === assertion.kind && p.span.body === assertion.body)
	if (!match) {
		const dump = proposals.map((p) => `  ${p.kindHypothesis} "${p.span.body}" @ ${p.confidence.toFixed(2)}`).join("\n")
		throw new Error(`Expected proposal ${assertion.kind} "${assertion.body}" not found.\nProposals:\n${dump}`)
	}
	if (assertion.minConfidence !== undefined) {
		expect(match.confidence).toBeGreaterThanOrEqual(assertion.minConfidence)
	}
	if (assertion.maxConfidence !== undefined) {
		expect(match.confidence).toBeLessThanOrEqual(assertion.maxConfidence)
	}
	return match
}

describe("kryptonite catalogue — Buffalo Buffalo", () => {
	const text = "Buffalo Buffalo"
	const shape = computeQueryShape(text)
	const out = groupPhrasesSync(input(text), shape)

	it("surfaces both standalone LOCALITY_PHRASE proposals (token repetition is the cue)", () => {
		const buffaloProposals = out.filter((p) => p.kindHypothesis === "LOCALITY_PHRASE" && p.span.body === "Buffalo")
		expect(buffaloProposals.length).toBeGreaterThanOrEqual(2)
	})

	it("surfaces the combined LOCALITY_PHRASE", () => {
		expectProposal(out, { kind: "LOCALITY_PHRASE", body: "Buffalo Buffalo", minConfidence: 0.7 })
	})
})

describe("kryptonite catalogue — NY-NY Steakhouse, Houston, TX", () => {
	const text = "NY-NY Steakhouse, Houston, TX"
	const shape = computeQueryShape(text)
	const out = groupPhrasesSync(input(text), shape)

	it("surfaces NY-NY as HYPHENATED_COMPOUND", () => {
		expectProposal(out, { kind: "HYPHENATED_COMPOUND", body: "NY-NY", minConfidence: 0.8 })
	})

	it("surfaces NY-NY Steakhouse as VENUE_PHRASE (Steakhouse marker + hyphen compound)", () => {
		expectProposal(out, { kind: "VENUE_PHRASE", body: "NY-NY Steakhouse", minConfidence: 0.8 })
	})

	it("surfaces Houston as LOCALITY_PHRASE", () => {
		expectProposal(out, { kind: "LOCALITY_PHRASE", body: "Houston", minConfidence: 0.55 })
	})

	it("surfaces TX as REGION_ABBREVIATION (tail of last segment → high confidence)", () => {
		expectProposal(out, { kind: "REGION_ABBREVIATION", body: "TX", minConfidence: 0.8 })
	})
})

describe("kryptonite catalogue — Saint Petersburg, FL", () => {
	const text = "Saint Petersburg, FL"
	const shape = computeQueryShape(text)
	const out = groupPhrasesSync(input(text), shape)

	it("surfaces Saint Petersburg as a single LOCALITY_PHRASE", () => {
		expectProposal(out, { kind: "LOCALITY_PHRASE", body: "Saint Petersburg", minConfidence: 0.65 })
	})

	it("also surfaces Saint and Petersburg as standalone LOCALITY_PHRASE proposals", () => {
		expectProposal(out, { kind: "LOCALITY_PHRASE", body: "Saint" })
		expectProposal(out, { kind: "LOCALITY_PHRASE", body: "Petersburg" })
	})

	it("surfaces FL as REGION_ABBREVIATION", () => {
		expectProposal(out, { kind: "REGION_ABBREVIATION", body: "FL", minConfidence: 0.8 })
	})

	it("combined Saint Petersburg proposal wins by confidence over single-token alternatives", () => {
		const combined = out.find((p) => p.kindHypothesis === "LOCALITY_PHRASE" && p.span.body === "Saint Petersburg")!
		const saintAlone = out.find((p) => p.kindHypothesis === "LOCALITY_PHRASE" && p.span.body === "Saint")!
		expect(combined.confidence).toBeGreaterThan(saintAlone.confidence)
	})
})

describe("kryptonite catalogue — Paris, Texas", () => {
	const text = "Paris, Texas"
	const shape = computeQueryShape(text)
	const out = groupPhrasesSync(input(text), shape)

	it("surfaces Paris and Texas as separate LOCALITY_PHRASE proposals (comma-segmented)", () => {
		expectProposal(out, { kind: "LOCALITY_PHRASE", body: "Paris", minConfidence: 0.55 })
		expectProposal(out, { kind: "LOCALITY_PHRASE", body: "Texas", minConfidence: 0.65 })
	})

	it("Texas (tail of last segment) scores higher than Paris (tail of mid segment)", () => {
		const paris = out.find((p) => p.kindHypothesis === "LOCALITY_PHRASE" && p.span.body === "Paris")!
		const texas = out.find((p) => p.kindHypothesis === "LOCALITY_PHRASE" && p.span.body === "Texas")!
		expect(texas.confidence).toBeGreaterThan(paris.confidence)
	})

	it("does NOT propose Paris Texas as a single LOCALITY_PHRASE (comma boundary respected)", () => {
		const combined = out.find((p) => p.kindHypothesis === "LOCALITY_PHRASE" && p.span.body === "Paris Texas")
		expect(combined).toBeUndefined()
	})
})

describe("kryptonite catalogue — 350 5th Ave, New York, NY 10118 (canonical)", () => {
	const text = "350 5th Ave, New York, NY 10118"
	const shape = computeQueryShape(text)
	const out = groupPhrasesSync(input(text), shape)

	it("surfaces all canonical components", () => {
		expectProposal(out, { kind: "NUMERIC", body: "350", minConfidence: 0.9 })
		expectProposal(out, { kind: "STREET_PHRASE", body: "350 5th Ave", minConfidence: 0.85 })
		expectProposal(out, { kind: "LOCALITY_PHRASE", body: "New York", minConfidence: 0.65 })
		expectProposal(out, { kind: "REGION_ABBREVIATION", body: "NY", minConfidence: 0.7 })
		expectProposal(out, { kind: "POSTCODE", body: "10118", minConfidence: 0.5 })
	})

	it("the STREET_PHRASE includes the house number (350 5th Ave, not just 5th Ave)", () => {
		const streetPhrases = out.filter((p) => p.kindHypothesis === "STREET_PHRASE")
		const withNumber = streetPhrases.find((p) => p.span.body === "350 5th Ave")
		expect(withNumber).toBeDefined()
		expect(withNumber!.confidence).toBeGreaterThanOrEqual(0.85)
	})

	it("New York is a single LOCALITY_PHRASE proposal (not two separate)", () => {
		const newYork = out.find((p) => p.kindHypothesis === "LOCALITY_PHRASE" && p.span.body === "New York")
		expect(newYork).toBeDefined()
	})
})

describe("kryptonite catalogue — mid-position postcode (Paris 75008)", () => {
	const text = "Paris 75008"
	const shape = computeQueryShape(text)
	const out = groupPhrasesSync(input(text), shape)

	it("surfaces 75008 as POSTCODE (NOT just NUMERIC at boundary-loss)", () => {
		const postcode = out.find((p) => p.kindHypothesis === "POSTCODE" && p.span.body === "75008")
		expect(postcode).toBeDefined()
		expect(postcode!.confidence).toBeGreaterThanOrEqual(0.4)
	})

	it("surfaces Paris as LOCALITY_PHRASE", () => {
		expectProposal(out, { kind: "LOCALITY_PHRASE", body: "Paris", minConfidence: 0.55 })
	})

	it("75008 as NUMERIC is also surfaced (low confidence, leaves choice to reconciler)", () => {
		const numeric = out.find((p) => p.kindHypothesis === "NUMERIC" && p.span.body === "75008")
		expect(numeric).toBeDefined()
	})
})

describe("kryptonite catalogue — overall sanity", () => {
	it("every fixture above emits at least one proposal — no kryptonite silently produces []", () => {
		const fixtures = [
			"Buffalo Buffalo",
			"NY-NY Steakhouse, Houston, TX",
			"Saint Petersburg, FL",
			"Paris, Texas",
			"350 5th Ave, New York, NY 10118",
			"Paris 75008",
		]
		for (const f of fixtures) {
			const shape = computeQueryShape(f)
			const out = groupPhrasesSync(input(f), shape)
			expect(out.length).toBeGreaterThan(0)
		}
	})
})
