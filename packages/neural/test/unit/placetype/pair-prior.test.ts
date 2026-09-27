import { COMPONENT_TAGS, type ComponentTag } from "@mailwoman/codex/component"
import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers"
import { stringifyJSON } from "@mailwoman/core/json"
import { workspacePath } from "@mailwoman/core/paths"
import { STAGE2_BIO_LABELS } from "@mailwoman/neural/labels"
import {
	PairIndexResolver,
	serializePairIndex,
	type PairIndexEntry,
	type PairIndexHeaderInput,
	type PairIndexLike,
} from "@mailwoman/neural/pair"
import { buildPlacetypePairPriors, type PlacetypePairProbeTrace } from "@mailwoman/neural/placetype"
import { MailwomanTokenizer } from "@mailwoman/neural/tokenizer"
import { describe, expect, it, test } from "vitest"

const LABELS = STAGE2_BIO_LABELS

const FIXTURE_TOKENIZER_PATH = workspacePath("neural", "test", "fixtures", "tokenizer-v0.1.0.model")

const PRODUCTION_TOKENIZER_PATH = dataRootPath("models", "tokenizer", "v0.9.0-multisplice", "tokenizer.model")
const haveProductionTokenizer = await pathExists(PRODUCTION_TOKENIZER_PATH)

