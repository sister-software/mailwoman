/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { repoRootPath } from "@mailwoman/core/utils"
import { describe, expect, it } from "vitest"

import {
	buildFSTEmissionPriors,
	groupPiecesIntoWords,
	normalizeFSTToken,
	type FSTMatcherLike,
	type FSTMatchLike,
	type FSTPlaceEntryLike,
} from "./fst-prior.ts"
import { STAGE2_BIO_LABELS } from "./labels.ts"
import { MailwomanTokenizer } from "./tokenizer.ts"

const TOKENIZER_MODEL_PATH = repoRootPath("neural", "test", "fixtures", "tokenizer-v0.1.0.model")

function labelCol(label: string): number {
	return STAGE2_BIO_LABELS.indexOf(label as (typeof STAGE2_BIO_LABELS)[number])
}

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
			for (const [path, state] of states) {
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

describe("buildFSTEmissionPriors", () => {
	it("produces zero matrix when no FST matches", () => {
		const fst = mockFST(new Map())
		const pieces = makePieces("hello world")
		const matrix = buildFSTEmissionPriors(fst, pieces, STAGE2_BIO_LABELS)

		for (const row of matrix) {
			expect(row.every((v) => v === 0)).toBe(true)
		}
	})

	it("biases matched locality tokens proportional to importance", () => {
		const fst = mockFST(new Map([["portland", [{ wofID: 1, placetype: "locality", importance: 0.72 }]]]))
		const pieces = makePieces("Portland")
		const matrix = buildFSTEmissionPriors(fst, pieces, STAGE2_BIO_LABELS)
		expect(matrix[0]![labelCol("B-locality")]).toBeCloseTo(0.72 * 3.0, 2)
		expect(matrix[0]![labelCol("B-street")]).toBeLessThan(0)
	})

	it("biases multi-word place names with B/I convention", () => {
		const fst = mockFST(
			new Map([
				["new", []],
				[
					"new york",
					[
						{ wofID: 2, placetype: "locality", importance: 0.95 },
						{ wofID: 3, placetype: "region", importance: 0.85 },
					],
				],
			])
		)
		const pieces = makePieces("New York")
		const matrix = buildFSTEmissionPriors(fst, pieces, STAGE2_BIO_LABELS)

		expect(matrix[0]![labelCol("B-locality")]).toBeCloseTo(0.95 * 3.0, 2)
		expect(matrix[1]![labelCol("I-locality")]).toBeCloseTo(0.95 * 3.0, 2)
		expect(matrix[0]![labelCol("B-region")]).toBeCloseTo(0.85 * 3.0, 2)
		expect(matrix[0]![labelCol("B-locality")]).toBeGreaterThan(matrix[0]![labelCol("B-region")]!)
	})

	it("low importance produces proportionally lower bias", () => {
		const fst = mockFST(new Map([["hamlet", [{ wofID: 4, placetype: "locality", importance: 0.05 }]]]))
		const pieces = makePieces("Hamlet")
		const matrix = buildFSTEmissionPriors(fst, pieces, STAGE2_BIO_LABELS)
		expect(matrix[0]![labelCol("B-locality")]).toBeCloseTo(0.15, 2)
	})

	it("does not bias unmapped placetypes (county)", () => {
		const fst = mockFST(new Map([["cook", [{ wofID: 5, placetype: "county", importance: 0.88 }]]]))
		const pieces = makePieces("Cook")
		const matrix = buildFSTEmissionPriors(fst, pieces, STAGE2_BIO_LABELS)

		for (const row of matrix) {
			expect(row.every((v) => v === 0)).toBe(true)
		}
	})

	it("handles subword pieces correctly", () => {
		const fst = mockFST(new Map([["springfield", [{ wofID: 6, placetype: "locality", importance: 0.45 }]]]))
		const pieces = [
			{ piece: "▁Spring", start: 0, end: 6 },
			{ piece: "field", start: 6, end: 11 },
		]
		const matrix = buildFSTEmissionPriors(fst, pieces, STAGE2_BIO_LABELS)
		expect(matrix[0]![labelCol("B-locality")]).toBeCloseTo(0.45 * 3.0, 2)
		expect(matrix[1]![labelCol("I-locality")]).toBeCloseTo(0.45 * 3.0, 2)
	})

	it("folds trailing punctuation into the preceding word's bias, not into a separate placeholder (post Fix-1 adjudication)", () => {
		// Behavior-delta adjudication (fix-wave, groupPiecesIntoWords Critical fix): before the fix, ANY
		// punctuation-only piece — including one trailing a complete word with no more alnum content to
		// follow — reset `current` and got its own empty placeholder group, so the comma's own row (piece 1)
		// never received the "Washington" bias. Under the controller-decided semantics ("the word boundary is
		// ▁ only"), a punctuation-only piece with no leading ▁ is unconditionally interior to whatever word is
		// still active — there's no look-ahead to distinguish "mid-word hyphen" from "trailing comma before a
		// new ▁ word", and the task's own repro cases ("Stockton-on-Tees" etc.) don't need one. The comma here
		// never risked being dropped either way (the fix's actual harm was pieces vanishing, which this case
		// never hit — "▁DC" always opens its own group), so the OLD assertion (comma's row stays all-zero)
		// encoded an implementation accident of the pre-fix code, not a protected invariant — updated
		// consciously, not silently. See the fix-wave report.
		const fst = mockFST(new Map([["washington", [{ wofID: 7, placetype: "locality", importance: 0.85 }]]]))
		const pieces = [
			{ piece: "▁Washington", start: 0, end: 10 },
			{ piece: ",", start: 10, end: 11 },
			{ piece: "▁DC", start: 12, end: 14 },
		]
		const matrix = buildFSTEmissionPriors(fst, pieces, STAGE2_BIO_LABELS)
		expect(matrix[0]![labelCol("B-locality")]).toBeCloseTo(0.85 * 3.0, 2)
		// The comma (piece 1) is now part of the "Washington" word group — it gets the SAME bias as an
		// I-locality continuation piece, not a zero row.
		expect(matrix[1]![labelCol("I-locality")]).toBeCloseTo(0.85 * 3.0, 2)
		// "DC" never matches this mock FST ("washington" is the only indexed path) — untouched.
		expect(matrix[2]!.every((v) => v === 0)).toBe(true)
	})

	it("length-scales street suppression for a single-token match (default `suppression` mode), positive bias intact (#1142)", () => {
		// A lone place-name token ("Sweeney") is weak street-head evidence. The default `suppression` mode
		// scales the street/house-number suppression by match length (1-token ×0.25) so the model's own
		// "Ranch Road → street" reading can win, while the POSITIVE locality bias is left at full strength.
		const fst = mockFST(new Map([["sweeney", [{ wofID: 9, placetype: "locality", importance: 0.5 }]]]))
		const pieces = makePieces("Sweeney")
		const supp = buildFSTEmissionPriors(fst, pieces, STAGE2_BIO_LABELS) // default: suppression
		// positive locality bias unscaled (importance * maxBias)
		expect(supp[0]![labelCol("B-locality")]).toBeCloseTo(0.5 * 3.0, 2)
		// street suppression scaled to 0.25 of the -1.5 default
		expect(supp[0]![labelCol("B-street")]).toBeCloseTo(-1.5 * 0.25, 2)

		// `off` gives the full flat suppression (-1.5); `both` also scales the positive bias.
		const off = buildFSTEmissionPriors(fst, pieces, STAGE2_BIO_LABELS, { importanceLengthScaleMode: "off" })
		expect(off[0]![labelCol("B-street")]).toBeCloseTo(-1.5, 2)
		expect(off[0]![labelCol("B-locality")]).toBeCloseTo(0.5 * 3.0, 2)
		const both = buildFSTEmissionPriors(fst, pieces, STAGE2_BIO_LABELS, { importanceLengthScaleMode: "both" })
		expect(both[0]![labelCol("B-locality")]).toBeCloseTo(0.5 * 3.0 * 0.25, 2)
	})
})

describe("normalizeFSTToken", () => {
	it("lowercases and strips hyphens (Stockton-on-Tees → stocktonontees)", () => {
		const result = normalizeFSTToken("Stockton-on-Tees")
		expect(result).toBe("stocktonontees")
	})

	it("leaves spaces intact (Zs, not punctuation) — hyphen/space equivalence comes from the caller's split-then-join", () => {
		// Spaces (U+0020) are Unicode category Zs (separator), not P or S, so normalizeFSTToken leaves them intact.
		// Each word is normalized separately via groupPiecesIntoWords, then words are joined with no separator —
		// that's where "Stockton on Tees" becomes "stocktonontees" (same as "Stockton-on-Tees" after hyphen strip).
		const stockton = normalizeFSTToken("Stockton")
		const on = normalizeFSTToken("on")
		const tees = normalizeFSTToken("Tees")
		expect(stockton + on + tees).toBe("stocktonontees")
	})

	it("preserves diacritics (Álava → álava, not alava)", () => {
		const result = normalizeFSTToken("Álava")
		expect(result).toBe("álava")
	})

	it("strips punctuation including apostrophes (BISHOP'S → bishops)", () => {
		const result = normalizeFSTToken("BISHOP'S")
		expect(result).toBe("bishops")
	})

	it("returns empty string for punctuation-only input", () => {
		const result = normalizeFSTToken("...")
		expect(result).toBe("")
	})

	it("returns empty string for empty input", () => {
		const result = normalizeFSTToken("")
		expect(result).toBe("")
	})

	it("applies NFKC normalization (ligatures and compatibility forms)", () => {
		// NFKC unifies compatibility forms; for example, the NFKC form resolves superscript
		// and subscript characters to their base forms.
		const result = normalizeFSTToken("ﬁnance") // 'ﬁ' is U+FB01 (fi ligature)
		expect(result).toBe("finance")
	})
})

describe("groupPiecesIntoWords with normalizeFSTToken", () => {
	it("normalizes individual word groups correctly", () => {
		const pieces = [{ piece: "▁Stockton" }, { piece: "-" }, { piece: "▁on" }, { piece: "-" }, { piece: "▁Tees" }]
		const groups = groupPiecesIntoWords(pieces)
		// Whitespace-delimited grouping; hyphens are punctuation, so they form separate empty groups
		const nonEmptyGroups = groups.filter((g) => g.fstToken !== "")
		expect(nonEmptyGroups.map((g) => g.fstToken)).toEqual(["stockton", "on", "tees"])
	})

	it("normalizes diacritics consistently in grouped words", () => {
		const pieces = [{ piece: "▁Álava" }]
		const groups = groupPiecesIntoWords(pieces)
		expect(groups[0]!.fstToken).toBe("álava")
	})
})

describe("groupPiecesIntoWords — interior punctuation (Critical fix regression, real fixture tokenizer)", () => {
	// Fix-wave regression: interior punctuation (a hyphen/apostrophe with no leading ▁) must continue the
	// current word, never reset it. Before the fix, a punctuation-only piece set `current = null`, and every
	// subsequent piece up to the next ▁ was silently dropped — these five real-tokenizer splits are the
	// reviewer's exact repro cases. See the module docstring's "word boundary is ▁ only" section.

	it('groups "Stockton-on-Tees" into a single word ("stocktonontees"), not a truncated fragment', async () => {
		const tokenizer = await MailwomanTokenizer.loadFromFile(TOKENIZER_MODEL_PATH)
		const { pieces } = tokenizer.encode("Stockton-on-Tees")
		// Real split: ["▁Stock","ton","-","on","-","T","e","es"] — "on"/"Tees" have no leading ▁ and would
		// have been dropped by the pre-fix code the instant it hit the first bare "-".
		const groups = groupPiecesIntoWords(pieces)
		const nonEmptyGroups = groups.filter((g) => g.fstToken !== "")
		expect(nonEmptyGroups.map((g) => g.fstToken)).toEqual(["stocktonontees"])
	})

	it('groups "Ashby-de-la-Zouch" into a single word ("ashbydelazouch")', async () => {
		const tokenizer = await MailwomanTokenizer.loadFromFile(TOKENIZER_MODEL_PATH)
		const { pieces } = tokenizer.encode("Ashby-de-la-Zouch")
		const groups = groupPiecesIntoWords(pieces)
		const nonEmptyGroups = groups.filter((g) => g.fstToken !== "")
		expect(nonEmptyGroups.map((g) => g.fstToken)).toEqual(["ashbydelazouch"])
	})

	it('groups "Weston-super-Mare" into a single word ("westonsupermare")', async () => {
		const tokenizer = await MailwomanTokenizer.loadFromFile(TOKENIZER_MODEL_PATH)
		const { pieces } = tokenizer.encode("Weston-super-Mare")
		const groups = groupPiecesIntoWords(pieces)
		const nonEmptyGroups = groups.filter((g) => g.fstToken !== "")
		expect(nonEmptyGroups.map((g) => g.fstToken)).toEqual(["westonsupermare"])
	})

	it('groups "Bishop\'s Stortford" into two words ("bishops", "stortford") — the apostrophe is absorbed, the space is not', async () => {
		const tokenizer = await MailwomanTokenizer.loadFromFile(TOKENIZER_MODEL_PATH)
		const { pieces } = tokenizer.encode("Bishop's Stortford")
		// Real split: ["▁Bis","hop","'","s","▁St","ort","ford"] — the apostrophe (no leading ▁) continues
		// "Bishop", the following ▁St closes it and opens a genuinely new word.
		const groups = groupPiecesIntoWords(pieces)
		const nonEmptyGroups = groups.filter((g) => g.fstToken !== "")
		expect(nonEmptyGroups.map((g) => g.fstToken)).toEqual(["bishops", "stortford"])
	})

	it('groups "Stoke-on-Trent" into a single word ("stokeontrent")', async () => {
		const tokenizer = await MailwomanTokenizer.loadFromFile(TOKENIZER_MODEL_PATH)
		const { pieces } = tokenizer.encode("Stoke-on-Trent")
		const groups = groupPiecesIntoWords(pieces)
		const nonEmptyGroups = groups.filter((g) => g.fstToken !== "")
		expect(nonEmptyGroups.map((g) => g.fstToken)).toEqual(["stokeontrent"])
	})

	it('documents the fixture-vocab residual: "Stockton on the Forest" still loses "on"', async () => {
		// NOT part of the Critical fix — this is the reviewer's Important #2 case. The real fixture-tokenizer
		// split is ["▁Stock","ton","▁","on","▁the","▁Forest"]: a BARE "▁" piece (a lone space with no other
		// content) closes "Stockton", and the following "on" carries no leading ▁ of its own (this small test
		// vocab never learned a merged "▁on" piece). "on" has nothing to attach to and is dropped — not by the
		// interior-punctuation bug (there's no punctuation here at all), but because an alnum piece with no
		// leading ▁ and no active word can't principled-ly start one. A production-scale vocab merges common
		// short words like "on" into a neighbouring ▁-piece as a matter of course, so this is a fixture-vocab
		// artifact, not a design gap — see the `groupPiecesIntoWords` docstring's "Known residual" section and
		// the fix-wave report.
		const tokenizer = await MailwomanTokenizer.loadFromFile(TOKENIZER_MODEL_PATH)
		const { pieces } = tokenizer.encode("Stockton on the Forest")
		const groups = groupPiecesIntoWords(pieces)
		const nonEmptyGroups = groups.filter((g) => g.fstToken !== "")
		expect(nonEmptyGroups.map((g) => g.fstToken)).toEqual(["stockton", "the", "forest"])
	})

	it('still yields ["stockton", "", "lancashire"]-shaped groups for "Stockton , Lancashire" (comma stands alone, no fusion)', async () => {
		const tokenizer = await MailwomanTokenizer.loadFromFile(TOKENIZER_MODEL_PATH)
		const { pieces } = tokenizer.encode("Stockton , Lancashire")
		// Real split: ["▁Stock","ton","▁",",","▁Lan","ca","shire"] — the space before the comma tokenizes as
		// its own bare "▁" piece, and the comma itself (no leading ▁, no active word) stands alone too. Two
		// raw empty groups land between "Stockton" and "Lancashire" rather than one, but the property that
		// matters — the two real words never fuse into a single group/window — holds either way.
		const groups = groupPiecesIntoWords(pieces)
		expect(groups.filter((g) => g.fstToken === "")).toHaveLength(2)
		const nonEmptyGroups = groups.filter((g) => g.fstToken !== "")
		expect(nonEmptyGroups.map((g) => g.fstToken)).toEqual(["stockton", "lancashire"])
	})
})
