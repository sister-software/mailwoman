import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers"
import { workspacePath } from "@mailwoman/core/paths"
import {
	buildFSTEmissionPriors,
	collapseFSTBias,
	groupPiecesIntoWords,
	isStreetShapedSurface,
	normalizeFSTToken,
	type FSTMatcherLike,
	type FSTMatchLike,
	type FSTPlaceEntryLike,
} from "@mailwoman/neural/fst-prior"
import { STAGE2_BIO_LABELS } from "@mailwoman/neural/labels"
import { MailwomanTokenizer } from "@mailwoman/neural/tokenizer"
import { describe, expect, it, test } from "vitest"

const TOKENIZER_MODEL_PATH = workspacePath("neural", "test", "fixtures", "tokenizer-v0.1.0.model")

const PRODUCTION_TOKENIZER_PATH = dataRootPath("models", "tokenizer", "v0.9.0-multisplice", "tokenizer.model")
const haveProductionTokenizer = await pathExists(PRODUCTION_TOKENIZER_PATH)

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
		const fst = mockFST(new Map([["portland", [{ wofID: 1, placetype: "locality", referential: 0.72 }]]]))
		const pieces = makePieces("Portland")
		const matrix = buildFSTEmissionPriors(fst, pieces, STAGE2_BIO_LABELS)
		expect(matrix[0]![labelCol("B-locality")]).toBeCloseTo(0.72 * 3, 2)
		expect(matrix[0]![labelCol("B-street")]).toBeLessThan(0)
	})

	it("biases multi-word place names with B/I convention", () => {
		const fst = mockFST(
			new Map([
				["new", []],
				[
					"new york",
					[
						{ wofID: 2, placetype: "locality", referential: 0.95 },
						{ wofID: 3, placetype: "region", referential: 0.85 },
					],
				],
			])
		)

		const pieces = makePieces("New York")
		const matrix = buildFSTEmissionPriors(fst, pieces, STAGE2_BIO_LABELS)

		expect(matrix[0]![labelCol("B-locality")]).toBeCloseTo(0.95 * 3, 2)
		expect(matrix[1]![labelCol("I-locality")]).toBeCloseTo(0.95 * 3, 2)
		expect(matrix[0]![labelCol("B-region")]).toBeCloseTo(0.85 * 3, 2)
		expect(matrix[0]![labelCol("B-locality")]).toBeGreaterThan(matrix[0]![labelCol("B-region")]!)
	})

	it("low importance produces proportionally lower bias", () => {
		const fst = mockFST(new Map([["hamlet", [{ wofID: 4, placetype: "locality", referential: 0.05 }]]]))
		const pieces = makePieces("Hamlet")
		const matrix = buildFSTEmissionPriors(fst, pieces, STAGE2_BIO_LABELS)
		expect(matrix[0]![labelCol("B-locality")]).toBeCloseTo(0.15, 2)
	})

	it("does not bias unmapped placetypes (county)", () => {
		const fst = mockFST(new Map([["cook", [{ wofID: 5, placetype: "county", referential: 0.88 }]]]))
		const pieces = makePieces("Cook")
		const matrix = buildFSTEmissionPriors(fst, pieces, STAGE2_BIO_LABELS)

		for (const row of matrix) {
			expect(row.every((v) => v === 0)).toBe(true)
		}
	})

	it("Handles subword pieces correctly", () => {
		const fst = mockFST(new Map([["springfield", [{ wofID: 6, placetype: "locality", referential: 0.45 }]]]))

		const pieces = [
			{ piece: "▁Spring", start: 0, end: 6 },
			{ piece: "field", start: 6, end: 11 },
		]

		const matrix = buildFSTEmissionPriors(fst, pieces, STAGE2_BIO_LABELS)
		expect(matrix[0]![labelCol("B-locality")]).toBeCloseTo(0.45 * 3, 2)
		expect(matrix[1]![labelCol("I-locality")]).toBeCloseTo(0.45 * 3, 2)
	})

	it("folds trailing punctuation into the preceding word's bias, not into a separate placeholder", () => {
		const fst = mockFST(new Map([["washington", [{ wofID: 7, placetype: "locality", referential: 0.85 }]]]))

		const pieces = [
			{ piece: "▁Washington", start: 0, end: 10 },
			{ piece: ",", start: 10, end: 11 },
			{ piece: "▁DC", start: 12, end: 14 },
		]

		const matrix = buildFSTEmissionPriors(fst, pieces, STAGE2_BIO_LABELS)
		expect(matrix[0]![labelCol("B-locality")]).toBeCloseTo(0.85 * 3, 2)

		expect(matrix[1]![labelCol("I-locality")]).toBeCloseTo(0.85 * 3, 2)

		expect(matrix[2]!.every((v) => v === 0)).toBe(true)
	})

	it("Length-scales street suppression for a single-token match (default `suppression` mode), positive bias intact", () => {
		const fst = mockFST(new Map([["sweeney", [{ wofID: 9, placetype: "locality", referential: 0.5 }]]]))
		const pieces = makePieces("Sweeney")
		const supp = buildFSTEmissionPriors(fst, pieces, STAGE2_BIO_LABELS)

		expect(supp[0]![labelCol("B-locality")]).toBeCloseTo(0.5 * 3, 2)

		expect(supp[0]![labelCol("B-street")]).toBeCloseTo(-1.5 * 0.25, 2)

		const off = buildFSTEmissionPriors(fst, pieces, STAGE2_BIO_LABELS, { importanceLengthScaleMode: "off" })
		expect(off[0]![labelCol("B-street")]).toBeCloseTo(-1.5, 2)
		expect(off[0]![labelCol("B-locality")]).toBeCloseTo(0.5 * 3, 2)
		const both = buildFSTEmissionPriors(fst, pieces, STAGE2_BIO_LABELS, { importanceLengthScaleMode: "both" })
		expect(both[0]![labelCol("B-locality")]).toBeCloseTo(0.5 * 3 * 0.25, 2)
	})
})