function labelCol(label: string): number {
	return LABELS.indexOf(label as (typeof LABELS)[number])
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

function makePiecesWithCommas(text: string): Array<{ piece: string; start: number; end: number }> {
	const tokens = text.match(/[^\s,]+|,/g) ?? []
	const pieces: Array<{ piece: string; start: number; end: number }> = []
	let cursor = 0

	for (const tok of tokens) {
		const start = text.indexOf(tok, cursor)
		const end = start + tok.length

		pieces.push({ piece: tok === "," ? "," : `▁${tok}`, start, end })
		cursor = end
	}

	return pieces
}

function asComponentTag(value: string | undefined): ComponentTag {
	const tag = COMPONENT_TAGS.find((candidate) => candidate === value)

	if (!tag) throw new Error(`fixture names ${stringifyJSON(value)}, which is not a ComponentTag`)

	return tag
}

function mockPairIndex(
	entries: Record<string, string>,
	delta?: number,
	transitionBeta?: number,
	country?: string,
	parentDelta?: number
): PairIndexLike & { calls: Array<[string, string]> } {
	const calls: Array<[string, string]> = []

	return {
		delta,
		transitionBeta,
		country,
		parentDelta,
		calls,
		probe(child: string, parent: string) {
			calls.push([child, parent])

			const spec = entries[`${child}|${parent}`]

			if (spec === undefined) return undefined

			const [tag, parentTag = "locality"] = spec.split(">")

			return { tag: asComponentTag(tag), parentTag: asComponentTag(parentTag) }
		},
	}
}

describe("buildPlacetypePairPriors — absence cases", () => {
	it("returns a zero matrix when opts is undefined (no configured index — default OFF)", () => {
		const pieces = makePieces("shoreditch london")
		const { matrix } = buildPlacetypePairPriors(undefined, pieces, LABELS)

		expect(matrix).toHaveLength(2)

		for (const row of matrix) {
			expect(row.every((v) => v === 0)).toBe(true)
		}
	})

	it("returns a zero matrix when the index is present but never matches (no country data for this locale)", () => {
		const index = mockPairIndex({})
		const pieces = makePieces("shoreditch london")
		const { matrix } = buildPlacetypePairPriors({ index, probeMode: "window" }, pieces, LABELS)

		for (const row of matrix) {
			expect(row.every((v) => v === 0)).toBe(true)
		}

		expect(index.calls.length).toBeGreaterThan(0)
	})
})

describe("buildPlacetypePairPriors — window-key fold (space-join rather than concatenation)", () => {
	it('probes a 2-word window as "st helens" (space-joined), never "sthelens"', async () => {
		const tokenizer = await MailwomanTokenizer.loadFromFile(
			workspacePath("neural", "test", "fixtures", "tokenizer-v0.1.0.model")
		)

		const { pieces } = tokenizer.encode("St Helens Lancashire")
		const index = mockPairIndex({ "st helens|lancashire": "dependent_locality" }, 6)

		const { matrix } = buildPlacetypePairPriors({ index, probeMode: "window" }, pieces, LABELS)

		expect(index.calls.some(([child]) => child === "st helens")).toBe(true)
		expect(index.calls.some(([child]) => child === "sthelens")).toBe(false)

		expect(matrix[0]![labelCol("B-dependent_locality")]).toBe(6)
	})
})

describe("buildPlacetypePairPriors — matrix-cell exactness", () => {
	it("biases the child window's B-tag (first piece) / I-tag (rest) toward the resolved tag", () => {
		const index = mockPairIndex({ "shoreditch|london": "dependent_locality" }, 6)
		const pieces = makePieces("shoreditch london")
		const { matrix } = buildPlacetypePairPriors({ index, probeMode: "window" }, pieces, LABELS)

		expect(matrix[0]![labelCol("B-dependent_locality")]).toBe(6)

		expect(matrix[0]!.filter((v) => v !== 0)).toHaveLength(1)

		expect(matrix[1]!.every((v) => v === 0)).toBe(true)
	})

	it("writes B- on the first piece and I- on every subsequent piece of a multi-piece window", () => {
		const index = mockPairIndex({ "new york|ny": "locality" }, 4)
		const pieces = makePieces("new york ny")
		const { matrix } = buildPlacetypePairPriors({ index, probeMode: "window" }, pieces, LABELS)

		expect(matrix[0]![labelCol("B-locality")]).toBe(4)
		expect(matrix[1]![labelCol("I-locality")]).toBe(4)
	})

	it("resolves the bias magnitude from index.delta, falling back to biasScale when delta is absent", () => {
		const withDelta = mockPairIndex({ "shoreditch|london": "dependent_locality" }, 6)
		const withoutDelta = mockPairIndex({ "shoreditch|london": "dependent_locality" }, undefined)
		const pieces = makePieces("shoreditch london")

		const { matrix: a } = buildPlacetypePairPriors(
			{ index: withDelta, biasScale: 9.9, probeMode: "window" },
			pieces,
			LABELS
		)

		const { matrix: b } = buildPlacetypePairPriors(
			{ index: withoutDelta, biasScale: 2.5, probeMode: "window" },
			pieces,
			LABELS
		)

		expect(a[0]![labelCol("B-dependent_locality")]).toBe(6)
		expect(b[0]![labelCol("B-dependent_locality")]).toBe(2.5)
	})
})

describe("buildPlacetypePairPriors — comma-free multi-word parent (3-word window, N=3)", () => {
	it('matches child "fishburn" against the 3-word parent window "stockton on tees"', () => {
		const index = mockPairIndex({ "fishburn|stockton on tees": "dependent_locality" }, 6)
		const pieces = makePieces("fishburn stockton on tees")
		const { matrix } = buildPlacetypePairPriors({ index, probeMode: "window" }, pieces, LABELS)

		expect(matrix[0]![labelCol("B-dependent_locality")]).toBe(6)

		expect(matrix[1]!.every((v) => v === 0)).toBe(true)
		expect(matrix[2]!.every((v) => v === 0)).toBe(true)
		expect(matrix[3]!.every((v) => v === 0)).toBe(true)
	})
})

describe("buildPlacetypePairPriors — marker suppression", () => {
	it('suppresses a window immediately followed by a structural marker ("road") — no bias even though it would match', () => {
		const index = mockPairIndex({ "church|sometown": "dependent_locality" }, 6)
		const pieces = makePieces("church road sometown")
		const { matrix } = buildPlacetypePairPriors({ index, probeMode: "window" }, pieces, LABELS)

		expect(matrix[0]!.every((v) => v === 0)).toBe(true)
	})

	it("the SAME child/parent pair DOES bias when no marker sits between them", () => {
		const index = mockPairIndex({ "church|sometown": "dependent_locality" }, 6)
		const pieces = makePieces("church sometown")
		const { matrix } = buildPlacetypePairPriors({ index, probeMode: "window" }, pieces, LABELS)

		expect(matrix[0]![labelCol("B-dependent_locality")]).toBe(6)
	})

	it("suppresses a window immediately followed by a house-number-shaped token", () => {
		const index = mockPairIndex({ "flat|sometown": "dependent_locality" }, 6)
		const pieces = makePieces("flat 5 sometown")
		const { matrix } = buildPlacetypePairPriors({ index, probeMode: "window" }, pieces, LABELS)

		expect(matrix[0]!.every((v) => v === 0)).toBe(true)
	})
})

describe("buildPlacetypePairPriors — dual-key probe (hyphen/space cross-form)", () => {
	it("matches a concat-keyed index entry from a space-written multi-word window (Fix 2)", () => {
		const index = mockPairIndex({ "fishburn|stocktonontees": "dependent_locality" }, 6)
		const pieces = makePieces("fishburn stockton on tees")
		const { matrix } = buildPlacetypePairPriors({ index, probeMode: "window" }, pieces, LABELS)

		expect(matrix[0]![labelCol("B-dependent_locality")]).toBe(6)

		expect(index.calls).toContainEqual(["fishburn", "stockton on tees"])
		expect(index.calls).toContainEqual(["fishburn", "stocktonontees"])
	})

	it("a hyphen-written query (single word-group post Fix-1) matches the same concat-keyed entry directly", async () => {
		const tokenizer = await MailwomanTokenizer.loadFromFile(
			workspacePath("neural", "test", "fixtures", "tokenizer-v0.1.0.model")
		)

		const { pieces } = tokenizer.encode("Fishburn Stockton-on-Tees")
		const index = mockPairIndex({ "fishburn|stocktonontees": "dependent_locality" }, 6)
		const { matrix } = buildPlacetypePairPriors({ index, probeMode: "window" }, pieces, LABELS)

		expect(matrix[0]![labelCol("B-dependent_locality")]).toBe(6)
	})
})

describe("BuildPlacetypePairPriors — marker-scope regression (Fix 3, reviewer Important)", () => {
	it("suppression is CHILD-role-only: a marker word does NOT suppress a window it appears in as the PARENT", () => {
		const index = mockPairIndex({ "sometown|ashworth": "dependent_locality" }, 6)
		const pieces = makePieces("sometown Ashworth House")
		const { matrix } = buildPlacetypePairPriors({ index, probeMode: "window" }, pieces, LABELS)

		expect(matrix[0]![labelCol("B-dependent_locality")]).toBe(6)

		expect(index.calls).toContainEqual(["sometown", "ashworth"])
	})

	it('suppression STILL applies to the CHILD role: "Ashworth" followed by "House" is never probed as a child', () => {
		const index = mockPairIndex({ "ashworth|sometown": "dependent_locality" }, 6)
		const pieces = makePieces("Ashworth House sometown")
		const { matrix } = buildPlacetypePairPriors({ index, probeMode: "window" }, pieces, LABELS)

		expect(matrix[0]!.every((v) => v === 0)).toBe(true)
		expect(index.calls.some(([child]) => child === "ashworth")).toBe(false)
	})
})

describe("buildPlacetypePairPriors — disjointness", () => {
	it("Never pairs two OVERLAPPING candidate windows, even when the index has an entry for that exact pair", () => {
		const index = mockPairIndex({ "a b|b c": "locality" }, 6)
		const pieces = makePieces("a b c")
		const { matrix } = buildPlacetypePairPriors({ index, probeMode: "window" }, pieces, LABELS)

		for (const row of matrix) {
			expect(row.every((v) => v === 0)).toBe(true)
		}
	})
})

describe("buildPlacetypePairPriors — dual-key tie-break", () => {
	it("prefers the space-joined form when it and the concatenated form would resolve to DIFFERENT tags", () => {
		const index = mockPairIndex({ "x|a b": "locality", "x|ab": "region" }, 6)
		const pieces = makePieces("x a b")
		const { matrix } = buildPlacetypePairPriors({ index, probeMode: "window" }, pieces, LABELS)

		expect(matrix[0]![labelCol("B-locality")]).toBe(6)
		expect(matrix[0]![labelCol("B-region")]).toBe(0)

		expect(index.calls).toContainEqual(["x", "a b"])
		expect(index.calls).not.toContainEqual(["x", "ab"])
	})
})

describe("BuildPlacetypePairPriors — end-to-end cross-form regression (real PIX1 round trip)", () => {
	const REAL_BUILDER_ENTRIES: PairIndexEntry[] = [
		{ child: "fishburn", parent: "stocktonontees", tag: "dependent_locality", parentTag: "locality" },
	]

	const REAL_HEADER: PairIndexHeaderInput = {
		country: "gb",
		delta: 6,
		foldVersion: 1,
		sourceMD5s: [],
		buildDate: "2026-07-22",
	}

	it('a space-typed query ("Fishburn Stockton on Tees") resolves against the hyphen-folded real index entry, fixture tokenizer', async () => {
		const bytes = serializePairIndex(REAL_HEADER, REAL_BUILDER_ENTRIES)
		const index = new PairIndexResolver(bytes)

		const tokenizer = await MailwomanTokenizer.loadFromFile(FIXTURE_TOKENIZER_PATH)

		const { pieces } = tokenizer.encode("Fishburn Stockton on Tees")
		const { matrix } = buildPlacetypePairPriors({ index, probeMode: "window" }, pieces, LABELS)

		expect(matrix[0]![labelCol("B-dependent_locality")]).toBe(6)
	})

	test.skipIf(!haveProductionTokenizer)(
		'a space-typed query ("Fishburn Stockton on Tees") resolves against the same real index entry, PRODUCTION tokenizer',
		async () => {
			const bytes = serializePairIndex(REAL_HEADER, REAL_BUILDER_ENTRIES)
			const index = new PairIndexResolver(bytes)

			const tokenizer = await MailwomanTokenizer.loadFromFile(PRODUCTION_TOKENIZER_PATH)

			const { pieces } = tokenizer.encode("Fishburn Stockton on Tees")
			const { matrix } = buildPlacetypePairPriors({ index, probeMode: "window" }, pieces, LABELS)

			expect(matrix[0]![labelCol("B-dependent_locality")]).toBe(6)
		}
	)
})

describe("buildPlacetypePairPriors — segment mode (the v1 default, now the ≥2-segment leg of the auto chain)", () => {
	it('A venue-EMBEDDED name does NOT fire — "Queens Park Academy" (one segment without internal comma) never reduces to the census child "queens park"', () => {
		const index = mockPairIndex({ "queens park|chester": "dependent_locality" }, 6)
		const text = "Queens Park Academy, Chestnut Avenue, Chester"
		const pieces = makePiecesWithCommas(text)

		const { matrix } = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		for (const row of matrix) {
			expect(row.every((v) => v === 0)).toBe(true)
		}

		expect(index.calls.some(([child]) => child === "queens park")).toBe(false)
	})

	it("a segment-EXACT name DOES fire — a bare census child occupying its own comma-delimited field", () => {
		const index = mockPairIndex({ "moelfre|abergele": "dependent_locality" }, 6)
		const text = "Moelfre, Abergele"
		const pieces = makePiecesWithCommas(text)
		const { matrix } = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		expect(matrix[0]![labelCol("B-dependent_locality")]).toBe(6)
	})

	it("dual-key probe still applies at SEGMENT granularity (hyphen/space cross-form, whole multi-word segment)", () => {
		const index = mockPairIndex({ "fishburn|stocktonontees": "dependent_locality" }, 6)
		const text = "Fishburn, Stockton on Tees"
		const pieces = makePiecesWithCommas(text)
		const { matrix } = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		expect(matrix[0]![labelCol("B-dependent_locality")]).toBe(6)

		expect(index.calls).toContainEqual(["fishburn", "stockton on tees"])
		expect(index.calls).toContainEqual(["fishburn", "stocktonontees"])
	})

	it("comma-free input: explicit segment mode stays inert; the auto default reaches the anchored path; window opt-in unchanged", () => {
		const index = mockPairIndex({ "shoreditch|london": "dependent_locality" }, 6)
		const pieces = makePieces("Shoreditch London")

		const { matrix: segmentMatrix } = buildPlacetypePairPriors({ index, probeMode: "segment" }, pieces, LABELS)

		for (const row of segmentMatrix) {
			expect(row.every((v) => v === 0)).toBe(true)
		}

		const { matrix: autoMatrix } = buildPlacetypePairPriors({ index }, pieces, LABELS)

		expect(autoMatrix[0]![labelCol("B-dependent_locality")]).toBe(6)

		const { matrix: windowMatrix } = buildPlacetypePairPriors({ index, probeMode: "window" }, pieces, LABELS)

		expect(windowMatrix[0]![labelCol("B-dependent_locality")]).toBe(6)
	})
})

describe("BuildPlacetypePairPriors — segment-parent same-field postcode strip", () => {
	it('GB: "Macclesfield SK11 9PD" parent segment folds to "macclesfield" — the pair fires (the fix)', () => {
		const index = mockPairIndex({ "henbury|macclesfield": "dependent_locality" }, 6, undefined, "gb")
		const text = "41 Hightree Drive, Henbury, Macclesfield SK11 9PD"

		const pieces = makePiecesWithCommas(text)
		const { matrix } = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		expect(matrix[4]![labelCol("B-dependent_locality")]).toBe(6)

		expect(index.calls).toContainEqual(["henbury", "macclesfield"])
		expect(index.calls.some(([, parent]) => parent.includes("sk11") || parent.includes("9pd"))).toBe(false)
	})

	it('NZ: "Porirua 5026" parent segment folds to "porirua" — the pair fires (the fix)', () => {
		const index = mockPairIndex({ "plimmerton|porirua": "dependent_locality" }, 6, undefined, "nz")
		const text = "35 Steyne Avenue, Plimmerton, Porirua 5026"

		const pieces = makePiecesWithCommas(text)
		const { matrix } = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		expect(matrix[4]![labelCol("B-dependent_locality")]).toBe(6)
		expect(index.calls).toContainEqual(["plimmerton", "porirua"])
		expect(index.calls.some(([, parent]) => parent.includes("5026"))).toBe(false)
	})

	it("no trailing postcode: a multi-word parent segment folds byte-identically with the strip armed (no-op)", () => {
		const entries = { "fishburn|stocktonontees": "dependent_locality" }
		const text = "Fishburn, Stockton on Tees"
		const armed = mockPairIndex(entries, 6, undefined, "gb")
		const disabled = mockPairIndex(entries, 6)
		const armedResult = buildPlacetypePairPriors({ index: armed, inputText: text }, makePiecesWithCommas(text), LABELS)

		const baseResult = buildPlacetypePairPriors(
			{ index: disabled, inputText: text },
			makePiecesWithCommas(text),
			LABELS
		)

		expect(armedResult.matrix).toEqual(baseResult.matrix)
		expect(armed.calls).toEqual(disabled.calls)

		expect(armed.calls).toContainEqual(["fishburn", "stockton on tees"])
		expect(armedResult.matrix[0]![labelCol("B-dependent_locality")]).toBe(6)
	})

	it("a segment that IS only a postcode is never stripped to nothing and never a spurious parent", () => {
		const index = mockPairIndex({ "plimmerton|porirua": "dependent_locality" }, 6, undefined, "nz")
		const text = "Plimmerton, 5026"
		const pieces = makePiecesWithCommas(text)
		const { matrix } = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		for (const row of matrix) {
			expect(row.every((v) => v === 0)).toBe(true)
		}

		expect(index.calls.some(([child]) => child === "5026")).toBe(true)
		expect(index.calls.some(([child, parent]) => child === "" || parent === "")).toBe(false)
	})

	it("Comma-separated postcode (its own segment) → unchanged: the town's own field still flips the child, as before", () => {
		const index = mockPairIndex({ "plimmerton|porirua": "dependent_locality" }, 6, undefined, "nz")
		const text = "35 Steyne Avenue, Plimmerton, Porirua, 5026"

		const pieces = makePiecesWithCommas(text)
		const { matrix } = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		expect(matrix[4]![labelCol("B-dependent_locality")]).toBe(6)
		expect(index.calls).toContainEqual(["plimmerton", "porirua"])
		expect(index.calls.some(([child]) => child === "5026")).toBe(true)
	})

	it("A country with no known codex shape (au) → no strip, byte-stable: the same-field postcode stays in the parent key and the pair does NOT fire", () => {
		const index = mockPairIndex({ "plimmerton|porirua": "dependent_locality" }, 6, undefined, "au")
		const text = "Plimmerton, Porirua 5026"
		const pieces = makePiecesWithCommas(text)
		const { matrix } = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		for (const row of matrix) {
			expect(row.every((v) => v === 0)).toBe(true)
		}

		expect(index.calls).toContainEqual(["plimmerton", "porirua 5026"])
		expect(index.calls).not.toContainEqual(["plimmerton", "porirua"])
	})
})

describe("buildPlacetypePairPriors — marker suppression must not cross segment boundaries", () => {
	it('reviewer repro: "Fishburn, 5 Fishburn Road" biases Fishburn — successor "5" is in the NEXT segment, so it must never suppress', () => {
		const index = mockPairIndex({ "fishburn|5 fishburn road": "dependent_locality" }, 6)
		const text = "Fishburn, 5 Fishburn Road"
		const pieces = makePiecesWithCommas(text)
		const { matrix } = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		expect(matrix[0]![labelCol("B-dependent_locality")]).toBe(6)

		expect(index.calls.some(([child]) => child === "fishburn")).toBe(true)
	})

	it('control: WINDOW mode marker suppression is unaffected by comma placement — "Fishburn Road, Leeds" still suppresses "Fishburn" (successor "Road" IS in the same clause)', () => {
		const index = mockPairIndex({ "fishburn|leeds": "dependent_locality" }, 6)
		const text = "Fishburn Road, Leeds"
		const pieces = makePiecesWithCommas(text)
		const { matrix } = buildPlacetypePairPriors({ index, probeMode: "window", inputText: text }, pieces, LABELS)

		for (const row of matrix) {
			expect(row.every((v) => v === 0)).toBe(true)
		}

		expect(index.calls.some(([child]) => child === "fishburn")).toBe(false)
	})

	it('Control: SEGMENT mode on "Fishburn Road, Leeds" still withholds bias from bare "fishburn" — the whole-segment fusion (not marker suppression) is what protects this shape', () => {
		const index = mockPairIndex({ "fishburn|leeds": "dependent_locality" }, 6)
		const text = "Fishburn Road, Leeds"
		const pieces = makePiecesWithCommas(text)
		const { matrix } = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		for (const row of matrix) {
			expect(row.every((v) => v === 0)).toBe(true)
		}

		expect(index.calls.some(([child]) => child === "fishburn")).toBe(false)
	})
})

describe("buildPlacetypePairPriors — paired punctuation (real fixture tokenizer)", () => {
	it('a quoted venue segment (\'"The Grange", Fishburn\') probes the CLEAN fold "the grange" — no leftover quote chars', async () => {
		const index = mockPairIndex({ "the grange|fishburn": "dependent_locality" }, 6)
		const text = '"The Grange", Fishburn'
		const tokenizer = await MailwomanTokenizer.loadFromFile(FIXTURE_TOKENIZER_PATH)
		const { pieces } = tokenizer.encode(text)
		const { matrix } = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		expect(matrix[0]!.some((v) => v > 0) || matrix.some((row) => row[labelCol("B-dependent_locality")]! > 0)).toBe(true)

		expect(index.calls.some(([child]) => child === "the grange")).toBe(true)
		expect(index.calls.some(([child]) => child.includes('"'))).toBe(false)
	})

	it("a bracketed segment ('[Block B], Fishburn') probes the clean fold \"block b\"", async () => {
		const index = mockPairIndex({ "block b|fishburn": "dependent_locality" }, 6)
		const text = "[Block B], Fishburn"
		const tokenizer = await MailwomanTokenizer.loadFromFile(FIXTURE_TOKENIZER_PATH)
		const { pieces } = tokenizer.encode(text)
		const { matrix } = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		expect(matrix.some((row) => row[labelCol("B-dependent_locality")]! > 0)).toBe(true)
		expect(index.calls.some(([child]) => child === "block b")).toBe(true)
		expect(index.calls.some(([child]) => /[[\]]/.test(child))).toBe(false)
	})

	it("a curly-quoted segment ('\"The Grange\", Fishburn' with curly quotes) probes the SAME clean fold as straight quotes", async () => {
		const index = mockPairIndex({ "the grange|fishburn": "dependent_locality" }, 6)
		const text = "“The Grange”, Fishburn"
		const tokenizer = await MailwomanTokenizer.loadFromFile(FIXTURE_TOKENIZER_PATH)
		const { pieces } = tokenizer.encode(text)
		const { matrix } = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		expect(matrix.some((row) => row[labelCol("B-dependent_locality")]! > 0)).toBe(true)
		expect(index.calls.some(([child]) => child === "the grange")).toBe(true)
	})

	it("UNBALANCED quote (only an opener without closer anywhere in the input) never crashes and still probes the clean fold", async () => {
		const index = mockPairIndex({ "the grange|fishburn": "dependent_locality" }, 6)
		const text = '"The Grange, Fishburn'
		const tokenizer = await MailwomanTokenizer.loadFromFile(FIXTURE_TOKENIZER_PATH)
		const { pieces } = tokenizer.encode(text)

		expect(() => buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)).not.toThrow()
		const { matrix } = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)
		expect(matrix.some((row) => row[labelCol("B-dependent_locality")]! > 0)).toBe(true)
	})
})

