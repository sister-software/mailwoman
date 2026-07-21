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

/**
 * ANCHOR_SEPARATOR behaviour-preservation + ReDoS safety.
 *
 * The separator regex was linearized (`\s*,\s*|\s+(?:…)\s+` → `,\s*|\s(?:…)\s+`) to clear CodeQL's
 * `js/polynomial-redos` alert. `matchPOISubject` trims both the subject and the remainder, so surrounding whitespace on
 * the separator is redundant — the split behaviour must be byte-identical. These cases pin the split point, subject,
 * remainder, and match for every branch, anchor word, and whitespace shape. Values are the exact output of the
 * pre-linearization regex (each anchor word is flanked by whitespace on both sides, a comma splits regardless of
 * surrounding whitespace).
 */
describe("ANCHOR_SEPARATOR split behaviour (byte-identical across the linearization)", () => {
	// Fixed subject lexicon: hits only these short leading phrases. The WHOLE inputs below are longer (they carry the
	// place), so the whole-input path misses and the separator scan runs — surfacing the split point itself.
	const SUBJECTS = new Set(["cafe", "gas station", "hotel", "atm", "trails", "x"])
	const subjectLookup: POIPhraseLookup = (phrase) => {
		const t = phrase.trim().toLowerCase()

		return SUBJECTS.has(t) ? [{ kind: "category", categoryID: t, matchedPhrase: t, confidence: 1 }] : []
	}

	const cases: Array<{ text: string; subject: string; remainder: string }> = [
		// comma branch — whitespace variants around the comma all trim to the same split
		{ text: "cafe, Boston", subject: "cafe", remainder: "Boston" },
		{ text: "cafe ,Boston", subject: "cafe", remainder: "Boston" },
		{ text: "cafe , Boston", subject: "cafe", remainder: "Boston" },
		{ text: "cafe  ,  Boston", subject: "cafe", remainder: "Boston" },
		{ text: "cafe\t,\tBoston", subject: "cafe", remainder: "Boston" },
		{ text: "cafe,Boston", subject: "cafe", remainder: "Boston" },
		// each anchor word, single-space flanks
		{ text: "gas station near Ottawa", subject: "gas station", remainder: "Ottawa" },
		{ text: "hotel in Paris", subject: "hotel", remainder: "Paris" },
		{ text: "atm at JFK", subject: "atm", remainder: "JFK" },
		{ text: "trails around Denver", subject: "trails", remainder: "Denver" },
		// anchor word, multi-space + tab flanks (greedy trailing consumption preserved)
		{ text: "gas station   near   Ottawa", subject: "gas station", remainder: "Ottawa" },
		{ text: "hotel\tin\tParis", subject: "hotel", remainder: "Paris" },
		{ text: "atm  at  JFK", subject: "atm", remainder: "JFK" },
		// multi-separator: first split wins (subject "cafe"), remainder keeps the rest verbatim after trim
		{ text: "cafe, Boston, MA", subject: "cafe", remainder: "Boston, MA" },
		{ text: "cafe near town in Denver", subject: "cafe", remainder: "town in Denver" },
		// shared whitespace between comma and a following anchor: comma's trailing \s* consumes it,
		// so the anchor does NOT re-split — remainder carries "near y" intact
		{ text: "x,  near y", subject: "x", remainder: "near y" },
	]

	it.each(cases)("splits $text → subject=$subject remainder=$remainder", ({ text, subject, remainder }) => {
		const m = matchPOISubject(text, "en-US", subjectLookup)
		expect(m).not.toBeNull()
		expect(m!.subject).toBe(subject)
		expect(m!.remainder).toBe(remainder)
	})

	it("resolves the whole input when it hits, without scanning for a separator", () => {
		const m = matchPOISubject("cafe", "en-US", subjectLookup)
		expect(m).toEqual({
			match: { kind: "category", categoryID: "cafe", matchedPhrase: "cafe", confidence: 1 },
			subject: "cafe",
			remainder: "",
		})
	})

	it("returns null when nothing matches (no whole hit, no lexicon-hitting prefix)", () => {
		// Separators exist ("in"), but no split prefix hits the lexicon → null, exactly as the old regex.
		expect(matchPOISubject("Empire State Building", "en-US", subjectLookup)).toBeNull()
	})

	it("skips a leading separator (index === 0 guard) — no split before the first token", () => {
		// Leading comma: the sole separator is at index 0 and is skipped; the whole-input path already missed → null.
		expect(matchPOISubject(", Boston", "en-US", subjectLookup)).toBeNull()
	})

	it("substring anchor words without whitespace flanks do NOT split (identical to the old regex)", () => {
		// "maintain" contains "in" and "at"; "nearby" contains "near" — none are whitespace-flanked, so no split.
		expect(matchPOISubject("maintainnearby", "en-US", subjectLookup)).toBeNull()
	})
})

describe("ANCHOR_SEPARATOR is linear (ReDoS safety)", () => {
	// Never-hitting lexicon forces the full separator scan over the whole input on every call.
	const neverHits: POIPhraseLookup = () => []

	it("returns quickly on a long adversarial whitespace run (no polynomial backtracking)", () => {
		const pathological = "\t".repeat(100_000) + "x"
		const start = performance.now()
		const m = matchPOISubject(pathological, "en-US", neverHits)
		const elapsed = performance.now() - start
		expect(m).toBeNull()
		// The old O(n²) form took seconds on 1e5 chars; the linear form completes in single-digit ms. 100ms is a
		// generous ceiling that still fails loudly if quadratic backtracking returns.
		expect(elapsed).toBeLessThan(100)
	})

	it("returns quickly on a long whitespace run before a bare comma", () => {
		const pathological = "a" + " ".repeat(100_000) + ","
		const start = performance.now()
		const m = matchPOISubject(pathological, "en-US", neverHits)
		const elapsed = performance.now() - start
		expect(m).toBeNull()
		expect(elapsed).toBeLessThan(100)
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
