/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { LocaleHint } from "@mailwoman/core/pipeline"
import { classifyKind, createKindClassifier } from "@mailwoman/kind-classifier"
import { matchPOISubject, type POIPhraseLookup } from "@mailwoman/kind-classifier/poi"
import { describe, expect, it } from "vitest"

/**
 * Test lexicon with single- and multi-token entries.
 */
const LOOKUP: POIPhraseLookup = (phrase) => {
	const norm = phrase.trim().toLowerCase()

	if (norm === "hospital") {
		return [{ kind: "category", categoryID: "hospital", matchedPhrase: "hospital", confidence: 1 }]
	}

	if (norm === "drinking fountain") {
		return [{ kind: "category", categoryID: "drinking_water", matchedPhrase: "drinking fountain", confidence: 1 }]
	}

	if (norm === "walk in clinic") {
		return [{ kind: "category", categoryID: "clinic", matchedPhrase: "walk in clinic", confidence: 1 }]
	}

	if (norm === "places of worship") {
		return [{ kind: "category", categoryID: "place_of_worship", matchedPhrase: norm, confidence: 1 }]
	}

	if (norm === "chevron") {
		return [{ kind: "brand", categoryID: "Chevron", wikidata: "Q319642", matchedPhrase: "chevron", confidence: 1 }]
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
		expect(m?.relation).toBe("near")
		expect(m?.subjectSpan).toEqual({ text: "drinking fountain", start: 0, end: 17 })
		expect(m?.relationSpan).toEqual({ text: "near", start: 18, end: 22 })
		expect(m?.anchorSpan).toEqual({ text: "Springfield IL", start: 23, end: 37 })
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

	it("preserves internal prepositions in both a known subject and an unknown anchor", () => {
		const m = matchPOISubject("places of worship in Stratford-upon-Avon", "en-GB", LOOKUP)

		expect(m).toMatchObject({
			subject: "places of worship",
			relation: "in",
			remainder: "Stratford-upon-Avon",
		})

		expect(m?.subjectSpan.text).toBe("places of worship")
		expect(m?.anchorSpan?.text).toBe("Stratford-upon-Avon")
	})

	it("carries a brand hit's kind + wikidata through opaquely (mechanics don't special-case brand)", () => {
		const m = matchPOISubject("chevron near Houston TX", "en-US", LOOKUP)

		expect(m?.match).toEqual({
			kind: "brand",
			categoryID: "Chevron",
			wikidata: "Q319642",
			matchedPhrase: "chevron",
			confidence: 1,
		})

		expect(m?.remainder).toBe("Houston TX")
	})
})

/**
 * Distinguish ordered preference results from unordered affordance sets.
 */
describe("a lookup returning several hits", () => {
	const preferenceList: POIPhraseLookup = (phrase) =>
		phrase.trim().toLowerCase() === "credit union"
			? [
					{ kind: "category", categoryID: "credit_union", matchedPhrase: "credit union", confidence: 1 },
					{ kind: "category", categoryID: "bank", matchedPhrase: "credit union", confidence: 1 },
				]
			: []

	const affordedSet: POIPhraseLookup = (phrase) =>
		phrase.trim().toLowerCase() === "prescription"
			? [
					{
						kind: "category",
						categoryID: "drugstore",
						matchedPhrase: "prescription",
						confidence: 1,
						searchAsSet: true,
					},
					{
						kind: "category",
						categoryID: "pharmacy",
						matchedPhrase: "prescription",
						confidence: 1,
						searchAsSet: true,
					},
				]
			: []

	it("keeps the first hit alone when the hits are a preference list", () => {
		const m = matchPOISubject("credit union near Boston MA", "en-US", preferenceList)

		expect(m?.matches.map((hit) => hit.categoryID)).toEqual(["credit_union"])
		expect(m?.match.categoryID).toBe("credit_union")
	})

	it("carries every hit when they are one afforded set", () => {
		const m = matchPOISubject("prescription near Denver CO", "en-US", affordedSet)

		expect(m?.matches.map((hit) => hit.categoryID)).toEqual(["drugstore", "pharmacy"])
		expect(m?.remainder).toBe("Denver CO")
	})

	it("carries the set on a whole-input hit too, not only after an anchor split", () => {
		const m = matchPOISubject("prescription", "en-US", affordedSet)

		expect(m?.matches.map((hit) => hit.categoryID)).toEqual(["drugstore", "pharmacy"])
		expect(m?.remainder).toBe("")
	})

	// `match` is the head of `matches`, so scoring and set handling use the same subject.
	it("scores under the head of the set", () => {
		const m = matchPOISubject("prescription near Denver CO", "en-US", affordedSet)

		expect(m?.match).toBe(m?.matches[0])
	})
})