describe("buildPlacetypePairPriors — anchored adjacent-pair mode (v1.1 probe chain, 2026-07-24 design)", () => {
	it("comma-free adjacent pair + postcode: child biased, parent (and postcode) untouched — anchor sits left of the WHOLE postcode span", () => {
		const index = mockPairIndex({ "fishburn|stockton on tees": "dependent_locality" }, 6)

		const text = "St Bedes Avenue Fishburn Stockton on Tees TS21 3AB"
		const pieces = makePieces(text)
		const { matrix } = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		expect(matrix[3]![labelCol("B-dependent_locality")]).toBe(6)

		for (const i of [0, 1, 2, 4, 5, 6, 7, 8]) {
			expect(matrix[i]!.every((v) => v === 0)).toBe(true)
		}

		expect(index.calls).toContainEqual(["fishburn", "stockton on tees"])
	})

	it("Comma-free without postcode: the string-final window is the parent anchor; explicit probeMode 'anchored' matches the auto default", () => {
		const index = mockPairIndex({ "fishburn|stockton on tees": "dependent_locality" }, 6)
		const text = "St Bedes Avenue Fishburn Stockton on Tees"
		const pieces = makePieces(text)
		const { matrix: autoMatrix } = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		expect(autoMatrix[3]![labelCol("B-dependent_locality")]).toBe(6)

		for (const i of [0, 1, 2, 4, 5, 6]) {
			expect(autoMatrix[i]!.every((v) => v === 0)).toBe(true)
		}

		const { matrix: explicitMatrix } = buildPlacetypePairPriors(
			{ index, probeMode: "anchored", inputText: text },
			pieces,
			LABELS
		)

		expect(explicitMatrix).toEqual(autoMatrix)
	})

	it("chain equivalence: a comma'd input under the auto default is byte-identical to explicit segment mode — matrices AND probe-call sequences", () => {
		const hitEntries = { "moelfre|abergele": "dependent_locality" }
		const hitText = "Moelfre, Abergele"
		const hitPieces = makePiecesWithCommas(hitText)
		const hitAuto = mockPairIndex(hitEntries, 6)
		const hitSegment = mockPairIndex(hitEntries, 6)
		const { matrix: autoMatrix } = buildPlacetypePairPriors({ index: hitAuto, inputText: hitText }, hitPieces, LABELS)

		const { matrix: segmentMatrix } = buildPlacetypePairPriors(
			{ index: hitSegment, probeMode: "segment", inputText: hitText },
			hitPieces,
			LABELS
		)

		expect(autoMatrix).toEqual(segmentMatrix)
		expect(autoMatrix[0]![labelCol("B-dependent_locality")]).toBe(6)

		expect(hitAuto.calls).toEqual(hitSegment.calls)

		const venueEntries = { "queens park|chester": "dependent_locality" }
		const venueText = "Queens Park Academy, Chestnut Avenue, Chester"
		const venuePieces = makePiecesWithCommas(venueText)
		const venueAuto = mockPairIndex(venueEntries, 6)
		const venueSegment = mockPairIndex(venueEntries, 6)

		const { matrix: venueAutoMatrix } = buildPlacetypePairPriors(
			{ index: venueAuto, inputText: venueText },
			venuePieces,
			LABELS
		)

		const { matrix: venueSegmentMatrix } = buildPlacetypePairPriors(
			{ index: venueSegment, probeMode: "segment", inputText: venueText },
			venuePieces,
			LABELS
		)

		expect(venueAutoMatrix).toEqual(venueSegmentMatrix)

		for (const row of venueAutoMatrix) {
			expect(row.every((v) => v === 0)).toBe(true)
		}

		expect(venueAuto.calls).toEqual(venueSegment.calls)
	})

	it("venue-shape start, comma-free: the venue occurrence is not adjacent to the anchor and never fires — only the true adjacent occurrence does", () => {
		const index = mockPairIndex({ "queens park|chester": "dependent_locality" }, 6)
		const text = "Queens Park Cafe Queens Park Chester"
		const pieces = makePieces(text)
		const { matrix } = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		for (const i of [0, 1, 2]) {
			expect(matrix[i]!.every((v) => v === 0)).toBe(true)
		}

		expect(matrix[3]![labelCol("B-dependent_locality")]).toBe(6)
		expect(matrix[4]![labelCol("I-dependent_locality")]).toBe(6)
		expect(matrix[5]!.every((v) => v === 0)).toBe(true)
	})

	it('left-maximality: with both ("cadbury","yeovil") and ("north cadbury","yeovil") in the index, the 2-word child wins and there is no double bias', () => {
		const index = mockPairIndex(
			{ "cadbury|yeovil": "dependent_locality", "north cadbury|yeovil": "dependent_locality" },
			6
		)

		const text = "North Cadbury Yeovil"
		const pieces = makePieces(text)
		const { matrix } = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		expect(matrix[0]![labelCol("B-dependent_locality")]).toBe(6)
		expect(matrix[1]![labelCol("I-dependent_locality")]).toBe(6)

		expect(matrix[1]![labelCol("B-dependent_locality")]).toBe(0)
		expect(matrix[2]!.every((v) => v === 0)).toBe(true)

		expect(index.calls).not.toContainEqual(["cadbury", "yeovil"])
	})

	it('a 4-word child fires under the anchored cap ("Knott End on Sea" class — wider than WINDOW_MAX_WORDS on purpose)', () => {
		const index = mockPairIndex({ "knott end on sea|lancaster": "dependent_locality" }, 6)
		const text = "Knott End on Sea Lancaster"
		const pieces = makePieces(text)
		const { matrix } = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		expect(matrix[0]![labelCol("B-dependent_locality")]).toBe(6)

		for (const i of [1, 2, 3]) {
			expect(matrix[i]![labelCol("I-dependent_locality")]).toBe(6)
		}

		expect(matrix[4]!.every((v) => v === 0)).toBe(true)
	})

	it('marker suppression applies to the anchored child: "church" followed by "road" is never probed', () => {
		const index = mockPairIndex({ "church|road end": "dependent_locality" }, 6)
		const text = "Church Road End"
		const pieces = makePieces(text)
		const { matrix } = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		for (const row of matrix) {
			expect(row.every((v) => v === 0)).toBe(true)
		}

		expect(index.calls.some(([child]) => child === "church")).toBe(false)
	})

	it("control: the SAME geometry without a marker successor probes and fires — the marker rather than the adjacency, blocked above", () => {
		const index = mockPairIndex({ "church|lane end": "dependent_locality" }, 6)
		const text = "Church Lane End"
		const pieces = makePieces(text)
		const { matrix } = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		expect(matrix[0]![labelCol("B-dependent_locality")]).toBe(6)
		expect(index.calls).toContainEqual(["church", "lane end"])
	})

	it("No-hit comma-free input (neither postcode shape nor pair anywhere) returns the exact zero matrix", () => {
		const index = mockPairIndex({ "somewhere|else": "dependent_locality" }, 6)
		const text = "Totally Unrelated Words Here"
		const pieces = makePieces(text)
		const { matrix } = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		expect(matrix).toHaveLength(4)

		for (const row of matrix) {
			expect(row.every((v) => v === 0)).toBe(true)
		}
	})
})

