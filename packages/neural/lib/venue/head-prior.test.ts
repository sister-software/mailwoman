/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { buildVenueHeadEmissionPriors, type VenueHeadLexiconLike } from "#venue/head-prior"

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
 * One SentencePiece-style piece per word, with the word-start marker.
 */
function pieces(...words: string[]): { piece: string }[] {
	return words.map((w) => ({ piece: w.startsWith(",") ? w : `▁${w}` }))
}

describe("buildVenueHeadEmissionPriors", () => {
	it("biases both venue columns on a last-word head and the words before it", () => {
		const m = buildVenueHeadEmissionPriors(
			lexicon({ last: { gallery: 2 } }),
			pieces("Manchester", "Art", "Gallery"),
			LABELS
		)

		for (const row of [0, 1, 2]) {
			expect(m[row]![B]).toBeCloseTo(2)
			expect(m[row]![I]).toBeCloseTo(2)
		}
	})

	it("leaves a piece between two words unbiased, so the next word can open a new span", () => {
		const m = buildVenueHeadEmissionPriors(
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

		const streetName = buildVenueHeadEmissionPriors(
			lexicon({ first: { museum: 2 } }),
			pieces("Museum", "Street"),
			LABELS,
			{
				isStreetAffix,
			}
		)

		expect(streetName.flat().every((v) => v === 0)).toBe(true)

		const stopped = buildVenueHeadEmissionPriors(
			lexicon({ first: { musée: 2 } }),
			pieces("Musée", "Rodin", "Street"),
			LABELS,
			{
				isStreetAffix,
			}
		)

		expect(stopped[1]![I]).toBeCloseTo(2)
		expect(stopped[2]![I]).toBe(0)
	})

	it("decays the bias by extensionDecay once for each word from the head", () => {
		const m = buildVenueHeadEmissionPriors(
			lexicon({ last: { gallery: 2 } }),
			pieces("Manchester", "Art", "Gallery"),
			LABELS,
			{
				extensionDecay: 0.5,
			}
		)

		expect(m[0]![B]).toBeCloseTo(0.5)
		expect(m[1]![I]).toBeCloseTo(1)
	})

	it("biases a first-word head and the words after it, beginning the span at the head", () => {
		const m = buildVenueHeadEmissionPriors(lexicon({ first: { musée: 2 } }), pieces("Musée", "dOrsay"), LABELS)

		expect(m[0]![B]).toBeCloseTo(2)
		expect(m[1]![I]).toBeCloseTo(2)
	})

	it("stops the span at a comma and at a word with a digit", () => {
		const m = buildVenueHeadEmissionPriors(
			lexicon({ last: { gallery: 2 } }),
			pieces("Mosley", "St", ",", "12", "Art", "Gallery"),
			LABELS
		)

		expect(m[4]![B]).toBeCloseTo(2)
		expect(m[3]![B]).toBe(0)
		expect(m[3]![I]).toBe(0)
		expect(m[1]![I]).toBe(0)
		expect(m[1]![B]).toBe(0)
	})

	it("stops the span at a single-letter word, which belongs to the designator before it", () => {
		const m = buildVenueHeadEmissionPriors(
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
		const m = buildVenueHeadEmissionPriors(
			lexicon({ last: { gallery: 2 }, first: { gallery: 2 } }),
			pieces("Gallery"),
			LABELS
		)

		expect(m[0]!.every((v) => v === 0)).toBe(true)
	})

	it("biases a single word that ends in a suffix head", () => {
		const m = buildVenueHeadEmissionPriors(
			lexicon({ suffix: { 館: 1.5 } }),
			[{ piece: "▁国立" }, { piece: "西洋美術館" }],
			LABELS
		)

		expect(m[0]![B]).toBeCloseTo(1.5)
		expect(m[1]![I]).toBeCloseTo(1.5)
		expect(m[1]![B]).toBeCloseTo(1.5)
	})

	it("scales the bias and caps it at maxBias", () => {
		const m = buildVenueHeadEmissionPriors(lexicon({ last: { palace: 6 } }), pieces("Buckingham", "Palace"), LABELS, {
			biasScale: 2,
			maxBias: 8,
		})

		expect(m[1]![I]).toBeCloseTo(8)
	})

	it("returns the zero matrix for a vocabulary without venue labels", () => {
		const m = buildVenueHeadEmissionPriors(lexicon({ last: { gallery: 2 } }), pieces("Art", "Gallery"), [
			"O",
			"B-locality",
		])

		expect(m.flat().every((v) => v === 0)).toBe(true)
	})
})
