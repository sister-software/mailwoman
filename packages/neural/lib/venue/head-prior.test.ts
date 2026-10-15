/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { VenueHeadLexiconLike, VenueHeadPriorOpts } from "@mailwoman/core/pipeline"
import { describe, expect, it } from "vitest"

import { buildVenueHeadEmissionPriors, DEFAULT_VENUE_HEAD_BIAS_SCALE } from "#venue/head-prior"

const LABELS = ["O", "B-locality", "I-locality", "B-venue", "I-venue"]
const B = LABELS.indexOf("B-venue")
const I = LABELS.indexOf("I-venue")

function lexicon(entries: {
	first?: Record<string, number>
	last?: Record<string, number>
	suffix?: Record<string, number>
}): VenueHeadLexiconLike {
	return {
		first: (w) => entries.first?.[w] ?? null,
		last: (w) => entries.last?.[w] ?? null,
		suffix: (w) => {
			for (const [suffix, bias] of Object.entries(entries.suffix ?? {})) {
				if (w.length > suffix.length && w.endsWith(suffix)) return bias
			}

			return null
		},
	}
}

/**
 * Builds the matrix at a bias scale of 1, so each cell reads the lexicon's bias directly.
 */
function build(
	lex: VenueHeadLexiconLike,
	input: { piece: string }[],
	labels: string[],
	opts: VenueHeadPriorOpts = {}
): number[][] {
	return buildVenueHeadEmissionPriors(lex, input, labels, { biasScale: 1, ...opts })
}

/**
 * One SentencePiece-style piece per word, with the word-start marker.
 */
function pieces(...words: string[]): { piece: string }[] {
	return words.map((w) => ({ piece: w.startsWith(",") ? w : `▁${w}` }))
}

