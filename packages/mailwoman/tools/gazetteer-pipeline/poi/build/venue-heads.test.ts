/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import {
	aggregateLanguage,
	codexAdminWords,
	HeadCounts,
	MIN_SUFFIX_STEMS,
	MIN_SUPPORT,
	nameWords,
	pruneSuffixes,
	scoreCountry,
	suffixCounts,
	wordSuffixes,
	type CountryCounts,
} from "#gazetteer/poi/build/venue-heads"

function counts(venue: string[], place: string[], street: string[], adminWords: string[] = []): CountryCounts {
	const entry: CountryCounts = {
		venue: new HeadCounts(),
		place: new HeadCounts(),
		street: new HeadCounts(),
		adminWords: new Set(adminWords),
	}

	for (const name of venue) {
		entry.venue.add(name)
	}

	for (const name of place) {
		entry.place.add(name)
	}

	for (const name of street) {
		entry.street.add(name)
	}

	return entry
}

const repeat = (prefix: string, head: string, n: number): string[] =>
	Array.from({ length: n }, (_, i) => `${prefix}${i} ${head}`)

describe("nameWords", () => {
	it("splits on whitespace and normalizes each word as the decoder does", () => {
		expect(nameWords("Musée d'Orsay")).toEqual(["musée", "dorsay"])
		expect(nameWords("  Manchester  Art Gallery ")).toEqual(["manchester", "art", "gallery"])
		expect(nameWords("— & —")).toEqual([])
	})
})

describe("wordSuffixes", () => {
	it("counts alphabetic suffixes of four or more characters, shorter than the word", () => {
		expect(wordSuffixes("galerie")).toEqual(["erie", "lerie", "alerie"])
	})

	it("counts single-character suffixes in scripts written without spaces", () => {
		expect(wordSuffixes("美術館")).toEqual(["館", "術館"])
	})
})

describe("HeadCounts", () => {
	it("counts first and last words only for names of two or more words", () => {
		const c = new HeadCounts()
		c.add("Gallery")
		c.add("Art Gallery")

		expect(c.names).toBe(2)
		expect(c.last.get("gallery")).toBe(1)
		expect(c.first.get("art")).toBe(1)
		expect(c.lastWords.get("gallery")).toBe(2)
	})
})

describe("suffixCounts", () => {
	it("sums name counts per suffix and counts the distinct words ending in it", () => {
		const lastWords = new Map([
			["nationalgalerie", 5],
			["kunstgalerie", 2],
			["london", 40],
		])

		const bySuffix = suffixCounts(lastWords)

		expect(bySuffix.get("alerie")).toEqual({ count: 7, stems: 2 })
		expect(bySuffix.get("ondon")).toEqual({ count: 40, stems: 1 })
	})

	it("skips an excluded word", () => {
		expect(suffixCounts(new Map([["london", 40]]), new Set(["london"])).size).toBe(0)
	})
})

describe("codexAdminWords", () => {
	it("holds the country's one-word names in other languages", () => {
		expect(codexAdminWords("DE")).toContain("deutschland")
		expect(codexAdminWords("DE")).toContain("alemania")
		expect(codexAdminWords("JP")).toContain("日本")
		expect(codexAdminWords("US")).not.toContain("united")
	})
})

