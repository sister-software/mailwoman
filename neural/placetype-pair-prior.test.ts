/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unit tests for the placetype-pair emission bias (placetype-pair-prior arc, Tasks 4 + 6): the
 *   space-joined window-key fold, the two-sided disjoint-window match, marker suppression, and the
 *   `delta ?? biasScale` bias-magnitude resolution. The query-shape-prior.test.ts / street-morphology
 *   mock-index idiom — a hand-built `PairIndexLike` double, no real binary artifact needed.
 *
 *   `probeMode` DEFAULTED to `"segment"` in Task 6 (the venue-confound falsifier verdict — see
 *   `placetype-pair-prior.ts`'s module docstring). Every test above this file's "segment mode" section
 *   passes `probeMode: "window"` explicitly — they exercise the sub-segment sliding-window behavior on
 *   comma-free `makePieces` input, which is now opt-in, not the default. The "segment mode" section below
 *   tests that path directly, using `makePiecesWithCommas` (a comma-preserving sibling of
 *   `makePieces`) so segment boundaries actually exist to probe.
 *
 *   The default became the `"auto"` probe CHAIN with the 2026-07-24 anchored adjacent-pair design
 *   (v1.1): segment path on ≥2 comma segments (byte-identical to explicit `"segment"` — asserted below
 *   as a chain-equivalence property), anchored-adjacent path on comma-free input. The "anchored
 *   adjacent-pair mode" section tests the new leg; the segment-mode tests all carry commas, so their
 *   omitted-probeMode calls exercise the chain's segment leg unchanged.
 */

import { existsSync } from "node:fs"

import { repoRootPath } from "@mailwoman/core/utils"
import { describe, expect, it, test } from "vitest"

import { STAGE2_BIO_LABELS } from "./labels.ts"
import {
	PairIndexResolver,
	serializePairIndex,
	type PairIndexEntry,
	type PairIndexHeader,
	type PairIndexLike,
} from "./pair-index-resolver.ts"
import { buildPlacetypePairPriors, type PlacetypePairProbeTrace } from "./placetype-pair-prior.ts"
import { MailwomanTokenizer } from "./tokenizer.ts"

const LABELS = STAGE2_BIO_LABELS

const FIXTURE_TOKENIZER_PATH = repoRootPath("neural", "test", "fixtures", "tokenizer-v0.1.0.model")

// Production tokenizer, gated (mirrors weights.test.ts's `haveModel` skipIf idiom). Not present in
// stripped-down CI; runs on the lab host where $MAILWOMAN_DATA_ROOT is populated.
const PRODUCTION_TOKENIZER_PATH = "/mnt/playpen/mailwoman-data/models/tokenizer/v0.9.0-multisplice/tokenizer.model"
const haveProductionTokenizer = existsSync(PRODUCTION_TOKENIZER_PATH)

function labelCol(label: string): number {
	return LABELS.indexOf(label as (typeof LABELS)[number])
}

/**
 * One SentencePiece per word — mirrors `street-morphology-prior.test.ts`'s helper. Sufficient for every test here
 * except the "St Helens" case, which uses the real fixture tokenizer to prove the fold against a genuine multi-piece
 * split.
 */
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

/**
 * Comma-preserving sibling of {@link makePieces}, for segment-mode tests: each word gets its own `▁`-prefixed piece (as
 * before), and each literal `,` gets its own bare (no `▁`) piece — the shape `groupPiecesIntoWords` absorbs as trailing
 * punctuation onto the PRECEDING word's group (real-tokenizer behavior; see that function's docstring, case 3). Words
 * split on `/\s+|,/` so "Fishburn, Stockton" tokenizes as `["Fishburn", "Stockton"]` with the comma handled separately
 * — a real SentencePiece tokenizer would split similarly (the comma rarely fuses into the same piece as the word it
 * follows).
 */
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

/**
 * A `PairIndexLike` double backed by a plain `(child, parent) -> tag` map, with recorded probe calls so tests can
 * assert on the exact keys probed (the space-join proof needs this).
 */
function mockPairIndex(
	entries: Record<string, string>,
	delta?: number
): PairIndexLike & { calls: Array<[string, string]> } {
	const calls: Array<[string, string]> = []

	return {
		delta,
		calls,
		probe(child: string, parent: string) {
			calls.push([child, parent])

			return entries[`${child}|${parent}`] as never
		},
	}
}

describe("buildPlacetypePairPriors — absence cases", () => {
	it("returns a zero matrix when opts is undefined (no configured index — default OFF)", () => {
		const pieces = makePieces("shoreditch london")
		const matrix = buildPlacetypePairPriors(undefined, pieces, LABELS)

		expect(matrix).toHaveLength(2)

		for (const row of matrix) {
			expect(row.every((v) => v === 0)).toBe(true)
		}
	})

	it("returns a zero matrix when the index is present but never matches (no country data for this locale)", () => {
		const index = mockPairIndex({}) // no entries — every probe misses
		const pieces = makePieces("shoreditch london")
		const matrix = buildPlacetypePairPriors({ index, probeMode: "window" }, pieces, LABELS)

		for (const row of matrix) {
			expect(row.every((v) => v === 0)).toBe(true)
		}
		expect(index.calls.length).toBeGreaterThan(0) // it DID probe — just never hit
	})
})

describe("buildPlacetypePairPriors — window-key fold (space-join, not concatenation)", () => {
	it('probes a 2-word window as "st helens" (space-joined), never "sthelens"', async () => {
		// Real fixture tokenizer split for "St Helens Lancashire": ['▁St','▁Hel','ens','▁Lan','ca','shire']
		// — "Helens" is genuinely two SentencePiece pieces here, so this exercises normalizeFSTToken's
		// fold-then-join pipeline against a real multi-piece word, not a hand-rolled approximation. A
		// third word ("Lancashire") is needed so the 2-word "St Helens" window has a disjoint partner to
		// probe against — with only two words total there's no room left for any pairing.
		const tokenizer = await MailwomanTokenizer.loadFromFile(
			repoRootPath("neural", "test", "fixtures", "tokenizer-v0.1.0.model")
		)
		const { pieces } = tokenizer.encode("St Helens Lancashire")
		const index = mockPairIndex({ "st helens|lancashire": "dependent_locality" }, 6.0)

		const matrix = buildPlacetypePairPriors({ index, probeMode: "window" }, pieces, LABELS)

		// The 2-word window "St Helens" must have been probed as the space-joined fold. A naive
		// concatenation ("sthelens") would never appear in the real index and this assertion would fail.
		expect(index.calls.some(([child]) => child === "st helens")).toBe(true)
		expect(index.calls.some(([child]) => child === "sthelens")).toBe(false)
		// And the match actually fires: "St"'s piece (idx 0, the window's first piece) gets the bias.
		expect(matrix[0]![labelCol("B-dependent_locality")]).toBe(6.0)
	})
})

describe("buildPlacetypePairPriors — matrix-cell exactness", () => {
	it("biases the child window's B-tag (first piece) / I-tag (rest) toward the resolved tag", () => {
		const index = mockPairIndex({ "shoreditch|london": "dependent_locality" }, 6.0)
		const pieces = makePieces("shoreditch london") // pieces[0]=shoreditch, pieces[1]=london
		const matrix = buildPlacetypePairPriors({ index, probeMode: "window" }, pieces, LABELS)

		expect(matrix[0]![labelCol("B-dependent_locality")]).toBe(6.0)
		// Single-piece window: no I- piece to write, and no OTHER cell on piece 0 should move.
		expect(matrix[0]!.filter((v) => v !== 0)).toHaveLength(1)
		// "london" never resolves as a child of anything in this index — untouched.
		expect(matrix[1]!.every((v) => v === 0)).toBe(true)
	})

	it("writes B- on the first piece and I- on every subsequent piece of a multi-piece window", () => {
		// "new york" as a 2-word CHILD window (3 pieces total across the two words) under parent "ny".
		const index = mockPairIndex({ "new york|ny": "locality" }, 4.0)
		const pieces = makePieces("new york ny") // pieces[0]=new, pieces[1]=york, pieces[2]=ny
		const matrix = buildPlacetypePairPriors({ index, probeMode: "window" }, pieces, LABELS)

		expect(matrix[0]![labelCol("B-locality")]).toBe(4.0)
		expect(matrix[1]![labelCol("I-locality")]).toBe(4.0)
	})

	it("resolves the bias magnitude from index.delta, falling back to biasScale when delta is absent", () => {
		const withDelta = mockPairIndex({ "shoreditch|london": "dependent_locality" }, 6.0)
		const withoutDelta = mockPairIndex({ "shoreditch|london": "dependent_locality" }, undefined)
		const pieces = makePieces("shoreditch london")

		const a = buildPlacetypePairPriors({ index: withDelta, biasScale: 9.9, probeMode: "window" }, pieces, LABELS)
		const b = buildPlacetypePairPriors({ index: withoutDelta, biasScale: 2.5, probeMode: "window" }, pieces, LABELS)

		expect(a[0]![labelCol("B-dependent_locality")]).toBe(6.0) // index.delta wins over biasScale
		expect(b[0]![labelCol("B-dependent_locality")]).toBe(2.5) // biasScale is the fallback
	})
})

describe("buildPlacetypePairPriors — comma-free multi-word parent (3-word window, N=3)", () => {
	it('matches child "fishburn" against the 3-word parent window "stockton on tees"', () => {
		const index = mockPairIndex({ "fishburn|stockton on tees": "dependent_locality" }, 6.0)
		const pieces = makePieces("fishburn stockton on tees")
		const matrix = buildPlacetypePairPriors({ index, probeMode: "window" }, pieces, LABELS)

		// pieces[0] = "fishburn" (the child, 1-word window)
		expect(matrix[0]![labelCol("B-dependent_locality")]).toBe(6.0)
		// The 3-word parent window itself never resolves as a CHILD of anything in this index.
		expect(matrix[1]!.every((v) => v === 0)).toBe(true)
		expect(matrix[2]!.every((v) => v === 0)).toBe(true)
		expect(matrix[3]!.every((v) => v === 0)).toBe(true)
	})
})

describe("buildPlacetypePairPriors — marker suppression", () => {
	it('suppresses a window immediately followed by a structural marker ("road") — no bias even though it would match', () => {
		const index = mockPairIndex({ "church|sometown": "dependent_locality" }, 6.0)
		const pieces = makePieces("church road sometown")
		const matrix = buildPlacetypePairPriors({ index, probeMode: "window" }, pieces, LABELS)

		// "church" is immediately followed by "road" (a structural marker: street-suffix reading, e.g.
		// "Church Road") — the window must never even be probed as a candidate child.
		expect(matrix[0]!.every((v) => v === 0)).toBe(true)
	})

	it("the SAME child/parent pair DOES bias when no marker sits between them", () => {
		const index = mockPairIndex({ "church|sometown": "dependent_locality" }, 6.0)
		const pieces = makePieces("church sometown") // no marker word in between
		const matrix = buildPlacetypePairPriors({ index, probeMode: "window" }, pieces, LABELS)

		expect(matrix[0]![labelCol("B-dependent_locality")]).toBe(6.0)
	})

	it("suppresses a window immediately followed by a house-number-shaped token", () => {
		const index = mockPairIndex({ "flat|sometown": "dependent_locality" }, 6.0)
		const pieces = makePieces("flat 5 sometown")
		const matrix = buildPlacetypePairPriors({ index, probeMode: "window" }, pieces, LABELS)

		expect(matrix[0]!.every((v) => v === 0)).toBe(true)
	})
})

describe("buildPlacetypePairPriors — dual-key probe (hyphen/space cross-form)", () => {
	it("matches a concat-keyed index entry from a space-written multi-word window (Fix 2)", () => {
		// The index was built (hypothetically) from a source register that recorded the parent as the
		// hyphenated "Stockton-on-Tees" — `normalizeFSTToken` strips the hyphens, so its fold is the bare
		// concatenation "stocktonontees" with no interior space. The QUERY writes the same place with
		// spaces, so it groups into three words and its space-joined window key ("stockton on tees") never
		// equals the index's concatenated key. Only the dual-key probe's concat form bridges the two.
		const index = mockPairIndex({ "fishburn|stocktonontees": "dependent_locality" }, 6.0)
		const pieces = makePieces("fishburn stockton on tees")
		const matrix = buildPlacetypePairPriors({ index, probeMode: "window" }, pieces, LABELS)

		expect(matrix[0]![labelCol("B-dependent_locality")]).toBe(6.0)
		// Prove the concat form was actually what hit — the space-joined form for this exact pair was probed
		// too (and missed).
		expect(index.calls).toContainEqual(["fishburn", "stockton on tees"])
		expect(index.calls).toContainEqual(["fishburn", "stocktonontees"])
	})

	it("a hyphen-written query (single word-group post Fix-1) matches the same concat-keyed entry directly", async () => {
		// "Stockton-on-Tees" collapses to ONE word group after Fix 1 (the interior-punctuation fix), so its
		// own fold IS "stocktonontees" — space form and concat form are the same string for a single-word
		// window, and the match needs no fallback at all. This pins the Fix-1/Fix-2 interplay: the grouping
		// fix is what makes the hyphenated query's own single-token fold equal the index's concatenated key.
		const tokenizer = await MailwomanTokenizer.loadFromFile(
			repoRootPath("neural", "test", "fixtures", "tokenizer-v0.1.0.model")
		)
		const { pieces } = tokenizer.encode("Fishburn Stockton-on-Tees")
		const index = mockPairIndex({ "fishburn|stocktonontees": "dependent_locality" }, 6.0)
		const matrix = buildPlacetypePairPriors({ index, probeMode: "window" }, pieces, LABELS)

		expect(matrix[0]![labelCol("B-dependent_locality")]).toBe(6.0)
	})
})

describe("buildPlacetypePairPriors — marker-scope regression (Fix 3, reviewer Important #2)", () => {
	it("suppression is CHILD-role-only: a marker word does NOT suppress a window it appears in as the PARENT", () => {
		// The window "Ashworth" is immediately followed by "House" — a structural marker — so if
		// `isMarkerSuppressed` were (incorrectly) also consulted for the Y (parent) role, this pair would
		// never fire: "Ashworth" would be excluded from the probe loop before `index.probe` ever ran. The
		// suppression check must only ever gate the X (child) window; "Ashworth" is disjoint from "sometown"
		// and IS "sometown"'s child-role partner here, not the other way around, so it's fine for it to sit
		// next to "House" in the source text.
		const index = mockPairIndex({ "sometown|ashworth": "dependent_locality" }, 6.0)
		const pieces = makePieces("sometown Ashworth House")
		const matrix = buildPlacetypePairPriors({ index, probeMode: "window" }, pieces, LABELS)

		expect(matrix[0]![labelCol("B-dependent_locality")]).toBe(6.0)
		// Confirm it was ACTUALLY probed (not merely defaulting to some other match) — "ashworth" alone,
		// not "ashworth house", is what resolved the tag.
		expect(index.calls).toContainEqual(["sometown", "ashworth"])
	})

	it('suppression STILL applies to the CHILD role: "Ashworth" followed by "House" is never probed as a child', () => {
		// Same index, same words, but now "Ashworth" is asked to play the CHILD role against "sometown" as
		// parent — this is the class the marker table exists to close ("Ashworth House" reading as a venue,
		// not the place "Ashworth"). The window must never even be probed.
		const index = mockPairIndex({ "ashworth|sometown": "dependent_locality" }, 6.0)
		const pieces = makePieces("Ashworth House sometown")
		const matrix = buildPlacetypePairPriors({ index, probeMode: "window" }, pieces, LABELS)

		expect(matrix[0]!.every((v) => v === 0)).toBe(true)
		expect(index.calls.some(([child]) => child === "ashworth")).toBe(false)
	})
})

describe("buildPlacetypePairPriors — disjointness", () => {
	it("never pairs two OVERLAPPING candidate windows, even when the index has an entry for that exact pair", () => {
		// A contrived index entry keyed on two windows that would overlap ("a b" / "b c" both cover the
		// middle word "b") — the disjointness rule must reject this pairing regardless.
		const index = mockPairIndex({ "a b|b c": "locality" }, 6.0)
		const pieces = makePieces("a b c")
		const matrix = buildPlacetypePairPriors({ index, probeMode: "window" }, pieces, LABELS)

		for (const row of matrix) {
			expect(row.every((v) => v === 0)).toBe(true)
		}
	})
})

describe("buildPlacetypePairPriors — dual-key tie-break (fix round 2, re-review adjudication-3 minor)", () => {
	it("prefers the space-joined form when it and the concatenated form would resolve to DIFFERENT tags", () => {
		// A real index can't disagree with itself about the same real-world pair, but `probeWindowPair`'s
		// search order is what actually GUARANTEES the stated preference rather than leaving it to chance:
		// space/space is tried before any combination involving a concat form, so a hit there short-circuits
		// before the concat form is ever probed.
		const index = mockPairIndex({ "x|a b": "locality", "x|ab": "region" }, 6.0)
		const pieces = makePieces("x a b")
		const matrix = buildPlacetypePairPriors({ index, probeMode: "window" }, pieces, LABELS)

		// "x" (piece 0) resolves to "locality" (the space-joined "a b" hit), never "region".
		expect(matrix[0]![labelCol("B-locality")]).toBe(6.0)
		expect(matrix[0]![labelCol("B-region")]).toBe(0)
		// The concatenated form was never even attempted — the space/space hit short-circuited first.
		expect(index.calls).toContainEqual(["x", "a b"])
		expect(index.calls).not.toContainEqual(["x", "ab"])
	})
})

describe("buildPlacetypePairPriors — end-to-end cross-form regression (fix round 2, real PIX1 round trip)", () => {
	// Item 3 of the fix-round-2 brief: a REAL PairIndexBuilder-shaped entry, through a REAL tokenizer, through
	// the REAL PIX1 serialize/deserialize round trip — not a hand-built `PairIndexLike` double. This is the
	// case that was structurally impossible to express with `makePieces` (one synthetic ▁-per-word piece each
	// — it can't reproduce a genuine bare-▁-orphan split) and that fix round 1's mock-only coverage therefore
	// never exercised.
	//
	// The entry below is not re-derived by calling `PairIndexBuilder` here: that class lives in the `mailwoman`
	// workspace (CLI/gazetteer tooling), which depends on `@mailwoman/neural` — not the reverse — and
	// `placetype-pair-prior.ts` has no exported package subpath for `mailwoman` to import back into, so
	// instantiating it from `neural/`'s own test suite would invert the dependency direction. Instead this
	// hard-codes the EXACT (child, parent, tag) triple `PairIndexBuilder.addRow("Fishburn", "Stockton-on-Tees")`
	// produces — pinned verbatim by `mailwoman/gazetteer-pipeline/pair-index.test.ts`'s "folds CITY/DISTRICT
	// through normalizeFSTToken and tags dependent_locality" test (`{ child: "fishburn", parent:
	// "stocktonontees", tag: "dependent_locality" }`) — and feeds it through the REAL `serializePairIndex` /
	// `PairIndexResolver` binary round trip. If the builder's fold ever drifts, that sibling test catches it;
	// this test locks in that the DECODE side (tokenizer → groupPiecesIntoWords → dual-key window probe →
	// real PIX1 resolver) resolves it correctly once it exists.
	const REAL_BUILDER_ENTRIES: PairIndexEntry[] = [
		{ child: "fishburn", parent: "stocktonontees", tag: "dependent_locality" },
	]
	const REAL_HEADER: PairIndexHeader = {
		country: "gb",
		delta: 6.0,
		schemaVersion: 1,
		foldVersion: 1,
		sourceMD5s: [],
		buildDate: "2026-07-22",
	}

	it('a space-typed query ("Fishburn Stockton on Tees") resolves against the hyphen-folded real index entry, fixture tokenizer', async () => {
		const bytes = serializePairIndex(REAL_HEADER, REAL_BUILDER_ENTRIES)
		const index = new PairIndexResolver(bytes)

		const tokenizer = await MailwomanTokenizer.loadFromFile(FIXTURE_TOKENIZER_PATH)
		// Real split: ["▁F","ish","burn","▁Stock","ton","▁","on","▁Te","es"] — the bare "▁" before "on" is
		// exactly the pattern fix round 2 recovers; pre-fix, "on" would vanish and the 3-word parent window
		// "stockton on tees" would never even be built, let alone probed.
		const { pieces } = tokenizer.encode("Fishburn Stockton on Tees")
		const matrix = buildPlacetypePairPriors({ index, probeMode: "window" }, pieces, LABELS)

		expect(matrix[0]![labelCol("B-dependent_locality")]).toBe(6.0)
	})

	test.skipIf(!haveProductionTokenizer)(
		'a space-typed query ("Fishburn Stockton on Tees") resolves against the same real index entry, PRODUCTION tokenizer',
		async () => {
			const bytes = serializePairIndex(REAL_HEADER, REAL_BUILDER_ENTRIES)
			const index = new PairIndexResolver(bytes)

			const tokenizer = await MailwomanTokenizer.loadFromFile(PRODUCTION_TOKENIZER_PATH)
			// Real split: ["▁Fish","burn","▁Stockton","▁","on","▁","Tees"] — same bare-▁-orphan shape, on the
			// tokenizer the re-review actually found this bug against.
			const { pieces } = tokenizer.encode("Fishburn Stockton on Tees")
			const matrix = buildPlacetypePairPriors({ index, probeMode: "window" }, pieces, LABELS)

			expect(matrix[0]![labelCol("B-dependent_locality")]).toBe(6.0)
		}
	)
})

describe("buildPlacetypePairPriors — segment mode (Task 6; the v1 default, now the ≥2-segment leg of the auto chain)", () => {
	it('a venue-EMBEDDED name does NOT fire — "Queens Park Academy" (one segment, no internal comma) never reduces to the census child "queens park"', () => {
		// The actual Task-6 venue-confound board FP verbatim (window mode): "Queens Park Academy, Queens Park
		// Academy Chestnut Avenue, Chester, MK40 4HA" wrongly emitted dependent_locality=["Queens Park"] because
		// window mode probes every 1..3-word sub-run, including "Queens Park" INSIDE the longer venue phrase.
		// Segment mode's only candidate for that field is the WHOLE 3-word segment "queens park academy" — which
		// never equals the census's 2-word "queens park" entry, under either fold form.
		const index = mockPairIndex({ "queens park|chester": "dependent_locality" }, 6.0)
		const text = "Queens Park Academy, Chestnut Avenue, Chester"
		const pieces = makePiecesWithCommas(text)
		// probeMode omitted — segment is the default. `inputText` is how segment mode finds the commas (mirrors
		// query-shape-prior.ts's `BuildPriorsOpts.inputText`; classifier.ts's `#decode` supplies it automatically
		// via the real parse path — see that call site).
		const matrix = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		for (const row of matrix) {
			expect(row.every((v) => v === 0)).toBe(true)
		}
		// Prove it structurally: "queens park" (the census's actual child key) was never even attempted as a
		// probe key — only the whole-segment folds ("queens park academy" / "queensparkacademy") were.
		expect(index.calls.some(([child]) => child === "queens park")).toBe(false)
	})

	it("a segment-EXACT name DOES fire — a bare census child occupying its own comma-delimited field", () => {
		// The honestly-reported residual FP class from the task-6 report: this is ALSO the shape of a genuine
		// false positive when a non-venue field (e.g. a street name) happens to equal a bare census child
		// verbatim ("Moelfre B & B, Moelfre, Abergele, SY20 8LF" — the street field is literally "Moelfre"). The
		// mechanism is purely textual/segmental, not semantic, so the same shape that defeats the venue-confound
		// class here is indistinguishable from that residual case — both are "a whole segment folds to an exact
		// census key."
		const index = mockPairIndex({ "moelfre|abergele": "dependent_locality" }, 6.0)
		const text = "Moelfre, Abergele"
		const pieces = makePiecesWithCommas(text)
		const matrix = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		expect(matrix[0]![labelCol("B-dependent_locality")]).toBe(6.0)
	})

	it("dual-key probe still applies at SEGMENT granularity (hyphen/space cross-form, whole multi-word segment)", () => {
		// "Stockton on Tees" is a 3-word segment (no internal comma); the index was built from a hyphenated
		// source ("Stockton-on-Tees" -> concat fold "stocktonontees"). Segment mode must still try the whole
		// segment's concat form, not just its space-joined form — same dual-key contract as window mode, applied
		// to the segment as a single unit instead of to 1..3-word sub-windows.
		const index = mockPairIndex({ "fishburn|stocktonontees": "dependent_locality" }, 6.0)
		const text = "Fishburn, Stockton on Tees"
		const pieces = makePiecesWithCommas(text)
		const matrix = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		expect(matrix[0]![labelCol("B-dependent_locality")]).toBe(6.0)
		// The space-joined whole-segment form was tried and missed; the concat form is what actually hit.
		expect(index.calls).toContainEqual(["fishburn", "stockton on tees"])
		expect(index.calls).toContainEqual(["fishburn", "stocktonontees"])
	})

	it("comma-free input: explicit segment mode stays inert; the auto default reaches the anchored path; window opt-in unchanged", () => {
		const index = mockPairIndex({ "shoreditch|london": "dependent_locality" }, 6.0)
		const pieces = makePieces("Shoreditch London") // no comma — one segment, start to finish

		// Explicit "segment": no internal comma means "Shoreditch London" is ONE segment, and a single candidate
		// can never form a pair with itself — inert, per the documented v1 comma-free trade-off.
		const segmentMatrix = buildPlacetypePairPriors({ index, probeMode: "segment" }, pieces, LABELS)

		for (const row of segmentMatrix) {
			expect(row.every((v) => v === 0)).toBe(true)
		}

		// The "auto" default (v1.1 probe chain): <2 segments hands off to the anchored path — string-final parent
		// "london", adjacent child "shoreditch" → biased. The population segment mode left inert is exactly the
		// population the chain's second leg now serves.
		const autoMatrix = buildPlacetypePairPriors({ index }, pieces, LABELS)

		expect(autoMatrix[0]![labelCol("B-dependent_locality")]).toBe(6.0)

		// Explicit opt-in: the original sub-window behavior is unchanged and still resolves the same pair.
		const windowMatrix = buildPlacetypePairPriors({ index, probeMode: "window" }, pieces, LABELS)

		expect(windowMatrix[0]![labelCol("B-dependent_locality")]).toBe(6.0)
	})
})

describe("buildPlacetypePairPriors — marker suppression must not cross segment boundaries (final-review fix)", () => {
	it('reviewer repro: "Fishburn, 5 Fishburn Road" biases Fishburn — successor "5" is in the NEXT segment, so it must never suppress', () => {
		// Segment 0 is "Fishburn" alone; segment 1 is the whole 3-word "5 Fishburn Road" (no internal comma). Before
		// the fix, `isMarkerSuppressed` read `nonEmptyGroups[x.endPos + 1]` unconditionally — for segment 0's
		// candidate ("Fishburn"), that's segment 1's FIRST word ("5"), a house-number shape, which wrongly vetoed
		// "Fishburn" before it was ever probed. The comma between them means "5" can never be a suffix of
		// "Fishburn" in the source text, so suppression must not fire.
		const index = mockPairIndex({ "fishburn|5 fishburn road": "dependent_locality" }, 6.0)
		const text = "Fishburn, 5 Fishburn Road"
		const pieces = makePiecesWithCommas(text)
		const matrix = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		expect(matrix[0]![labelCol("B-dependent_locality")]).toBe(6.0)
		// Prove it structurally: "fishburn" WAS attempted as a child probe (not silently vetoed).
		expect(index.calls.some(([child]) => child === "fishburn")).toBe(true)
	})

	it('control: WINDOW mode marker suppression is unaffected by comma placement — "Fishburn Road, Leeds" still suppresses "Fishburn" (successor "Road" IS in the same clause)', () => {
		// Window mode never consulted segment boundaries before this fix and must not start now — "Fishburn"
		// immediately followed by "Road" (the structural marker) is still suppressed regardless of the later comma.
		const index = mockPairIndex({ "fishburn|leeds": "dependent_locality" }, 6.0)
		const text = "Fishburn Road, Leeds"
		const pieces = makePiecesWithCommas(text)
		const matrix = buildPlacetypePairPriors({ index, probeMode: "window", inputText: text }, pieces, LABELS)

		for (const row of matrix) {
			expect(row.every((v) => v === 0)).toBe(true)
		}
		expect(index.calls.some(([child]) => child === "fishburn")).toBe(false)
	})

	it('control: SEGMENT mode on "Fishburn Road, Leeds" still correctly withholds bias from bare "fishburn" — the whole-segment fusion (not marker suppression) is what protects this shape', () => {
		// "Fishburn Road" is ONE whole-segment candidate (key "fishburn road" / concat "fishburnroad") — it never
		// equals the index's bare "fishburn" key under either fold form, so this stays unbiased regardless of the
		// segment-boundary fix above. Locks down that the fix didn't accidentally make this MORE permissive.
		const index = mockPairIndex({ "fishburn|leeds": "dependent_locality" }, 6.0)
		const text = "Fishburn Road, Leeds"
		const pieces = makePiecesWithCommas(text)
		const matrix = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		for (const row of matrix) {
			expect(row.every((v) => v === 0)).toBe(true)
		}
		expect(index.calls.some(([child]) => child === "fishburn")).toBe(false)
	})
})

describe("buildPlacetypePairPriors — paired punctuation (Task 9 audit, real fixture tokenizer)", () => {
	// Segment mode's own doc comment claims a quoted venue is "one segment... which never equals the census's...
	// entry" for the VENUE-CONFOUND class specifically. These cases check the OTHER direction: when the quoted text
	// itself IS the real place name (occupying its own comma-delimited field, same shape as any other segment-exact
	// match), the probe key must fold to the CLEAN word text — the wrapping quote/bracket/brace/guillemet chars must
	// never survive into the index probe key, or a real match silently misses (a false negative the arc's own
	// "recall, not precision" framing would treat as a genuine gap).

	it('a quoted venue segment (\'"The Grange", Fishburn\') probes the CLEAN fold "the grange" — no leftover quote chars', async () => {
		const index = mockPairIndex({ "the grange|fishburn": "dependent_locality" }, 6.0)
		const text = '"The Grange", Fishburn'
		const tokenizer = await MailwomanTokenizer.loadFromFile(FIXTURE_TOKENIZER_PATH)
		const { pieces } = tokenizer.encode(text)
		const matrix = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		expect(matrix[0]!.some((v) => v > 0) || matrix.some((row) => row[labelCol("B-dependent_locality")]! > 0)).toBe(true)
		// The probe key is the clean fold, not '"the grange"' / 'the grange"' / any quote-contaminated variant.
		expect(index.calls.some(([child]) => child === "the grange")).toBe(true)
		expect(index.calls.some(([child]) => child.includes('"'))).toBe(false)
	})

	it("a bracketed segment ('[Block B], Fishburn') probes the clean fold \"block b\"", async () => {
		const index = mockPairIndex({ "block b|fishburn": "dependent_locality" }, 6.0)
		const text = "[Block B], Fishburn"
		const tokenizer = await MailwomanTokenizer.loadFromFile(FIXTURE_TOKENIZER_PATH)
		const { pieces } = tokenizer.encode(text)
		const matrix = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		expect(matrix.some((row) => row[labelCol("B-dependent_locality")]! > 0)).toBe(true)
		expect(index.calls.some(([child]) => child === "block b")).toBe(true)
		expect(index.calls.some(([child]) => /[[\]]/.test(child))).toBe(false)
	})

	it("a curly-quoted segment ('\"The Grange\", Fishburn' with curly quotes) probes the SAME clean fold as straight quotes", async () => {
		// Regression guard for the byte-fallback groupPiecesIntoWords fix (Task 9): before that fix, this exact
		// case's probe key was "0xe20x800x9cthe"/"grange0xe20x800x9d" — garbage that could never match a real
		// index entry, a silent false negative.
		const index = mockPairIndex({ "the grange|fishburn": "dependent_locality" }, 6.0)
		const text = "“The Grange”, Fishburn"
		const tokenizer = await MailwomanTokenizer.loadFromFile(FIXTURE_TOKENIZER_PATH)
		const { pieces } = tokenizer.encode(text)
		const matrix = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		expect(matrix.some((row) => row[labelCol("B-dependent_locality")]! > 0)).toBe(true)
		expect(index.calls.some(([child]) => child === "the grange")).toBe(true)
	})

	it("UNBALANCED quote (only an opener, no closer anywhere in the input) never crashes and still probes the clean fold", async () => {
		const index = mockPairIndex({ "the grange|fishburn": "dependent_locality" }, 6.0)
		const text = '"The Grange, Fishburn'
		const tokenizer = await MailwomanTokenizer.loadFromFile(FIXTURE_TOKENIZER_PATH)
		const { pieces } = tokenizer.encode(text)

		expect(() => buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)).not.toThrow()
		const matrix = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)
		expect(matrix.some((row) => row[labelCol("B-dependent_locality")]! > 0)).toBe(true)
	})
})