describe("BuildFSTEmissionPriors — street-context check (syntactic context only, never importance magnitude)", () => {
	const gazetteer = () =>
		mockFST(
			new Map([
				["washington", [{ wofID: 10, placetype: "locality", referential: 0.8 }]],
				["new", []],
				["new york", [{ wofID: 11, placetype: "locality", referential: 0.95 }]],
			])
		)

	const morphology = () =>
		mockFST(
			new Map([
				["blvd", [{ wofID: 900, placetype: "street_affix", referential: 0 }]],
				["rue", [{ wofID: 901, placetype: "street_affix", referential: 0 }]],
				["ave", [{ wofID: 902, placetype: "street_affix", referential: 0 }]],
			])
		)

	it("Suffix adjacency ('Washington Blvd') scales the positive bias ×0.25 (default); suppression keeps length-scaling", () => {
		const pieces = makePieces("Washington Blvd")

		const conditional = buildFSTEmissionPriors(gazetteer(), pieces, STAGE2_BIO_LABELS, {
			streetContext: { fst: morphology() },
		})

		expect(conditional[0]![labelCol("B-locality")]).toBeCloseTo(0.8 * 3 * 0.25, 2)

		expect(conditional[0]![labelCol("B-street")]).toBeCloseTo(-1.5 * 0.25, 2)

		expect(conditional[1]!.every((v) => v === 0)).toBe(true)
	})

	it("prefix adjacency ('Rue Washington', FR shape) scales the positive bias", () => {
		const pieces = makePieces("Rue Washington")

		const conditional = buildFSTEmissionPriors(gazetteer(), pieces, STAGE2_BIO_LABELS, {
			streetContext: { fst: morphology() },
		})

		expect(conditional[1]![labelCol("B-locality")]).toBeCloseTo(0.8 * 3 * 0.25, 2)
	})

	it("House-number left ('500 Washington') scales the positive bias — 'the house number is the license'", () => {
		const pieces = makePieces("500 Washington")

		const conditional = buildFSTEmissionPriors(gazetteer(), pieces, STAGE2_BIO_LABELS, {
			streetContext: { fst: morphology() },
		})

		expect(conditional[1]![labelCol("B-locality")]).toBeCloseTo(0.8 * 3 * 0.25, 2)
	})

	it("multi-token match with street adjacency ('New York Ave') scales the positive bias on the whole span", () => {
		const pieces = makePieces("New York Ave")

		const conditional = buildFSTEmissionPriors(gazetteer(), pieces, STAGE2_BIO_LABELS, {
			streetContext: { fst: morphology() },
		})

		expect(conditional[0]![labelCol("B-locality")]).toBeCloseTo(0.95 * 3 * 0.25, 2)
		expect(conditional[1]![labelCol("I-locality")]).toBeCloseTo(0.95 * 3 * 0.25, 2)
	})

	it("'Washington' alone → full boost, BYTE-IDENTICAL to the unrestricted run (default-safe asymmetry)", () => {
		const pieces = makePieces("Washington")
		const unrestricted = buildFSTEmissionPriors(gazetteer(), pieces, STAGE2_BIO_LABELS)

		const conditional = buildFSTEmissionPriors(gazetteer(), pieces, STAGE2_BIO_LABELS, {
			streetContext: { fst: morphology() },
		})

		expect(conditional).toEqual(unrestricted)
		expect(conditional[0]![labelCol("B-locality")]).toBeCloseTo(0.8 * 3, 2)
	})

	it("'Washington DC' → adjacent region, check silent → full boost, byte-identical to unrestricted", () => {
		const pieces = makePieces("Washington DC")
		const unrestricted = buildFSTEmissionPriors(gazetteer(), pieces, STAGE2_BIO_LABELS)

		const conditional = buildFSTEmissionPriors(gazetteer(), pieces, STAGE2_BIO_LABELS, {
			streetContext: { fst: morphology() },
		})

		expect(conditional).toEqual(unrestricted)
		expect(conditional[0]![labelCol("B-locality")]).toBeCloseTo(0.8 * 3, 2)
	})

	it("No street context anywhere in the parse → whole matrix byte-identical to unrestricted", () => {
		const pieces = makePieces("Hello Washington Goodbye")
		const unrestricted = buildFSTEmissionPriors(gazetteer(), pieces, STAGE2_BIO_LABELS)

		const conditional = buildFSTEmissionPriors(gazetteer(), pieces, STAGE2_BIO_LABELS, {
			streetContext: { fst: morphology() },
		})

		expect(conditional).toEqual(unrestricted)
	})

	it("custom positiveScale is honored (tuning range 0.15–0.4)", () => {
		const pieces = makePieces("Washington Blvd")

		const conditional = buildFSTEmissionPriors(gazetteer(), pieces, STAGE2_BIO_LABELS, {
			streetContext: { fst: morphology(), positiveScale: 0.15 },
		})

		expect(conditional[0]![labelCol("B-locality")]).toBeCloseTo(0.8 * 3 * 0.15, 2)
	})
})