describe("buildPlacetypePairPriors — identical adjacent segments (NZ repeated-name convention, registry-evidence semantics)", () => {
	it('NZ convention: "Mangawhai, Mangawhai" with the identity pair in the index — FIRST segment biased, SECOND receives zero bias from this pair', () => {
		const index = mockPairIndex({ "mangawhai|mangawhai": "dependent_locality" }, 6)
		const text = "Mangawhai, Mangawhai"

		const pieces = makePiecesWithCommas(text)
		const { matrix } = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		expect(matrix[0]![labelCol("B-dependent_locality")]).toBe(6)

		expect(matrix[2]!.every((v) => v === 0)).toBe(true)

		expect(index.calls).toEqual([["mangawhai", "mangawhai"]])
	})

	it("same input, identity pair NOT in the index: zero matrix — no behavior invented without registry evidence", () => {
		const index = mockPairIndex({}, 6)
		const text = "Mangawhai, Mangawhai"
		const pieces = makePiecesWithCommas(text)
		const { matrix } = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		for (const row of matrix) {
			expect(row.every((v) => v === 0)).toBe(true)
		}
	})

	it('Regression pin: "A, B" DISTINCT adjacent keys with (a, b) in the index — today\'s behavior byte-exact, both roles probed', () => {
		const index = mockPairIndex({ "alderton|bramford": "dependent_locality" }, 6)
		const text = "Alderton, Bramford"

		const pieces = makePiecesWithCommas(text)
		const { matrix } = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		expect(matrix[0]![labelCol("B-dependent_locality")]).toBe(6)
		expect(matrix[0]!.filter((v) => v !== 0)).toHaveLength(1)
		expect(matrix[1]![labelCol("I-dependent_locality")]).toBe(6)
		expect(matrix[1]!.filter((v) => v !== 0)).toHaveLength(1)
		expect(matrix[2]!.every((v) => v === 0)).toBe(true)

		expect(index.calls).toContainEqual(["bramford", "alderton"])
	})

	it("non-adjacent identical segments (\"Mangawhai, Something, Mangawhai\") keep today's two-sided behavior — out of the convention's shape", () => {
		const index = mockPairIndex({ "mangawhai|mangawhai": "dependent_locality" }, 6)
		const text = "Mangawhai, Something, Mangawhai"

		const pieces = makePiecesWithCommas(text)
		const { matrix } = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		expect(matrix[0]![labelCol("B-dependent_locality")]).toBe(6)
		expect(matrix[4]![labelCol("B-dependent_locality")]).toBe(6)

		expect(matrix[2]!.every((v) => v === 0)).toBe(true)
	})

	it('three identical adjacent segments ("X, X, X"): only the FIRST segment overall is biased', () => {
		const index = mockPairIndex({ "mangawhai|mangawhai": "dependent_locality" }, 6)
		const text = "Mangawhai, Mangawhai, Mangawhai"

		const pieces = makePiecesWithCommas(text)
		const { matrix } = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		expect(matrix[0]![labelCol("B-dependent_locality")]).toBe(6)
		expect(matrix[2]!.every((v) => v === 0)).toBe(true)
		expect(matrix[4]!.every((v) => v === 0)).toBe(true)

		expect(index.calls).toEqual([["mangawhai", "mangawhai"]])
	})

	it('chain sanity: comma-free "Mangawhai Mangawhai" is untouched by this change — the anchored path handles it and already biases only the first occurrence', () => {
		const index = mockPairIndex({ "mangawhai|mangawhai": "dependent_locality" }, 6)
		const text = "Mangawhai Mangawhai"
		const pieces = makePieces(text)
		const trace: PlacetypePairProbeTrace = {}
		const { matrix } = buildPlacetypePairPriors({ index, inputText: text, probeTrace: trace }, pieces, LABELS)

		expect(trace.firedPath).toBe("anchored")
		expect(matrix[0]![labelCol("B-dependent_locality")]).toBe(6)
		expect(matrix[1]!.every((v) => v === 0)).toBe(true)
	})
})

