/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import type { FSTMatcherLike, FSTMatchLike, FSTPlaceEntryLike } from "./fst-prior.ts"
import { STAGE2_BIO_LABELS } from "./labels.ts"
import { buildTrailingLocalityPriors } from "./trailing-locality-prior.ts"

function labelCol(label: string): number {
	return STAGE2_BIO_LABELS.indexOf(label as (typeof STAGE2_BIO_LABELS)[number])
}

/** Same structural mock as fst-prior.test.ts — paths joined by spaces, prefix-aware walk. */
function mockFST(entries: Map<string, FSTPlaceEntryLike[]>): FSTMatcherLike {
	const states = new Map<string, { id: number; entries: FSTPlaceEntryLike[] }>()
	let nextID = 1

	for (const [path, places] of entries) {
		states.set(path, { id: nextID++, entries: places })
	}

	return {
		walk(tokens: string[]): FSTMatchLike | null {
			const key = tokens.join(" ")
			const state = states.get(key)

			if (state) return { stateID: state.id, accepted: state.entries.length > 0, depth: tokens.length }

			for (const [path] of states) {
				if (path.startsWith(key + " ") || path === key) {
					return { stateID: 0, accepted: false, depth: tokens.length }
				}
			}

			return null
		},
		walkFrom(prev: FSTMatchLike, token: string): FSTMatchLike | null {
			for (const [path] of states) {
				const parts = path.split(" ")

				if (parts.length > prev.depth && parts[prev.depth] === token) {
					const subpath = parts.slice(0, prev.depth + 1).join(" ")
					const exactState = states.get(subpath)

					if (exactState) {
						return { stateID: exactState.id, accepted: exactState.entries.length > 0, depth: prev.depth + 1 }
					}

					return { stateID: 0, accepted: false, depth: prev.depth + 1 }
				}
			}

			return null
		},
		accepting(stateID: number): FSTPlaceEntryLike[] {
			for (const [, state] of states) {
				if (state.id === stateID) return state.entries
			}

			return []
		},
	}
}

const gazetteer = () =>
	mockFST(
		new Map([
			["paris", [{ wofID: 1, placetype: "locality", importance: 0.9 }]],
			["london", [{ wofID: 2, placetype: "locality", importance: 0.9 }]],
			["lafayette", [{ wofID: 3, placetype: "locality", importance: 0.4 }]],
			["washington", [{ wofID: 4, placetype: "locality", importance: 0.8 }]],
			["new", []],
			["new york", [{ wofID: 5, placetype: "locality", importance: 0.95 }]],
			["75005", [{ wofID: 6, placetype: "postalcode", importance: 0.1 }]],
			// R1 fixtures: a region-only 2-token match whose 1-token suffix is a locality.
			["north", []],
			["north dakota", [{ wofID: 7, placetype: "region", importance: 0.8 }]],
			["dakota", [{ wofID: 8, placetype: "locality", importance: 0.3 }]],
			// R1b fixture: region + zero-importance locality on the SAME span (the real FST's
			// "north dakota" shape) — the positive-importance region must win.
			[
				"new england",
				[
					{ wofID: 12, placetype: "region", importance: 0.7 },
					{ wofID: 13, placetype: "locality", importance: 0 },
				],
			],
			// R1b fixture: zero-importance-only locality, no region shadow — presence stays fireable.
			["surlot", [{ wofID: 14, placetype: "locality", importance: 0 }]],
			// R2 fixtures: street names that are themselves place names (after affix+particle).
			["montfaucon", [{ wofID: 9, placetype: "locality", importance: 0.2 }]],
			["roquelaure", [{ wofID: 10, placetype: "locality", importance: 0.2 }]],
		])
	)

const morphology = () =>
	mockFST(
		new Map([
			["rue", [{ wofID: 900, placetype: "street_affix", importance: 0 }]],
			["cours", [{ wofID: 901, placetype: "street_affix", importance: 0 }]],
			["street", [{ wofID: 902, placetype: "street_affix", importance: 0 }]],
			["ave", [{ wofID: 903, placetype: "street_affix", importance: 0 }]],
		])
	)