/**
 * Verify anchor-separator behavior after regex linearization, including whitespace and comma variants.
 */
describe("ANCHOR_SEPARATOR split behaviour (byte-identical across the linearization)", () => {
	// Match only short leading phrases so tests exercise separator splitting.
	const SUBJECTS = new Set(["cafe", "gas station", "hotel", "atm", "trails", "x"])

	const subjectLookup: POIPhraseLookup = (phrase) => {
		const t = phrase.trim().toLowerCase()

		return SUBJECTS.has(t) ? [{ kind: "category", categoryID: t, matchedPhrase: t, confidence: 1 }] : []
	}

	const cases: Array<{ text: string; subject: string; remainder: string }> = [
		// Comma splits are invariant to surrounding whitespace.
		{ text: "cafe, Boston", subject: "cafe", remainder: "Boston" },
		{ text: "cafe ,Boston", subject: "cafe", remainder: "Boston" },
		{ text: "cafe , Boston", subject: "cafe", remainder: "Boston" },
		{ text: "cafe  ,  Boston", subject: "cafe", remainder: "Boston" },
		{ text: "cafe\t,\tBoston", subject: "cafe", remainder: "Boston" },
		{ text: "cafe,Boston", subject: "cafe", remainder: "Boston" },
		// Anchor words with single spaces.
		{ text: "gas station near Ottawa", subject: "gas station", remainder: "Ottawa" },
		{ text: "hotel in Paris", subject: "hotel", remainder: "Paris" },
		{ text: "atm at JFK", subject: "atm", remainder: "JFK" },
		{ text: "trails around Denver", subject: "trails", remainder: "Denver" },
		// Anchor words with repeated spaces or tabs.
		{ text: "gas station   near   Ottawa", subject: "gas station", remainder: "Ottawa" },
		{ text: "hotel\tin\tParis", subject: "hotel", remainder: "Paris" },
		{ text: "atm  at  JFK", subject: "atm", remainder: "JFK" },
		// The first separator wins; the remainder keeps later separators.
		{ text: "cafe, Boston, MA", subject: "cafe", remainder: "Boston, MA" },
		{ text: "cafe near town in Denver", subject: "cafe", remainder: "town in Denver" },
		// Comma consumes the shared whitespace, preserving `near y` in the remainder.
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

		const hit = { kind: "category", categoryID: "cafe", matchedPhrase: "cafe", confidence: 1 }

		expect(m).toEqual({
			match: hit,
			matches: [hit],
			subject: "cafe",
			subjectSpan: { text: "cafe", start: 0, end: 4 },
			remainder: "",
		})
	})

	it("returns null when nothing matches (no whole hit, no lexicon-hitting prefix)", () => {
		// No separator prefix matches the lexicon.
		expect(matchPOISubject("Empire State Building", "en-US", subjectLookup)).toBeNull()
	})

	it("skips a leading separator (index === 0 guard) — no split before the first token", () => {
		// Ignore a leading separator.
		expect(matchPOISubject(", Boston", "en-US", subjectLookup)).toBeNull()
	})

	it("substring anchor words without whitespace flanks do NOT split (identical to the old regex)", () => {
		// Embedded anchor words without whitespace boundaries do not split.
		expect(matchPOISubject("maintainnearby", "en-US", subjectLookup)).toBeNull()
	})
})

