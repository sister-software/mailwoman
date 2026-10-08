/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Golden snapshot of the soft-feature choreography: known addresses produce known feature tensors.
 *   A drift in the channel wiring or the near-postcode suppression window makes these fail.
 *
 *   The file uses small inline fixtures with 2–3 entries instead of the production lookup and lexicon.
 *   Hand-built piece offsets place the anchor and gazetteer on the expected pieces.
 */

import { describe, expect, it } from "vitest"

import { ANCHOR_FEATURE_DIM, anchorFeatureVector, type AnchorLookup } from "#anchor-inference"
import { parseGazetteerLexicon } from "#gazetteer-inference"
import { buildSoftFeatures } from "#soft-features"
import type { TokenizedPiece } from "#tokenizer"

const piece = (p: string, start: number, end: number): TokenizedPiece => ({ piece: p, id: 0, start, end })

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
	// "100 Main St 30301", where the postcode "30301" is chars [12, 17).
	const TEXT = "100 Main St 30301"

	const PIECES = [
		piece("▁100", 0, 3),
		piece("▁Main", 4, 8),
		piece("▁St", 9, 11),
		piece("▁303", 12, 15),
		piece("01", 15, 17),
	]

	const LOOKUP: AnchorLookup = new Map([["30301", { posterior: { US: 1 }, lat: 33.749, lon: -84.388 }]])

	it("confidence 1.0 + the feature vector on exactly the postcode pieces; no gazetteer when unconfigured", () => {
		const soft = buildSoftFeatures(TEXT, PIECES, {
			postcodeAnchorLookup: LOOKUP,
			suppressGazetteerNearPostcode: "off",
		})

		expect(soft.gazetteer).toBeNull()
		expect(soft.anchor).toBeDefined()
		expect(soft.anchor!.confidence).toEqual([0, 0, 0, 1, 1])
		const us = anchorFeatureVector({ US: 1 }, 33.749, -84.388)
		expect(soft.anchor!.features[3]).toEqual(us)
		expect(soft.anchor!.features[4]).toEqual(us)
		expect(soft.anchor!.features[0]).toEqual(new Array(ANCHOR_FEATURE_DIM).fill(0))
		// US is index 0 in LOCALE_ORDER. lat/90, lon/180 pinned.
		expect(us[0]).toBeCloseTo(1, 6)
		expect(us[ANCHOR_FEATURE_DIM - 2]).toBeCloseTo(33.749 / 90, 6)
		expect(us[ANCHOR_FEATURE_DIM - 1]).toBeCloseTo(-84.388 / 180, 6)
	})
})

describe("buildSoftFeatures — homograph gazetteer hit", () => {
	// "Atlanta Georgia", where "Georgia" is the homograph at chars [8, 15).
	const TEXT = "Atlanta Georgia"
	const PIECES = [piece("▁Atlanta", 0, 7), piece("▁Geo", 8, 11), piece("rgia", 11, 15)]

	it("paints the homograph clue on the Georgia pieces; no anchor when unconfigured", () => {
		const soft = buildSoftFeatures(TEXT, PIECES, {
			gazetteerLexicon: LEXICON,
			suppressGazetteerNearPostcode: "off",
		})

		expect(soft.anchor).toBeNull()
		expect(soft.gazetteer).toBeDefined()
		const homo = [1, 1, 0, 0, 1] // country | region | homograph
		expect(soft.gazetteer!.features[0]).toEqual(ZERO_GAZ)
		expect(soft.gazetteer!.features[1]).toEqual(homo)
		expect(soft.gazetteer!.features[2]).toEqual(homo)
		expect(soft.gazetteer!.confidence).toEqual([0, 1, 1])
	})
})

describe("buildSoftFeatures — suppress gazetteer near postcode (choreography)", () => {
	// The region code "GA" sits one piece before the postcode, so suppression clears its clue.
	const TEXT = "GA 30301"
	const PIECES = [piece("▁GA", 0, 2), piece("▁303", 3, 6), piece("01", 6, 8)]
	const LOOKUP: AnchorLookup = new Map([["30301", { posterior: { US: 1 }, lat: 33.749, lon: -84.388 }]])

	it("WITHOUT suppression: the GA region clue fires", () => {
		const soft = buildSoftFeatures(TEXT, PIECES, {
			postcodeAnchorLookup: LOOKUP,
			gazetteerLexicon: LEXICON,
			suppressGazetteerNearPostcode: "off",
		})

		expect(soft.anchor!.confidence).toEqual([0, 1, 1])
		expect(soft.gazetteer!.features[0]).toEqual([0, 1, 0, 0, 0])
		expect(soft.gazetteer!.confidence).toEqual([1, 0, 0])
	})

	it("WITH suppression: the GA clue adjacent to the anchor hit is zeroed", () => {
		const soft = buildSoftFeatures(TEXT, PIECES, {
			postcodeAnchorLookup: LOOKUP,
			gazetteerLexicon: LEXICON,
			suppressGazetteerNearPostcode: "on",
		})

		expect(soft.gazetteer!.features[0]).toEqual(ZERO_GAZ)
		expect(soft.gazetteer!.confidence[0]).toBe(0)
		expect(soft.anchor!.confidence).toEqual([0, 1, 1])
	})

	it("suppression is a no-op without an anchor channel (needs both)", () => {
		const soft = buildSoftFeatures(TEXT, PIECES, {
			gazetteerLexicon: LEXICON,
			suppressGazetteerNearPostcode: "on",
		})

		expect(soft.anchor).toBeNull()
		expect(soft.gazetteer!.features[0]).toEqual([0, 1, 0, 0, 0])
	})
})