describe("buildPlacetypePairPriors — probeTrace (which chain leg fired)", () => {
	it('records "segment" on a comma\'d hit, "anchored" on a comma-free hit, and stays unset on a miss', () => {
		const entries = { "moelfre|abergele": "dependent_locality" }

		const segmentTrace: PlacetypePairProbeTrace = {}
		const commaText = "Moelfre, Abergele"

		buildPlacetypePairPriors(
			{ index: mockPairIndex(entries, 6), inputText: commaText, probeTrace: segmentTrace },
			makePiecesWithCommas(commaText),
			LABELS
		)

		expect(segmentTrace.firedPath).toBe("segment")

		const anchoredTrace: PlacetypePairProbeTrace = {}
		const bareText = "Moelfre Abergele"

		buildPlacetypePairPriors(
			{ index: mockPairIndex(entries, 6), inputText: bareText, probeTrace: anchoredTrace },
			makePieces(bareText),
			LABELS
		)

		expect(anchoredTrace.firedPath).toBe("anchored")

		const missTrace: PlacetypePairProbeTrace = {}
		const missText = "Totally Unrelated Words"

		buildPlacetypePairPriors(
			{ index: mockPairIndex(entries, 6), inputText: missText, probeTrace: missTrace },
			makePieces(missText),
			LABELS
		)

		expect(missTrace.firedPath).toBeUndefined()
	})

	it('records "window" when the opt-in window mode produced the bias', () => {
		const windowTrace: PlacetypePairProbeTrace = {}

		buildPlacetypePairPriors(
			{
				index: mockPairIndex({ "shoreditch|london": "dependent_locality" }, 6),
				probeMode: "window",
				probeTrace: windowTrace,
			},
			makePieces("Shoreditch London"),
			LABELS
		)

		expect(windowTrace.firedPath).toBe("window")
	})
})