describe("span-first adversarial place names", () => {
	const categoryLookup: POIPhraseLookup = (phrase) => {
		const subject = phrase.trim().toLowerCase()
		const known = new Set(["restaurants", "hotels", "trains", "flights", "pharmacies", "churches", "places of worship"])

		return known.has(subject) ? [{ kind: "category", categoryID: subject, matchedPhrase: subject, confidence: 1 }] : []
	}

	const cases = [
		["restaurants in Carmel-by-the-Sea", "restaurants", "in", "Carmel-by-the-Sea"],
		["restaurants in Carmel by the Sea", "restaurants", "in", "Carmel by the Sea"],
		["restaurants in the sea", "restaurants", "in", "the sea"],
		["hotels near Stow-on-the-Wold", "hotels", "near", "Stow-on-the-Wold"],
		["trains to Newcastle-upon-Tyne", "trains", "to", "Newcastle-upon-Tyne"],
		["flights to Isle of Man", "flights", "to", "Isle of Man"],
		["pharmacies in City of London", "pharmacies", "in", "City of London"],
		["churches near Church of the Holy Sepulchre", "churches", "near", "Church of the Holy Sepulchre"],
		["places of worship in Stratford-upon-Avon", "places of worship", "in", "Stratford-upon-Avon"],
	] as const

	it.each(cases)("keeps %s as subject | relation | maximal anchor", (text, subject, relation, anchor) => {
		const matched = matchPOISubject(text, "en-GB", categoryLookup)

		expect(matched).toMatchObject({ subject, relation, remainder: anchor })
		expect(matched?.subjectSpan.text).toBe(subject)
		expect(matched?.relationSpan?.text).toBe(relation)
		expect(matched?.anchorSpan?.text).toBe(anchor)
	})

	it.each(["Carmel-by-the-Sea", "12 Carmel-by-the-Sea Road", "Church of the Holy Sepulchre"])(
		"does not manufacture a category span for %s",
		(text) => expect(matchPOISubject(text, "en-GB", categoryLookup)).toBeNull()
	)
})

describe("span-first multilingual anchors", () => {
	const categoryLookup: POIPhraseLookup = (phrase) => {
		const subject = phrase.trim().toLowerCase()

		return ["restaurant", "hotel", "pharmacy", "cafe"].includes(subject)
			? [{ kind: "category", categoryID: subject, matchedPhrase: subject, confidence: 1 }]
			: []
	}

	const cases = [
		["restaurant in München", "de-DE", "restaurant", "in", "München"],
		["hotel near São Tomé and Príncipe", "pt-PT", "hotel", "near", "São Tomé and Príncipe"],
		["pharmacy in مدينة الكويت", "ar-KW", "pharmacy", "in", "مدينة الكويت"],
		["restaurant in 東京", "ja-JP", "restaurant", "in", "東京"],
		["hotel near Санкт-Петербург", "ru-RU", "hotel", "near", "Санкт-Петербург"],
		["cafe in Côte d’Ivoire", "fr-FR", "cafe", "in", "Côte d’Ivoire"],
	] as const

	it.each(cases)("keeps the Unicode anchor intact for %s", (text, locale, subject, relation, anchor) => {
		const matched = matchPOISubject(text, locale, categoryLookup)

		expect(matched).toMatchObject({ subject, relation, remainder: anchor })
		expect(matched?.anchorSpan?.text).toBe(anchor)
		expect(text.slice(matched?.anchorSpan?.start, matched?.anchorSpan?.end)).toBe(anchor)
	})
})

describe("ANCHOR_SEPARATOR is linear (ReDoS safety)", () => {
	// Force a full separator scan on every call.
	const neverHits: POIPhraseLookup = () => []

	it("returns quickly on a long adversarial whitespace run (no polynomial backtracking)", () => {
		const pathological = "\t".repeat(100_000) + "x"
		const start = performance.now()
		const m = matchPOISubject(pathological, "en-US", neverHits)
		const elapsed = performance.now() - start
		expect(m).toBeNull()
		// Keep the generous limit low enough to catch quadratic backtracking.
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

	// A bare category is `poi_category`; `poi_query` remains an alternative.
	// Both use the POI branch.
	it("emits poi_category for a bare category phrase, with poi_query underneath", async () => {
		const result = await classify(input("hospital"), shape(), LOCALE)
		expect(result.kind).toBe("poi_category")
		expect(result.confidence).toBeGreaterThanOrEqual(0.9)
		expect(result.alternatives.map((a) => a.kind)).toContain("poi_query")
		expect(result.intentMarkers?.map((m) => m.code)).toEqual(["poi_category"])
		expect(result.intentMarkers?.[0]?.evidence?.["categoryID"]).toBe("hospital")
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