describe("normalizeFSTToken", () => {
	it("Lowercases and strips hyphens (Stockton-on-Tees → stocktonontees)", () => {
		const result = normalizeFSTToken("Stockton-on-Tees")
		expect(result).toBe("stocktonontees")
	})

	it("leaves spaces intact (Zs, not punctuation) — hyphen/space equivalence comes from the caller's split-then-join", () => {
		const stockton = normalizeFSTToken("Stockton")
		const on = normalizeFSTToken("on")
		const tees = normalizeFSTToken("Tees")
		expect(stockton + on + tees).toBe("stocktonontees")
	})

	it("Preserves diacritics (Álava → álava, not alava)", () => {
		const result = normalizeFSTToken("Álava")
		expect(result).toBe("álava")
	})

	it("Strips punctuation including apostrophes (BISHOP'S → bishops)", () => {
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
		const result = normalizeFSTToken("ﬁnance")
		expect(result).toBe("finance")
	})
})

describe("groupPiecesIntoWords with normalizeFSTToken", () => {
	it("Normalizes individual word groups correctly", () => {
		const pieces = [{ piece: "▁Stockton" }, { piece: "-" }, { piece: "▁on" }, { piece: "-" }, { piece: "▁Tees" }]
		const groups = groupPiecesIntoWords(pieces)

		const nonEmptyGroups = groups.filter((g) => g.fstToken !== "")
		expect(nonEmptyGroups.map((g) => g.fstToken)).toEqual(["stockton", "on", "tees"])
	})

	it("normalizes diacritics consistently in grouped words", () => {
		const pieces = [{ piece: "▁Álava" }]
		const groups = groupPiecesIntoWords(pieces)
		expect(groups[0]!.fstToken).toBe("álava")
	})
})