describe("buildPlacetypePairPriors — transition adjustments (TRANSITION-BETA build)", () => {
	it("a segment-path hit on a transitionBeta-carrying index emits ONE adjustment at the child's first piece", () => {
		const index = mockPairIndex({ "moelfre|abergele": "dependent_locality" }, 10, 5)
		const text = "Moelfre, Abergele"
		const pieces = makePiecesWithCommas(text)
		const { matrix, transitionAdjustments } = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		expect(matrix[0]![labelCol("B-dependent_locality")]).toBe(10)
		expect(transitionAdjustments).toEqual([{ pieceIndex: 0, toLabel: "B-dependent_locality", bonus: 5 }])
	})

	it("an anchored-path hit emits the adjustment at the child's first piece — NOT piece 0 when the child sits mid-string", () => {
		const index = mockPairIndex({ "caergwrle|wrexham": "dependent_locality" }, 10, 5)
		const text = "Bryn Caergwrle Wrexham"
		const pieces = makePieces(text)
		const trace: PlacetypePairProbeTrace = {}

		const { transitionAdjustments } = buildPlacetypePairPriors(
			{ index, inputText: text, probeTrace: trace },
			pieces,
			LABELS
		)

		expect(trace.firedPath).toBe("anchored")
		expect(transitionAdjustments).toEqual([{ pieceIndex: 1, toLabel: "B-dependent_locality", bonus: 5 }])
	})

	it("a beta-less index emits NO adjustments, and its matrix is byte-identical to the beta run's — the beta never touches emissions", () => {
		const text = "Moelfre, Abergele"
		const pieces = makePiecesWithCommas(text)

		const withBeta = buildPlacetypePairPriors(
			{ index: mockPairIndex({ "moelfre|abergele": "dependent_locality" }, 10, 5), inputText: text },
			pieces,
			LABELS
		)

		const withoutBeta = buildPlacetypePairPriors(
			{ index: mockPairIndex({ "moelfre|abergele": "dependent_locality" }, 10), inputText: text },
			pieces,
			LABELS
		)

		expect(withoutBeta.transitionAdjustments).toEqual([])
		expect(withoutBeta.matrix).toEqual(withBeta.matrix)
	})

	it("Beta present but NO hit → empty adjustments and a zero matrix (no hit / no beta → exactly today's behavior)", () => {
		const index = mockPairIndex({ "moelfre|abergele": "dependent_locality" }, 10, 5)
		const text = "Totally, Unrelated"
		const pieces = makePiecesWithCommas(text)
		const { matrix, transitionAdjustments } = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		expect(transitionAdjustments).toEqual([])

		for (const row of matrix) {
			expect(row.every((v) => v === 0)).toBe(true)
		}
	})

	it('venue-title "at" predecessor (the Hoff shape): emission bias present, transition adjustment WITHHELD', () => {
		const index = mockPairIndex({ "hoff|appleby": "dependent_locality" }, 10, 5)
		const text = "New Inn at Hoff Appleby"
		const pieces = makePieces(text)
		const trace: PlacetypePairProbeTrace = {}

		const { matrix, transitionAdjustments } = buildPlacetypePairPriors(
			{ index, inputText: text, probeTrace: trace },
			pieces,
			LABELS
		)

		expect(trace.firedPath).toBe("anchored")
		expect(matrix[3]![labelCol("B-dependent_locality")]).toBe(10)
		expect(transitionAdjustments).toEqual([])
	})

	it('venue-title "of" predecessor: same withholding ("House of Bruar" genitive shape)', () => {
		const index = mockPairIndex({ "bruar|pitlochry": "dependent_locality" }, 10, 5)
		const text = "House of Bruar Pitlochry"
		const pieces = makePieces(text)
		const { matrix, transitionAdjustments } = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		expect(matrix[2]![labelCol("B-dependent_locality")]).toBe(10)
		expect(transitionAdjustments).toEqual([])
	})

	it("no predecessor (child at the string start): adjustment present, unchanged", () => {
		const index = mockPairIndex({ "hoff|appleby": "dependent_locality" }, 10, 5)
		const text = "Hoff Appleby"
		const pieces = makePieces(text)
		const { transitionAdjustments } = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		expect(transitionAdjustments).toEqual([{ pieceIndex: 0, toLabel: "B-dependent_locality", bonus: 5 }])
	})

	it('normal predecessor ("Close" — ordinary address syntax): adjustment present, unchanged', () => {
		const index = mockPairIndex({ "glenfield|leicester": "dependent_locality" }, 10, 5)
		const text = "Carpenters Close Glenfield Leicester"
		const pieces = makePieces(text)
		const { transitionAdjustments } = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		expect(transitionAdjustments).toEqual([{ pieceIndex: 2, toLabel: "B-dependent_locality", bonus: 5 }])
	})

	it('interior place-name preposition ("Knott End on Sea"): unaffected by construction — predecessor check rather than membership', () => {
		const index = mockPairIndex({ "knott end on sea|poulton": "dependent_locality" }, 10, 5)
		const text = "5 Knott End on Sea Poulton"
		const pieces = makePieces(text)
		const { matrix, transitionAdjustments } = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		expect(matrix[1]![labelCol("B-dependent_locality")]).toBe(10)
		expect(transitionAdjustments).toEqual([{ pieceIndex: 1, toLabel: "B-dependent_locality", bonus: 5 }])
	})

	it("Window mode: overlapping candidates sharing a first piece dedupe to ONE max'd adjustment rather than a stacked pair", () => {
		const index = mockPairIndex(
			{ "shoreditch east|london": "dependent_locality", "shoreditch|london": "dependent_locality" },
			10,
			5
		)

		const { transitionAdjustments } = buildPlacetypePairPriors(
			{ index, probeMode: "window" },
			makePieces("Shoreditch East London"),
			LABELS
		)

		expect(transitionAdjustments).toEqual([{ pieceIndex: 0, toLabel: "B-dependent_locality", bonus: 5 }])
	})
})