describe("scoreCountry", () => {
	it("scores a head by its venue rate over the higher of its place and street rates", () => {
		const entries = scoreCountry(
			counts(repeat("v", "gallery", MIN_SUPPORT), [...repeat("p", "town", 50), "Art Gallery"], repeat("s", "road", 50))
		)

		// Venue rate (30.5 / 30.5) over place rate (1.5 / 51.5).
		expect(entries.last.gallery).toBeCloseTo(Math.log(1 / (1.5 / 51.5)), 2)
	})

	it("omits a head below the support floor", () => {
		const entries = scoreCountry(counts(repeat("v", "gallery", MIN_SUPPORT - 1), repeat("p", "town", 50), []))

		expect(entries.last.gallery).toBeUndefined()
	})

	it("excludes an admin place name at the first and last positions", () => {
		const venue = [
			...repeat("v", "london", MIN_SUPPORT),
			...Array.from({ length: MIN_SUPPORT }, (_, i) => `London Dental ${i}`),
		]

		const entries = scoreCountry(counts(venue, repeat("p", "town", 50), [], ["london"]))

		expect(entries.first.london).toBeUndefined()
		expect(entries.last.london).toBeUndefined()
	})

	it("keeps a suffix that ends several words and is itself a venue last word", () => {
		const stems = Array.from({ length: MIN_SUFFIX_STEMS }, (_, i) => `stem${i}galerie`)
		const venue = [...stems.flatMap((stem) => repeat("v", stem, MIN_SUPPORT)), ...repeat("v", "galerie", MIN_SUPPORT)]
		const entries = scoreCountry(counts(venue, repeat("p", "town", 50), []))

		expect(entries.suffix.galerie).toBeDefined()
		// `erie` ends the same names but is no venue word of its own.
		expect(entries.suffix.erie).toBeUndefined()
	})

	it("refuses a suffix carried by one word", () => {
		const venue = [...repeat("v", "nationalgalerie", MIN_SUPPORT * 3), ...repeat("v", "galerie", MIN_SUPPORT)]
		const entries = scoreCountry(counts(venue, repeat("p", "town", 50), []))

		expect(entries.suffix).toEqual({})
	})

	it("keeps a single-character suffix in a script without spaces", () => {
		const venue = ["国立西洋美術館", "東京都美術館", "江戸東京博物館", "科学館"].flatMap((stem) =>
			repeat("v", stem, MIN_SUPPORT)
		)

		const entries = scoreCountry(counts(venue, repeat("p", "町", 50), []))

		expect(entries.suffix["館"]).toBeDefined()
	})

	it("gives an admin place name no suffix entry", () => {
		const stems = ["london", "hendon", "swindon"]
		const venue = [...stems.flatMap((stem) => repeat("v", stem, MIN_SUPPORT)), ...repeat("v", "ndon", MIN_SUPPORT)]

		expect(scoreCountry(counts(venue, repeat("p", "town", 50), [])).suffix.ndon).toBeDefined()
		expect(scoreCountry(counts(venue, repeat("p", "town", 50), [], stems)).suffix).toEqual({})
	})

	it("compares a head with the word's rate at any position in place names", () => {
		const venue = repeat("v", "on", MIN_SUPPORT)
		const places = Array.from({ length: 50 }, (_, i) => `Walton${i} on the Naze`)

		expect(scoreCountry(counts(venue, places, [])).last.on).toBeUndefined()
		expect(scoreCountry(counts(venue, repeat("p", "town", 50), [])).last.on).toBeDefined()
	})

	it("refuses a single-letter head", () => {
		const entries = scoreCountry(counts(repeat("v", "n", MIN_SUPPORT), repeat("p", "town", 50), []))

		expect(entries.last.n).toBeUndefined()
	})

	it("uses the street rate when a head is common in street names", () => {
		const entries = scoreCountry(
			counts(repeat("v", "road", MIN_SUPPORT), repeat("p", "town", 50), repeat("s", "road", 50))
		)

		expect(entries.last.road).toBeUndefined()
	})
})

describe("pruneSuffixes", () => {
	it("drops a longer suffix within half a logit of the shorter suffix it ends with", () => {
		expect(pruneSuffixes({ erie: 2, lerie: 2.2, alerie: 3 })).toEqual({ erie: 2, alerie: 3 })
	})
})

describe("aggregateLanguage", () => {
	it("weights countries equally and counts a missing entry as zero", () => {
		const gb = { first: {}, last: { gallery: 4, palace: 2 }, suffix: {} }
		const nz = { first: {}, last: { gallery: 2 }, suffix: {} }

		expect(aggregateLanguage([gb, nz]).last).toEqual({ gallery: 3, palace: 1 })
	})
})