function makePieces(text: string): Array<{ piece: string; start: number; end: number }> {
	const words = text.split(/\s+/)
	const pieces: Array<{ piece: string; start: number; end: number }> = []
	let cursor = 0

	for (const word of words) {
		const start = text.indexOf(word, cursor)
		pieces.push({ piece: `▁${word}`, start, end: start + word.length })
		cursor = start + word.length
	}

	return pieces
}

const OPTS = () => ({ fst: gazetteer(), streetMorphology: morphology() })
const isZero = (m: number[][]) => m.every((row) => row.every((v) => v === 0))

describe("buildTrailingLocalityPriors — geometry gates (comma-free street + trailing city, fork B)", () => {
	it("fires on a prefix-locale trailing city ('8 Rue Princesse Paris'): B-locality + street suppression on the span", () => {
		const pieces = makePieces("8 Rue Princesse Paris")
		const m = buildTrailingLocalityPriors(pieces, STAGE2_BIO_LABELS, OPTS())
		expect(m[3]![labelCol("B-locality")]).toBeCloseTo(6.0, 2)
		expect(m[3]![labelCol("B-street")]).toBeCloseTo(-1.5, 2)
		// the street itself is untouched
		expect(m[0]!.every((v) => v === 0)).toBe(true)
		expect(m[2]!.every((v) => v === 0)).toBe(true)
	})

	it("fires on a suffix-locale trailing city ('10 Downing Street London') — affix in suffix position", () => {
		const pieces = makePieces("10 Downing Street London")
		const m = buildTrailingLocalityPriors(pieces, STAGE2_BIO_LABELS, OPTS())
		expect(m[3]![labelCol("B-locality")]).toBeCloseTo(6.0, 2)
	})

	it("longest-first multi-token span ('350 5th Ave New York') — B on 'New', I on 'York'", () => {
		const pieces = makePieces("350 5th Ave New York")
		const m = buildTrailingLocalityPriors(pieces, STAGE2_BIO_LABELS, OPTS())
		expect(m[3]![labelCol("B-locality")]).toBeCloseTo(6.0, 2)
		expect(m[4]![labelCol("I-locality")]).toBeCloseTo(6.0, 2)
	})

	it("does NOT fire on the street NAME of a prefix-locale bare street ('45 Cours Lafayette')", () => {
		// Lafayette IS a gazetteer locality, but it immediately follows a prefix-position affix
		// (only a house number precedes 'Cours') — the span is the street name, not a trailing city.
		const pieces = makePieces("45 Cours Lafayette")
		const m = buildTrailingLocalityPriors(pieces, STAGE2_BIO_LABELS, OPTS())
		expect(isZero(m)).toBe(true)
	})

	it("does NOT fire without street-affix evidence ('500 Washington' — the #1143 shape, left to the street-context gate)", () => {
		const pieces = makePieces("500 Washington")
		const m = buildTrailingLocalityPriors(pieces, STAGE2_BIO_LABELS, OPTS())
		expect(isZero(m)).toBe(true)
	})

	it("does NOT fire on a bare street whose trailing token is no locality ('3 Rue des Lyonnais')", () => {
		const pieces = makePieces("3 Rue des Lyonnais")
		const m = buildTrailingLocalityPriors(pieces, STAGE2_BIO_LABELS, OPTS())
		expect(isZero(m)).toBe(true)
	})

	it("does NOT fire when the trailing span is a postcode ('…Paris, 75005' — the comma'd control stays clean)", () => {
		const pieces = makePieces("3 Rue des Lyonnais Paris 75005")
		const m = buildTrailingLocalityPriors(pieces, STAGE2_BIO_LABELS, OPTS())
		// span candidates: '75005' (postalcode, not locality), 'paris 75005' / longer — no locality path
		expect(isZero(m)).toBe(true)
	})

	it("honors custom bias/streetPenalty magnitudes", () => {
		const pieces = makePieces("8 Rue Princesse Paris")
		const m = buildTrailingLocalityPriors(pieces, STAGE2_BIO_LABELS, { ...OPTS(), bias: 4, streetPenalty: 0 })
		expect(m[3]![labelCol("B-locality")]).toBeCloseTo(4, 2)
		expect(m[3]![labelCol("B-street")]).toBe(0)
	})

	it("label vocab without locality → zero matrix (stage-1 model safety)", () => {
		const pieces = makePieces("8 Rue Princesse Paris")
		const m = buildTrailingLocalityPriors(pieces, ["O", "B-street", "I-street"], OPTS())
		expect(isZero(m)).toBe(true)
	})

	it("R1: longest admin match wins — 'North Dakota' (region) BLOCKS firing on its locality suffix 'Dakota'", () => {
		const pieces = makePieces("58078 12th Ave SE North Dakota")
		const m = buildTrailingLocalityPriors(pieces, STAGE2_BIO_LABELS, OPTS())
		expect(isZero(m)).toBe(true)
	})

	it("R1: a multi-token locality ('New York') still fires — its own longest match carries locality", () => {
		const pieces = makePieces("350 5th Ave New York")
		const m = buildTrailingLocalityPriors(pieces, STAGE2_BIO_LABELS, OPTS())
		expect(m[3]![labelCol("B-locality")]).toBeCloseTo(6.0, 2)
	})

	it("R2: particle transparency — '8 Rue de Montfaucon' does NOT fire (the place name IS the street name)", () => {
		const pieces = makePieces("8 Rue de Montfaucon")
		const m = buildTrailingLocalityPriors(pieces, STAGE2_BIO_LABELS, OPTS())
		expect(isZero(m)).toBe(true)
	})

	it("R2: particles don't shield a real trailing city ('8 Rue de Montfaucon Paris' fires on Paris)", () => {
		const pieces = makePieces("8 Rue de Montfaucon Paris")
		const m = buildTrailingLocalityPriors(pieces, STAGE2_BIO_LABELS, OPTS())
		expect(m[4]![labelCol("B-locality")]).toBeCloseTo(6.0, 2)
	})

	it("R3: locality already in the model's argmax → zero matrix (don't re-label locality-present parses)", () => {
		const pieces = makePieces("8 Rue Princesse Paris")
		const bLocCol = labelCol("B-locality")
		const emissions = pieces.map(() => new Array<number>(STAGE2_BIO_LABELS.length).fill(0))
		emissions[3]![bLocCol] = 1 // the model already emits locality on 'Paris'
		const m = buildTrailingLocalityPriors(pieces, STAGE2_BIO_LABELS, { ...OPTS(), emissions })
		expect(isZero(m)).toBe(true)
	})

	it("R1b: a positive-importance region beats zero-importance locality entries on the same span", () => {
		const pieces = makePieces("400 5th Ave New England")
		const m = buildTrailingLocalityPriors(pieces, STAGE2_BIO_LABELS, OPTS())
		expect(isZero(m)).toBe(true)
	})

	it("R1b: a zero-importance-only locality (no region shadow) stays fireable — presence over importance", () => {
		const pieces = makePieces("16 Rue du Château Surlot")
		const m = buildTrailingLocalityPriors(pieces, STAGE2_BIO_LABELS, OPTS())
		expect(m[4]![labelCol("B-locality")]).toBeCloseTo(6.0, 2)
	})

	it("R4: comma fused into the previous word piece ('10 Downing Street, London') → silent", () => {
		// makePieces fuses 'Street,' into one piece — the comma-separated shape the golden collateral lives in.
		const pieces = makePieces("10 Downing Street, London")
		const m = buildTrailingLocalityPriors(pieces, STAGE2_BIO_LABELS, OPTS())
		expect(isZero(m)).toBe(true)
	})

	it("R4: comma as its own gap piece also silences", () => {
		const pieces = [
			{ piece: "▁10", start: 0, end: 2 },
			{ piece: "▁Downing", start: 3, end: 10 },
			{ piece: "▁Street", start: 11, end: 17 },
			{ piece: ",", start: 17, end: 18 },
			{ piece: "▁London", start: 19, end: 25 },
		]
		const m = buildTrailingLocalityPriors(pieces, STAGE2_BIO_LABELS, OPTS())
		expect(isZero(m)).toBe(true)
	})
})