describe("BuildPlacetypePairPriors — whole-edge parent bias", () => {
	it("Omitting parentDelta is byte-identical to the pre- build — only the child span carries a bias", () => {
		const index = mockPairIndex({ "brooklyn|new york": "dependent_locality" }, 10)
		const text = "Brooklyn, New York, NY"
		const pieces = makePiecesWithCommas(text)
		const { matrix } = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		expect(matrix[0]![labelCol("B-dependent_locality")]).toBe(10)

		expect(matrix[2]!.every((v) => v === 0)).toBe(true)
		expect(matrix[3]!.every((v) => v === 0)).toBe(true)
	})

	it("a dependent_locality child biases the parent toward locality ALONE — the Brooklyn case", () => {
		const index = mockPairIndex({ "brooklyn|new york": "dependent_locality>locality" }, 10)
		const text = "Brooklyn, New York, NY"
		const pieces = makePiecesWithCommas(text)
		const { matrix } = buildPlacetypePairPriors({ index, inputText: text, parentDelta: 8 }, pieces, LABELS)

		expect(matrix[0]![labelCol("B-dependent_locality")]).toBe(10)
		expect(matrix[2]![labelCol("B-locality")]).toBe(8)
		expect(matrix[3]![labelCol("I-locality")]).toBe(8)
		expect(matrix[2]![labelCol("B-region")]).toBe(0)
		expect(matrix[3]![labelCol("I-region")]).toBe(0)
	})

	it("biases EXACTLY the record's parentTag — not the containment set the child tag would allow (PIX2)", () => {
		const index = mockPairIndex({ "springfield|illinois": "locality>region" }, 10)
		const text = "Springfield, Illinois"
		const pieces = makePiecesWithCommas(text)
		const { matrix } = buildPlacetypePairPriors({ index, inputText: text, parentDelta: 8 }, pieces, LABELS)

		expect(matrix[0]![labelCol("B-locality")]).toBe(10)
		expect(matrix[2]![labelCol("B-region")]).toBe(8)
		expect(matrix[2]![labelCol("B-subregion")]).toBe(0)
		expect(matrix[2]![labelCol("B-country")]).toBe(0)
		expect(matrix[2]![labelCol("B-street")]).toBe(0)
	})

	it("carries a parent tag containment forbids — a dependent_locality under a BOROUGH", () => {
		const index = mockPairIndex({ "park slope|brooklyn": "dependent_locality>dependent_locality" }, 10)
		const text = "Park Slope, Brooklyn"
		const pieces = makePiecesWithCommas(text)
		const { matrix } = buildPlacetypePairPriors({ index, inputText: text, parentDelta: 8 }, pieces, LABELS)

		expect(matrix[3]![labelCol("B-dependent_locality")]).toBe(8)
		expect(matrix[3]![labelCol("B-locality")]).toBe(0)
	})

	it("reads parentDelta off the index HEADER when opts omits it — the default-on wire-up", () => {
		const index = mockPairIndex({ "brooklyn|new york": "dependent_locality>locality" }, 10, undefined, "us", 5)
		const text = "Brooklyn, New York, NY"
		const pieces = makePiecesWithCommas(text)
		const { matrix } = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		expect(matrix[2]![labelCol("B-locality")]).toBe(5)
	})

	it("an explicit opts.parentDelta OVERRIDES the header — the MAILWOMAN_PAIR_PARENT_DELTA sweep setting", () => {
		const index = mockPairIndex({ "brooklyn|new york": "dependent_locality>locality" }, 10, undefined, "us", 5)
		const text = "Brooklyn, New York, NY"
		const pieces = makePiecesWithCommas(text)
		const { matrix } = buildPlacetypePairPriors({ index, inputText: text, parentDelta: 20 }, pieces, LABELS)

		expect(matrix[2]![labelCol("B-locality")]).toBe(20)
	})

	it("a header WITHOUT parentDelta writes no parent bias at all — the unmeasured-locale posture", () => {
		const index = mockPairIndex({ "brooklyn|new york": "dependent_locality>locality" }, 10, undefined, "us")
		const text = "Brooklyn, New York, NY"
		const pieces = makePiecesWithCommas(text)
		const { matrix } = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		expect(matrix[0]![labelCol("B-dependent_locality")]).toBe(10)
		expect(matrix[2]!.every((v) => v === 0)).toBe(true)
	})

	it("the parent bias is emission-only — it never emits a transition adjustment", () => {
		const index = mockPairIndex({ "brooklyn|new york": "dependent_locality" }, 10, 5)
		const text = "Brooklyn, New York, NY"
		const pieces = makePiecesWithCommas(text)

		const { transitionAdjustments } = buildPlacetypePairPriors(
			{ index, inputText: text, parentDelta: 8 },
			pieces,
			LABELS
		)

		expect(transitionAdjustments).toEqual([{ pieceIndex: 0, toLabel: "B-dependent_locality", bonus: 5 }])
	})

	it("the anchored (comma-free) leg biases its parent too", () => {
		const index = mockPairIndex({ "shoreditch|london": "dependent_locality" }, 10)
		const text = "12 Redchurch Street Shoreditch London"
		const pieces = makePieces(text)

		const { matrix } = buildPlacetypePairPriors(
			{ index, inputText: text, probeMode: "anchored", parentDelta: 8 },
			pieces,
			LABELS
		)

		expect(matrix[3]![labelCol("B-dependent_locality")]).toBe(10)
		expect(matrix[4]![labelCol("B-locality")]).toBe(8)
	})

	it("the parent bias covers the KEY's span rather than the whole segment — a same-field postcode is excluded", () => {
		const index = mockPairIndex({ "pinsonnac|montpeyroux": "dependent_locality" }, 10, undefined, "fr")
		const text = "Pinsonnac, 12210 Montpeyroux"
		const pieces = makePiecesWithCommas(text)
		const { matrix } = buildPlacetypePairPriors({ index, inputText: text, parentDelta: 8 }, pieces, LABELS)

		expect(matrix[0]![labelCol("B-dependent_locality")]).toBe(10)

		expect(matrix[2]!.every((v) => v === 0)).toBe(true)
		expect(matrix[3]![labelCol("B-locality")]).toBe(8)
	})

	it("the GB trailing-postcode shape is excluded from the parent bias for the same reason", () => {
		const index = mockPairIndex({ "henbury|macclesfield": "dependent_locality" }, 10, undefined, "gb")
		const text = "Henbury, Macclesfield SK11 9PD"
		const pieces = makePiecesWithCommas(text)
		const { matrix } = buildPlacetypePairPriors({ index, inputText: text, parentDelta: 8 }, pieces, LABELS)

		expect(matrix[0]![labelCol("B-dependent_locality")]).toBe(10)
		expect(matrix[2]![labelCol("B-locality")]).toBe(8)

		expect(matrix[3]!.every((v) => v === 0)).toBe(true)
		expect(matrix[4]!.every((v) => v === 0)).toBe(true)
	})

	it("probeTrace records every fired child tag — the sort key for bar B-1's population split", () => {
		const index = mockPairIndex({ "brooklyn|new york": "dependent_locality" }, 10)
		const text = "Brooklyn, New York, NY"
		const pieces = makePiecesWithCommas(text)
		const probeTrace: PlacetypePairProbeTrace = {}

		buildPlacetypePairPriors({ index, inputText: text, probeTrace }, pieces, LABELS)

		expect(probeTrace.firedChildTags).toEqual(["dependent_locality"])
	})
})