describe("buildPlacetypePairPriors — anchored adjacent-pair mode (v1.1 probe chain, 2026-07-24 design)", () => {
	it("comma-free adjacent pair + postcode: child biased, parent (and postcode) untouched — anchor sits left of the WHOLE postcode span", () => {
		const index = mockPairIndex({ "fishburn|stockton on tees": "dependent_locality" }, 6.0)
		// GB outward+inward = TWO tokens ("TS21" + "3AB") — the parent anchor must end left of both, at "Tees".
		const text = "St Bedes Avenue Fishburn Stockton on Tees TS21 3AB"
		const pieces = makePieces(text) // 0=st 1=bedes 2=avenue 3=fishburn 4=stockton 5=on 6=tees 7=ts21 8=3ab
		const matrix = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		expect(matrix[3]![labelCol("B-dependent_locality")]).toBe(6.0)

		// Everything that isn't the child — street prefix, the parent's own words, the postcode — stays untouched.
		for (const i of [0, 1, 2, 4, 5, 6, 7, 8]) {
			expect(matrix[i]!.every((v) => v === 0)).toBe(true)
		}
		expect(index.calls).toContainEqual(["fishburn", "stockton on tees"])
	})

	it("comma-free, no postcode: the string-final window is the parent anchor; explicit probeMode 'anchored' matches the auto default", () => {
		const index = mockPairIndex({ "fishburn|stockton on tees": "dependent_locality" }, 6.0)
		const text = "St Bedes Avenue Fishburn Stockton on Tees"
		const pieces = makePieces(text)
		const autoMatrix = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		expect(autoMatrix[3]![labelCol("B-dependent_locality")]).toBe(6.0)

		for (const i of [0, 1, 2, 4, 5, 6]) {
			expect(autoMatrix[i]!.every((v) => v === 0)).toBe(true)
		}

		// "anchored" is a first-class explicit value (harness use) — identical to the chain's comma-free leg.
		const explicitMatrix = buildPlacetypePairPriors({ index, probeMode: "anchored", inputText: text }, pieces, LABELS)

		expect(explicitMatrix).toEqual(autoMatrix)
	})

	it("chain equivalence: a comma'd input under the auto default is byte-identical to explicit segment mode — matrices AND probe-call sequences", () => {
		// Positive case: a genuine segment-exact pair.
		const hitEntries = { "moelfre|abergele": "dependent_locality" }
		const hitText = "Moelfre, Abergele"
		const hitPieces = makePiecesWithCommas(hitText)
		const hitAuto = mockPairIndex(hitEntries, 6.0)
		const hitSegment = mockPairIndex(hitEntries, 6.0)
		const autoMatrix = buildPlacetypePairPriors({ index: hitAuto, inputText: hitText }, hitPieces, LABELS)
		const segmentMatrix = buildPlacetypePairPriors(
			{ index: hitSegment, probeMode: "segment", inputText: hitText },
			hitPieces,
			LABELS
		)

		expect(autoMatrix).toEqual(segmentMatrix)
		expect(autoMatrix[0]![labelCol("B-dependent_locality")]).toBe(6.0)
		// Not just the same result — the same probes in the same order (the chain shares the segment path's code).
		expect(hitAuto.calls).toEqual(hitSegment.calls)

		// Zero case: the venue-confound shape stays zero on BOTH, with identical probe sequences.
		const venueEntries = { "queens park|chester": "dependent_locality" }
		const venueText = "Queens Park Academy, Chestnut Avenue, Chester"
		const venuePieces = makePiecesWithCommas(venueText)
		const venueAuto = mockPairIndex(venueEntries, 6.0)
		const venueSegment = mockPairIndex(venueEntries, 6.0)
		const venueAutoMatrix = buildPlacetypePairPriors({ index: venueAuto, inputText: venueText }, venuePieces, LABELS)
		const venueSegmentMatrix = buildPlacetypePairPriors(
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
		const index = mockPairIndex({ "queens park|chester": "dependent_locality" }, 6.0)
		const text = "Queens Park Cafe Queens Park Chester"
		const pieces = makePieces(text) // 0=queens 1=park 2=cafe 3=queens 4=park 5=chester
		const matrix = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		// The venue's own "Queens Park" (positions 0-1) and "Cafe" stay untouched — that text is never
		// immediately left of the parent anchor, so it is rejected by construction, not by suppression.
		for (const i of [0, 1, 2]) {
			expect(matrix[i]!.every((v) => v === 0)).toBe(true)
		}

		// The true adjacent occurrence (positions 3-4, immediately left of the string-final "Chester") fires.
		expect(matrix[3]![labelCol("B-dependent_locality")]).toBe(6.0)
		expect(matrix[4]![labelCol("I-dependent_locality")]).toBe(6.0)
		expect(matrix[5]!.every((v) => v === 0)).toBe(true)
	})

	it('left-maximality: with both ("cadbury","yeovil") and ("north cadbury","yeovil") in the index, the 2-word child wins and there is no double bias', () => {
		const index = mockPairIndex(
			{ "cadbury|yeovil": "dependent_locality", "north cadbury|yeovil": "dependent_locality" },
			6.0
		)
		const text = "North Cadbury Yeovil"
		const pieces = makePieces(text) // 0=north 1=cadbury 2=yeovil
		const matrix = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		expect(matrix[0]![labelCol("B-dependent_locality")]).toBe(6.0)
		expect(matrix[1]![labelCol("I-dependent_locality")]).toBe(6.0)
		// No partial-child probe: a bare-"cadbury" hit would have written B- on position 1.
		expect(matrix[1]![labelCol("B-dependent_locality")]).toBe(0)
		expect(matrix[2]!.every((v) => v === 0)).toBe(true)
		// Longest-match-first means the shorter child was never even probed against the shared parent.
		expect(index.calls).not.toContainEqual(["cadbury", "yeovil"])
	})

	it('a 4-word child fires under the anchored cap ("Knott End on Sea" class — wider than WINDOW_MAX_WORDS on purpose)', () => {
		const index = mockPairIndex({ "knott end on sea|lancaster": "dependent_locality" }, 6.0)
		const text = "Knott End on Sea Lancaster"
		const pieces = makePieces(text) // 0=knott 1=end 2=on 3=sea 4=lancaster
		const matrix = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		expect(matrix[0]![labelCol("B-dependent_locality")]).toBe(6.0)

		for (const i of [1, 2, 3]) {
			expect(matrix[i]![labelCol("I-dependent_locality")]).toBe(6.0)
		}
		expect(matrix[4]!.every((v) => v === 0)).toBe(true)
	})

	it('marker suppression applies to the anchored child: "church" followed by "road" is never probed', () => {
		// Contrived entry keyed so the pair WOULD hit if the child were probed — the marker successor ("road",
		// the parent's own first word) is what must block it, exactly as window mode suppresses.
		const index = mockPairIndex({ "church|road end": "dependent_locality" }, 6.0)
		const text = "Church Road End"
		const pieces = makePieces(text)
		const matrix = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		for (const row of matrix) {
			expect(row.every((v) => v === 0)).toBe(true)
		}
		expect(index.calls.some(([child]) => child === "church")).toBe(false)
	})

	it("control: the SAME geometry without a marker successor probes and fires — the marker, not the adjacency, blocked above", () => {
		const index = mockPairIndex({ "church|lane end": "dependent_locality" }, 6.0)
		const text = "Church Lane End"
		const pieces = makePieces(text)
		const matrix = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		expect(matrix[0]![labelCol("B-dependent_locality")]).toBe(6.0)
		expect(index.calls).toContainEqual(["church", "lane end"])
	})

	it("no-hit comma-free input (no postcode shape, no pair anywhere) returns the exact zero matrix", () => {
		const index = mockPairIndex({ "somewhere|else": "dependent_locality" }, 6.0)
		const text = "Totally Unrelated Words Here"
		const pieces = makePieces(text)
		const matrix = buildPlacetypePairPriors({ index, inputText: text }, pieces, LABELS)

		expect(matrix).toHaveLength(4)

		// Strict ===, per the matrixHasBias contract: every cell is the number 0, not merely falsy.
		for (const row of matrix) {
			expect(row.every((v) => v === 0)).toBe(true)
		}
	})
})

describe("buildPlacetypePairPriors — probeTrace (which chain leg fired)", () => {
	it('records "segment" on a comma\'d hit, "anchored" on a comma-free hit, and stays unset on a miss', () => {
		const entries = { "moelfre|abergele": "dependent_locality" }

		const segmentTrace: PlacetypePairProbeTrace = {}
		const commaText = "Moelfre, Abergele"
		buildPlacetypePairPriors(
			{ index: mockPairIndex(entries, 6.0), inputText: commaText, probeTrace: segmentTrace },
			makePiecesWithCommas(commaText),
			LABELS
		)
		expect(segmentTrace.firedPath).toBe("segment")

		const anchoredTrace: PlacetypePairProbeTrace = {}
		const bareText = "Moelfre Abergele"
		buildPlacetypePairPriors(
			{ index: mockPairIndex(entries, 6.0), inputText: bareText, probeTrace: anchoredTrace },
			makePieces(bareText),
			LABELS
		)
		expect(anchoredTrace.firedPath).toBe("anchored")

		const missTrace: PlacetypePairProbeTrace = {}
		const missText = "Totally Unrelated Words"
		buildPlacetypePairPriors(
			{ index: mockPairIndex(entries, 6.0), inputText: missText, probeTrace: missTrace },
			makePieces(missText),
			LABELS
		)
		expect(missTrace.firedPath).toBeUndefined()
	})

	it('records "window" when the opt-in window mode produced the bias', () => {
		const windowTrace: PlacetypePairProbeTrace = {}
		buildPlacetypePairPriors(
			{
				index: mockPairIndex({ "shoreditch|london": "dependent_locality" }, 6.0),
				probeMode: "window",
				probeTrace: windowTrace,
			},
			makePieces("Shoreditch London"),
			LABELS
		)
		expect(windowTrace.firedPath).toBe("window")
	})
})
