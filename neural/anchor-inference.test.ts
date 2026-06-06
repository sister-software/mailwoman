/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Cross-language guard for the inference-side anchor features (#239/#240). The feature layout MUST
 *   match the Python training pipeline (`mailwoman_train/tokenizer.py::anchor_feature_vector`), or the
 *   model is fed garbage at inference. These vectors are pinned to values emitted by the Python
 *   function — if the TS drifts (locale order, centroid scale, renormalization), this fails.
 */
import { describe, expect, it } from "vitest"

import {
	ANCHOR_FEATURE_DIM,
	LOCALE_ORDER,
	anchorFeatureVector,
	buildAnchorFeatures,
	type AnchorLookup,
} from "./anchor-inference.js"
import type { TokenizedPiece } from "./tokenizer.js"

describe("anchorFeatureVector — pinned to Python anchor_feature_vector", () => {
	it("locale order matches Python LOCALE_COUNTRIES", () => {
		expect([...LOCALE_ORDER]).toEqual(["US", "FR", "DE", "CA", "GB", "JP", "ES", "IT", "NL"])
		expect(ANCHOR_FEATURE_DIM).toBe(11)
	})

	it("a DE+US collision (10115) byte-matches Python", () => {
		// python: anchor_feature_vector({"DE":0.5,"US":0.5}, 52.5323, 13.3846)
		const v = anchorFeatureVector({ DE: 0.5, US: 0.5 }, 52.5323, 13.3846)
		const expected = [0.5, 0, 0.5, 0, 0, 0, 0, 0, 0, 0.583692, 0.074359]
		expected.forEach((e, i) => expect(v[i]!).toBeCloseTo(e, 5))
	})

	it("a DE-only code byte-matches Python", () => {
		const v = anchorFeatureVector({ DE: 1.0 }, 49.4848, 8.4668)
		const expected = [0, 0, 1.0, 0, 0, 0, 0, 0, 0, 0.549831, 0.047038]
		expected.forEach((e, i) => expect(v[i]!).toBeCloseTo(e, 5))
	})

	it("renormalizes over the in-set mass (ignores out-of-set countries)", () => {
		const v = anchorFeatureVector({ DE: 0.5, ZZ: 0.5 }, 0, 0) // ZZ not in the locale set
		expect(v[LOCALE_ORDER.indexOf("DE")]!).toBeCloseTo(1.0, 6) // DE renormalized to full mass
	})
})

describe("buildAnchorFeatures — alignment onto SP pieces", () => {
	// "Strasse 12 10115 Berlin" — the postcode "10115" is chars [11, 16).
	const TEXT = "Strasse 12 10115 Berlin"
	const piece = (p: string, start: number, end: number): TokenizedPiece =>
		({ piece: p, id: 0, start, end }) as unknown as TokenizedPiece
	// pieces, with the postcode split across two (101 | 15)
	const PIECES = [
		piece("▁Strasse", 0, 7),
		piece("▁12", 8, 10),
		piece("▁101", 11, 14),
		piece("15", 14, 16),
		piece("▁Berlin", 17, 23),
	]
	const LOOKUP: AnchorLookup = new Map([["10115", { posterior: { DE: 0.5, US: 0.5 }, lat: 52.5323, lon: 13.3846 }]])

	it("lands confidence + features on exactly the postcode pieces", () => {
		const { features, confidence } = buildAnchorFeatures(TEXT, PIECES, LOOKUP)
		expect(confidence).toEqual([0, 0, 1, 1, 0])
		const de = anchorFeatureVector({ DE: 0.5, US: 0.5 }, 52.5323, 13.3846)
		expect(features[2]).toEqual(de)
		expect(features[3]).toEqual(de)
		expect(features[0]).toEqual(new Array(ANCHOR_FEATURE_DIM).fill(0))
		expect(features[4]).toEqual(new Array(ANCHOR_FEATURE_DIM).fill(0))
	})

	it("yields no anchor when the postcode isn't in the lookup", () => {
		const { confidence } = buildAnchorFeatures("Nowhere 99999 City", PIECES, LOOKUP)
		expect(confidence.every((c) => c === 0)).toBe(true)
	})
})
