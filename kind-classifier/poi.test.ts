/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { classifyKind, createKindClassifier } from "./index.ts"
import { matchPOISubject, type POIPhraseLookup } from "./poi.ts"
import type { LocaleHint } from "./types.ts"

/** Stub lexicon: knows `hospital` and the two-token `drinking fountain`. */
const LOOKUP: POIPhraseLookup = (phrase) => {
	const norm = phrase.trim().toLowerCase()

	if (norm === "hospital") {
		return [{ kind: "category", categoryID: "hospital", matchedPhrase: "hospital", confidence: 1.0 }]
	}

	if (norm === "drinking fountain") {
		return [{ kind: "category", categoryID: "drinking_water", matchedPhrase: "drinking fountain", confidence: 1.0 }]
	}

	if (norm === "walk in clinic") {
		return [{ kind: "category", categoryID: "clinic", matchedPhrase: "walk in clinic", confidence: 1.0 }]
	}

	if (norm === "chevron") {
		return [{ kind: "brand", categoryID: "Chevron", wikidata: "Q319642", matchedPhrase: "chevron", confidence: 1.0 }]
	}

	return []
}

const LOCALE: LocaleHint = { locale: "en-US", confidence: 1, alternatives: [], source: "caller" }

const input = (normalized: string) => ({ raw: normalized, normalized })
const shape = (segments?: string[]) => ({
	knownFormats: [],
	...(segments ? { segments: segments.map((body, index) => ({ body, index })) } : {}),
})

describe("matchPOISubject", () => {
	it("matches the whole input", () => {
		const m = matchPOISubject("hospital", "en-US", LOOKUP)
		expect(m?.match.categoryID).toBe("hospital")
		expect(m?.remainder).toBe("")
	})

	it("splits a subject prefix from a 'near' anchor", () => {
		const m = matchPOISubject("drinking fountain near Springfield IL", "en-US", LOOKUP)
		expect(m?.match.categoryID).toBe("drinking_water")
		expect(m?.subject).toBe("drinking fountain")
		expect(m?.remainder).toBe("Springfield IL")
	})

	it("splits on a comma separator", () => {
		const m = matchPOISubject("hospital, Portland OR", "en-US", LOOKUP)
		expect(m?.remainder).toBe("Portland OR")
	})

	it("returns null when nothing matches", () => {
		expect(matchPOISubject("Empire State Building", "en-US", LOOKUP)).toBeNull()
	})

	it("scans past separator words inside the subject phrase", () => {
		const m = matchPOISubject("walk in clinic near Boston MA", "en-US", LOOKUP)
		expect(m?.match.categoryID).toBe("clinic")
		expect(m?.subject).toBe("walk in clinic")
		expect(m?.remainder).toBe("Boston MA")
	})

	it("carries a brand hit's kind + wikidata through opaquely (mechanics don't special-case brand)", () => {
		const m = matchPOISubject("chevron near Houston TX", "en-US", LOOKUP)
		expect(m?.match).toEqual({
			kind: "brand",
			categoryID: "Chevron",
			wikidata: "Q319642",
			matchedPhrase: "chevron",
			confidence: 1.0,
		})
		expect(m?.remainder).toBe("Houston TX")
	})
})

describe("createKindClassifier with a poi lexicon", () => {
	const classify = createKindClassifier({ poiLexicon: LOOKUP })

	it("emits poi_query for a bare category phrase", async () => {
		const result = await classify(input("hospital"), shape(), LOCALE)
		expect(result.kind).toBe("poi_query")
		expect(result.confidence).toBeGreaterThanOrEqual(0.9)
	})

	it("emits poi_query for subject + anchor", async () => {
		const result = await classify(input("hospital near Springfield IL"), shape(), LOCALE)
		expect(result.kind).toBe("poi_query")
	})

	it("does NOT claim a venue-led full address (house-number remainder)", async () => {
		const result = await classify(
			input("hospital, 350 5th Ave, New York, NY 10118"),
			shape(["hospital", " 350 5th Ave", " New York", " NY 10118"]),
			LOCALE
		)
		expect(result.kind).not.toBe("poi_query")
	})

	it("keeps the base ranking when the lexicon misses", async () => {
		const withPOI = await classify(input("Empire State Building"), shape(), LOCALE)
		const base = await classifyKind(input("Empire State Building"), shape())
		expect(withPOI).toEqual(base)
	})

	it("does NOT claim a subject + anchor match when the shape has 4+ segments (segCount guard)", async () => {
		const result = await classify(input("hospital near Springfield"), shape(["a", "b", "c", "d"]), LOCALE)
		expect(result.kind).not.toBe("poi_query")
	})
})

describe("default classifyKind is untouched", () => {
	it("never emits poi_query", async () => {
		const result = await classifyKind(input("hospital"), shape())
		expect(result.kind).not.toBe("poi_query")
		expect(result.alternatives.map((a) => a.kind)).not.toContain("poi_query")
	})
})
