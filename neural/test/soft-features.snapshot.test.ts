/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Golden snapshot of the soft-feature choreography (#718). `buildSoftFeatures` is the single PURE
 *   home for the anchor + gazetteer feed that used to live inline in
 *   `NeuralAddressClassifier.#decode` — this pins the BYTE-STABLE extraction: known addresses →
 *   known feature tensors. If the choreography drifts (channel wiring, near-postcode suppression
 *   window), these fail.
 *
 *   Uses SMALL inline fixtures (2-3 entries), NOT the production lookup/lexicon — mirrors the style
 *   of `anchor-inference.test.ts` / `gazetteer-inference.test.ts`. The piece offsets are hand-built
 *   so the anchor/gazetteer land on exactly the expected pieces.
 */

import { describe, expect, it } from "vitest"

import { ANCHOR_FEATURE_DIM, anchorFeatureVector, type AnchorLookup } from "../anchor-inference.ts"
import { parseGazetteerLexicon } from "../gazetteer-inference.ts"
import { buildSoftFeatures } from "../soft-features.ts"
import type { TokenizedPiece } from "../tokenizer.ts"

const piece = (p: string, start: number, end: number): TokenizedPiece =>
	({ piece: p, id: 0, start, end }) as unknown as TokenizedPiece

// Small homograph-style lexicon (2 entries + 2 codes), mirroring the Python fixture's bit layout.
const BITS = { country: 1, region: 2, po_box: 4, cedex: 8, homograph: 16 }
const LEXICON = parseGazetteerLexicon({
	feature_dim: 5,
	slots: ["country", "region", "po_box", "cedex", "homograph"],
	bits: BITS,
	max_ngram: 3,
	entries: { georgia: BITS.country | BITS.region | BITS.homograph },
	code_entries: { CA: BITS.country | BITS.region | BITS.homograph, GA: BITS.region },
})
const ZERO_GAZ = [0, 0, 0, 0, 0]

describe("buildSoftFeatures — US postcode anchor hit", () => {
	// "100 Main St 30301" — the postcode "30301" is chars [12, 17).
	const TEXT = "100 Main St 30301"
	const PIECES = [
		piece("▁100", 0, 3),
		piece("▁Main", 4, 8),
		piece("▁St", 9, 11),
		piece("▁303", 12, 15),
		piece("01", 15, 17),
	]
	const LOOKUP: AnchorLookup = new Map([["30301", { posterior: { US: 1.0 }, lat: 33.749, lon: -84.388 }]])

	it("confidence 1.0 + the feature vector on exactly the postcode pieces; no gazetteer when unconfigured", () => {
		const soft = buildSoftFeatures(TEXT, PIECES, { postcodeAnchorLookup: LOOKUP })
		expect(soft.gazetteer).toBeUndefined()
		expect(soft.anchor).toBeDefined()
		expect(soft.anchor!.confidence).toEqual([0, 0, 0, 1, 1])
		const us = anchorFeatureVector({ US: 1.0 }, 33.749, -84.388)
		expect(soft.anchor!.features[3]).toEqual(us)
		expect(soft.anchor!.features[4]).toEqual(us)
		expect(soft.anchor!.features[0]).toEqual(new Array(ANCHOR_FEATURE_DIM).fill(0))
		// US is index 0 in LOCALE_ORDER; lat/90, lon/180 pinned.
		expect(us[0]).toBeCloseTo(1.0, 6)
		expect(us[ANCHOR_FEATURE_DIM - 2]).toBeCloseTo(33.749 / 90, 6)
		expect(us[ANCHOR_FEATURE_DIM - 1]).toBeCloseTo(-84.388 / 180, 6)
	})
})

describe("buildSoftFeatures — homograph gazetteer hit", () => {
	// "Atlanta Georgia" — "Georgia" is the homograph; chars [8, 15).
	const TEXT = "Atlanta Georgia"
	const PIECES = [piece("▁Atlanta", 0, 7), piece("▁Geo", 8, 11), piece("rgia", 11, 15)]

	it("paints the homograph clue on the Georgia pieces; no anchor when unconfigured", () => {
		const soft = buildSoftFeatures(TEXT, PIECES, { gazetteerLexicon: LEXICON })
		expect(soft.anchor).toBeUndefined()
		expect(soft.gazetteer).toBeDefined()
		const homo = [1, 1, 0, 0, 1] // country | region | homograph
		expect(soft.gazetteer!.features[0]).toEqual(ZERO_GAZ) // Atlanta — no clue
		expect(soft.gazetteer!.features[1]).toEqual(homo) // Geo
		expect(soft.gazetteer!.features[2]).toEqual(homo) // rgia
		expect(soft.gazetteer!.confidence).toEqual([0, 1, 1])
	})
})

describe("buildSoftFeatures — suppress gazetteer near postcode (choreography)", () => {
	// "GA 30301" — region code "GA" (chars [0,2)) sits one piece before the postcode "30301".
	// The gazetteer fires `region` on GA; the anchor fires on the postcode. With suppression ON the
	// GA clue is zeroed (it's within window=1 of the anchor hit) — the #464 v0.9.13 postcode fix.
	const TEXT = "GA 30301"
	const PIECES = [piece("▁GA", 0, 2), piece("▁303", 3, 6), piece("01", 6, 8)]
	const LOOKUP: AnchorLookup = new Map([["30301", { posterior: { US: 1.0 }, lat: 33.749, lon: -84.388 }]])

	it("WITHOUT suppression: the GA region clue fires", () => {
		const soft = buildSoftFeatures(TEXT, PIECES, { postcodeAnchorLookup: LOOKUP, gazetteerLexicon: LEXICON })
		expect(soft.anchor!.confidence).toEqual([0, 1, 1]) // postcode pieces
		expect(soft.gazetteer!.features[0]).toEqual([0, 1, 0, 0, 0]) // GA → region bit
		expect(soft.gazetteer!.confidence).toEqual([1, 0, 0])
	})

	it("WITH suppression: the GA clue adjacent to the anchor hit is zeroed", () => {
		const soft = buildSoftFeatures(TEXT, PIECES, {
			postcodeAnchorLookup: LOOKUP,
			gazetteerLexicon: LEXICON,
			suppressGazetteerNearPostcode: true,
		})
		// GA (piece 0) is within window=1 of the anchor hit at piece 1 → cleared.
		expect(soft.gazetteer!.features[0]).toEqual(ZERO_GAZ)
		expect(soft.gazetteer!.confidence[0]).toBe(0)
		// The anchor channel itself is untouched.
		expect(soft.anchor!.confidence).toEqual([0, 1, 1])
	})

	it("suppression is a no-op without an anchor channel (needs both)", () => {
		const soft = buildSoftFeatures(TEXT, PIECES, {
			gazetteerLexicon: LEXICON,
			suppressGazetteerNearPostcode: true,
		})
		expect(soft.anchor).toBeUndefined()
		expect(soft.gazetteer!.features[0]).toEqual([0, 1, 0, 0, 0]) // GA clue intact
	})
})