describe("groupPiecesIntoWords — interior punctuation (real fixture tokenizer)", () => {
	it('groups "Stockton-on-Tees" into a single word ("stocktonontees"), not a truncated fragment', async () => {
		const tokenizer = await MailwomanTokenizer.loadFromFile(TOKENIZER_MODEL_PATH)
		const { pieces } = tokenizer.encode("Stockton-on-Tees")

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

	it('recovers "on" in "Stockton on the Forest" via pending-word-start', async () => {
		const tokenizer = await MailwomanTokenizer.loadFromFile(TOKENIZER_MODEL_PATH)
		const { pieces } = tokenizer.encode("Stockton on the Forest")
		const groups = groupPiecesIntoWords(pieces)
		const nonEmptyGroups = groups.filter((g) => g.fstToken !== "")
		expect(nonEmptyGroups.map((g) => g.fstToken)).toEqual(["stockton", "on", "the", "forest"])
	})

	it('Still yields ["stockton", "", "lancashire"]-shaped groups for "Stockton, Lancashire" (comma stands alone without fusion)', async () => {
		const tokenizer = await MailwomanTokenizer.loadFromFile(TOKENIZER_MODEL_PATH)
		const { pieces } = tokenizer.encode("Stockton , Lancashire")

		const groups = groupPiecesIntoWords(pieces)
		expect(groups.filter((g) => g.fstToken === "")).toHaveLength(2)
		const nonEmptyGroups = groups.filter((g) => g.fstToken !== "")
		expect(nonEmptyGroups.map((g) => g.fstToken)).toEqual(["stockton", "lancashire"])
	})
})

describe("groupPiecesIntoWords — byte-fallback placeholder never leaks into fstToken (paired-punctuation audit)", () => {
	it('Folds "{Block C}, Leeds" to clean words without "0x7b"/"0x7d" garbage', async () => {
		const tokenizer = await MailwomanTokenizer.loadFromFile(TOKENIZER_MODEL_PATH)
		const { pieces } = tokenizer.encode("{Block C}, Leeds")
		const groups = groupPiecesIntoWords(pieces)
		const nonEmptyGroups = groups.filter((g) => g.fstToken !== "")
		expect(nonEmptyGroups.map((g) => g.fstToken)).toEqual(["block", "c", "leeds"])
	})

	it('Folds curly-quoted "“The Grange”, Fishburn" the SAME as straight-quoted (neither hex garbage nor dropped word)', async () => {
		const tokenizer = await MailwomanTokenizer.loadFromFile(TOKENIZER_MODEL_PATH)
		const { pieces } = tokenizer.encode("“The Grange”, Fishburn")
		const groups = groupPiecesIntoWords(pieces)
		const nonEmptyGroups = groups.filter((g) => g.fstToken !== "")
		expect(nonEmptyGroups.map((g) => g.fstToken)).toEqual(["the", "grange", "fishburn"])
	})

	it('folds guillemet-quoted "«The Grange», Fishburn" the same way', async () => {
		const tokenizer = await MailwomanTokenizer.loadFromFile(TOKENIZER_MODEL_PATH)
		const { pieces } = tokenizer.encode("«The Grange», Fishburn")
		const groups = groupPiecesIntoWords(pieces)
		const nonEmptyGroups = groups.filter((g) => g.fstToken !== "")
		expect(nonEmptyGroups.map((g) => g.fstToken)).toEqual(["the", "grange", "fishburn"])
	})
})

describe.skipIf(!haveProductionTokenizer)(
	"groupPiecesIntoWords — bare-▁-orphan recovery, PRODUCTION tokenizer vocabulary",
	() => {
		const cases: Array<{ raw: string; expected: string[] }> = [
			{ raw: "Stockton on the Forest", expected: ["stockton", "on", "the", "forest"] },
			{ raw: "Newcastle upon Tyne", expected: ["newcastle", "upon", "tyne"] },
			{ raw: "Weston super Mare", expected: ["weston", "super", "mare"] },
			{ raw: "Kingston upon Hull", expected: ["kingston", "upon", "hull"] },
			{ raw: "123 Main Street, Springfield, IL", expected: ["123", "main", "street", "springfield", "il"] },
		]

		test.each(cases)("$raw → $expected", async ({ raw, expected }) => {
			const tokenizer = await MailwomanTokenizer.loadFromFile(PRODUCTION_TOKENIZER_PATH)
			const { pieces } = tokenizer.encode(raw)
			const groups = groupPiecesIntoWords(pieces)
			const nonEmptyGroups = groups.filter((g) => g.fstToken !== "")
			expect(nonEmptyGroups.map((g) => g.fstToken)).toEqual(expected)
		})
	}
)

describe("Street-shaped surface check on the C4 mapped tiers", () => {
	test.each([
		[["king", "street", "east"], true],
		[["king", "street", "west"], true],
		[["madison", "square"], true],
		[["8th", "avenue", "south"], true],
		[["valencia", "road"], true],

		[["biggin", "hill"], false],
		[["soho"], false],
		[["camden", "town"], false],

		[["square"], false],
		[["street"], false],
		[["square", "west"], false],
		[["east"], false],
		[[], false],
	])("isStreetShapedSurface(%j) = %s", (tokens, expected) => {
		expect(isStreetShapedSurface(tokens as string[])).toBe(expected)
	})

	it("a neighbourhood entry on a street-shaped surface draws no locality bias", () => {
		const fst = mockFST(
			new Map([
				["king", []],
				["king street", []],
				["king street east", [{ wofID: 9, placetype: "neighbourhood", referential: 0.8 }]],
			])
		)

		const pieces = makePieces("King Street East")
		const matrix = buildFSTEmissionPriors(fst, pieces, STAGE2_BIO_LABELS)

		for (const row of matrix) {
			expect(row[labelCol("B-locality")]).toBe(0)
			expect(row[labelCol("I-locality")]).toBe(0)
		}
	})

	it("a DIRECT locality entry on the same street-shaped surface still biases", () => {
		const fst = mockFST(
			new Map([
				["king", []],
				["king street", []],
				["king street east", [{ wofID: 10, placetype: "locality", referential: 0.8 }]],
			])
		)

		const pieces = makePieces("King Street East")
		const matrix = buildFSTEmissionPriors(fst, pieces, STAGE2_BIO_LABELS)

		expect(matrix[0]![labelCol("B-locality")]).toBeGreaterThan(0)
	})

	it("the Biggin Hill class keeps its mapped-tier bias", () => {
		const fst = mockFST(
			new Map([
				["biggin", []],
				["biggin hill", [{ wofID: 11, placetype: "neighbourhood", referential: 0.7 }]],
			])
		)

		const pieces = makePieces("Biggin Hill")
		const matrix = buildFSTEmissionPriors(fst, pieces, STAGE2_BIO_LABELS)

		expect(matrix[0]![labelCol("B-locality")]).toBeGreaterThan(0)
		expect(matrix[1]![labelCol("I-locality")]).toBeGreaterThan(0)
	})

	it("collapseFSTBias applies the same check through its surface parameter", () => {
		const entries = [{ placetype: "neighbourhood", importance: 0.8 }]

		expect(collapseFSTBias(entries, ["king", "street", "east"]).size).toBe(0)
		expect(collapseFSTBias(entries, ["biggin", "hill"]).get("locality")).toBeCloseTo(0.8, 5)
	})
})