describe("buildVenueHeadEmissionPriors", () => {
	it("biases both venue columns on a last-word head and the words before it", () => {
		const m = build(lexicon({ last: { gallery: 2 } }), pieces("Manchester", "Art", "Gallery"), LABELS)

		for (const row of [0, 1, 2]) {
			expect(m[row]![B]).toBeCloseTo(2)
			expect(m[row]![I]).toBeCloseTo(2)
		}
	})

	it("leaves a piece between two words unbiased, so the next word can open a new span", () => {
		const m = build(
			lexicon({ last: { museum: 2 } }),
			[{ piece: "▁History" }, { piece: "▁" }, { piece: "Mus" }, { piece: "eum" }],
			LABELS
		)

		expect(m[1]![B]).toBe(0)
		expect(m[1]![I]).toBe(0)
		expect(m[2]![B]).toBeCloseTo(2)
		expect(m[3]![I]).toBeCloseTo(2)
	})

	it("skips a head followed by a street affix and stops an extension at one", () => {
		const isStreetAffix = (w: string) => w === "street"

		const streetName = build(lexicon({ first: { museum: 2 } }), pieces("Museum", "Street"), LABELS, {
			isStreetAffix,
		})

		expect(streetName.flat().every((v) => v === 0)).toBe(true)

		const stopped = build(lexicon({ first: { musée: 2 } }), pieces("Musée", "Rodin", "Street"), LABELS, {
			isStreetAffix,
		})

		expect(stopped[1]![I]).toBeCloseTo(2)
		expect(stopped[2]![I]).toBe(0)
	})

	it("gives no first-word bias to a street type after a street name, and keeps it when the type opens the segment", () => {
		const isStreetAffix = (w: string) => w === "st" || w === "rd"
		const lex = lexicon({ first: { st: 2 }, last: { school: 2 } })

		const afterName = build(lex, pieces("6th", "St", "SW"), LABELS, { isStreetAffix })

		expect(afterName.flat().every((v) => v === 0)).toBe(true)

		const saint = build(lex, pieces("St", "Mary's", "Church"), LABELS, { isStreetAffix })

		expect(saint[0]![B]).toBeCloseTo(2)
		expect(saint[1]![I]).toBeCloseTo(2)

		// `School` heads no venue before the street type `Rd`, once `rd` reads as one.
		const streetName = build(lex, pieces("Mountain", "School", "Rd"), LABELS, { isStreetAffix })

		expect(streetName.flat().every((v) => v === 0)).toBe(true)
	})

	it("gives no bias inside a segment that is a country name", () => {
		const isCountryName = (segment: string) => segment === "united states of america"
		const lex = lexicon({ last: { america: 2 } })

		const country = build(lex, pieces("United", "States", "of", "America", ",", "Vermont"), LABELS, { isCountryName })

		expect(country.flat().every((v) => v === 0)).toBe(true)

		const bank = build(lex, pieces("Bank", "of", "America", ",", "Vermont"), LABELS, { isCountryName })

		expect(bank[2]![B]).toBeCloseTo(2)
		expect(bank[0]![I]).toBeCloseTo(2)

		const unguarded = build(lex, pieces("United", "States", "of", "America", ",", "Vermont"), LABELS)

		expect(unguarded[3]![B]).toBeCloseTo(2)
	})

	it("gives no bias to a street-type head whose span opens with a house number", () => {
		const isStreetAffix = (w: string) => w === "plaza" || w === "center" || w === "garden"
		const lex = lexicon({ last: { plaza: 2, center: 3, gallery: 2 } })

		const numbered = build(lex, pieces("30", "Rockefeller", "Plaza"), LABELS, { isStreetAffix })

		expect(numbered.flat().every((v) => v === 0)).toBe(true)

		const twoWordName = build(lex, pieces("1", "Dag", "Hammarskjold", "Plaza"), LABELS, { isStreetAffix })

		expect(twoWordName.flat().every((v) => v === 0)).toBe(true)

		// The number opens the segment even when a street affix or a single letter sits inside the name.
		const affixInside = build(lex, pieces("42", "Garden", "Center"), LABELS, { isStreetAffix })

		expect(affixInside.flat().every((v) => v === 0)).toBe(true)

		const letterInside = build(lex, pieces("110", "Issac", "S", "Cole", "Plaza"), LABELS, { isStreetAffix })

		expect(letterInside.flat().every((v) => v === 0)).toBe(true)

		// The number must open the span itself: a number before a comma belongs to another segment.
		const venueAfterNumber = build(lex, pieces("45", ",", "Rockefeller", "Center"), LABELS, { isStreetAffix })

		expect(venueAfterNumber[2]![B]).toBeCloseTo(3)
		expect(venueAfterNumber[3]![I]).toBeCloseTo(3)

		// A head that is not a street type keeps its bias after a number.
		const gallery = build(lex, pieces("30", "City", "Gallery"), LABELS, { isStreetAffix })

		expect(gallery[1]![B]).toBeCloseTo(2)
		expect(gallery[2]![I]).toBeCloseTo(2)

		// A single letter is an identifier but not a number, so `Concourse B` keeps the rule out.
		const letter = build(lex, pieces("B", "Food", "Center"), LABELS, { isStreetAffix })

		expect(letter[2]![I]).toBeCloseTo(3)
	})

	it("decays the bias by extensionDecay once for each word from the head", () => {
		const m = build(lexicon({ last: { gallery: 2 } }), pieces("Manchester", "Art", "Gallery"), LABELS, {
			extensionDecay: 0.5,
		})

		expect(m[0]![B]).toBeCloseTo(0.5)
		expect(m[1]![I]).toBeCloseTo(1)
	})

	it("biases a first-word head and the words after it, beginning the span at the head", () => {
		const m = build(lexicon({ first: { musée: 2 } }), pieces("Musée", "dOrsay"), LABELS)

		expect(m[0]![B]).toBeCloseTo(2)
		expect(m[1]![I]).toBeCloseTo(2)
	})

	it("stops the span at a comma and at a word with a digit", () => {
		const m = build(lexicon({ last: { gallery: 2 } }), pieces("Mosley", "St", ",", "12", "Art", "Gallery"), LABELS)

		expect(m[4]![B]).toBeCloseTo(2)
		expect(m[3]![B]).toBe(0)
		expect(m[3]![I]).toBe(0)
		expect(m[1]![I]).toBe(0)
		expect(m[1]![B]).toBe(0)
	})

	it("stops the span at a single-letter word, which belongs to the designator before it", () => {
		const m = build(
			lexicon({ last: { airport: 2 } }),
			pieces("Concourse", "B", "O'Hare", "International", "Airport"),
			LABELS
		)

		expect(m[4]![B]).toBeCloseTo(2)
		expect(m[2]![I]).toBeCloseTo(2)
		expect(m[1]![B]).toBe(0)
		expect(m[1]![I]).toBe(0)
		expect(m[0]![I]).toBe(0)
	})

	it("requires a neighbor in the segment for a first-word or last-word head", () => {
		const m = build(lexicon({ last: { gallery: 2 }, first: { gallery: 2 } }), pieces("Gallery"), LABELS)

		expect(m[0]!.every((v) => v === 0)).toBe(true)
	})

	it("biases a single word that ends in a suffix head", () => {
		const m = build(lexicon({ suffix: { 館: 1.5 } }), [{ piece: "▁国立" }, { piece: "西洋美術館" }], LABELS)

		expect(m[0]![B]).toBeCloseTo(1.5)
		expect(m[1]![I]).toBeCloseTo(1.5)
		expect(m[1]![B]).toBeCloseTo(1.5)
	})

	it("scales the bias and caps it at maxBias", () => {
		const m = build(lexicon({ last: { palace: 6 } }), pieces("Buckingham", "Palace"), LABELS, {
			biasScale: 2,
			maxBias: 8,
		})

		expect(m[1]![I]).toBeCloseTo(8)
	})

	it("applies the default scale when the caller sets none", () => {
		const m = buildVenueHeadEmissionPriors(lexicon({ last: { gallery: 2 } }), pieces("Art", "Gallery"), LABELS)

		expect(m[1]![I]).toBeCloseTo(2 * DEFAULT_VENUE_HEAD_BIAS_SCALE)
	})

	it("returns the zero matrix for a vocabulary without venue labels", () => {
		const m = build(lexicon({ last: { gallery: 2 } }), pieces("Art", "Gallery"), ["O", "B-locality"])

		expect(m.flat().every((v) => v === 0)).toBe(true)
	})
})
