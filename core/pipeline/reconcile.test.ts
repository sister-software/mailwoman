/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Kryptonite-catalogue + contract tests for `reconcileSpans` (Stage 5 joint decode).
 *
 *   Each "kryptonite — <case>" describe block compares two parses for the same input:
 *
 *   - **Pre-reconcile**: what the existing Stage 5 (sort spans by start, accept classifier argmax)
 *       produces. This is the known-wrong baseline.
 *   - **Post-reconcile**: what `reconcileSpans` produces. The assertion is that the joint decode
 *       repairs the incongruence — the resulting parse is internally consistent with the
 *       gazetteer's parent_id chain.
 *
 *   Test names are written to be grep-able so the kryptonite catalogue is discoverable from the
 *   command line:
 *
 *   ```
 *   grep -r "kryptonite —" core/pipeline/reconcile.test.ts
 * ```
 *
 *   The Thread C-s classifier top-k contract is mocked locally — hand-built `ClassifierCandidate`
 *   arrays that simulate the real classifier's top-k emission. The WOF gazetteer parent_id chain is
 *   mocked with `mockChain` — a small in-memory tree mirroring the WOF hierarchy for the entities
 *   we test against. When Thread C-s lands, integration tests in `@mailwoman/neural` swap to the
 *   real classifier; the unit tests below stay on the mock so they remain bitter-lesson-safe.
 */

import { describe, expect, it } from "vitest"

import type { ComponentTag } from "../decoder/types.js"
import type { ResolvedPlace } from "../resolver/types.js"
import { Span } from "../tokenization/index.js"
import {
	reconcileSpans,
	type ClassifierCandidate,
	type ParentChainLookup,
	type ResolverCandidatesLookup,
} from "./reconcile.js"
import type { PhraseProposal } from "./types.js"

// ---------- Test helpers ----------

function span(text: string, start: number, end: number) {
	return Span.from(text.slice(start, end), { start })
}

function proposal(
	s: { start: number; end: number; body: string } | Span,
	kind: PhraseProposal["kindHypothesis"],
	confidence: number
): PhraseProposal {
	const sp = s instanceof Span ? s : Span.from(s.body, { start: s.start })

	return { span: sp as PhraseProposal["span"], kindHypothesis: kind, confidence }
}

function tagC(start: number, end: number, tag: ComponentTag, score: number): ClassifierCandidate {
	return { span: { start, end }, tag, score }
}

interface MockPlace extends ResolvedPlace {
	id: number
}

function place(
	id: number,
	name: string,
	placetype: string,
	country: string,
	lat: number,
	lon: number,
	parent_id?: number,
	score = 1
): MockPlace {
	return { id, name, placetype, country, lat, lon, parent_id, score }
}

/**
 * Build a `ResolverCandidatesLookup` from a list of `(spanStart, spanEnd, tag, ResolvedPlace[])` tuples. Order in the
 * place array is preserved — first place wins ties.
 */
function mockResolver(
	entries: Array<[start: number, end: number, tag: ComponentTag, places: ResolvedPlace[]]>
): ResolverCandidatesLookup {
	const table = new Map<string, ResolvedPlace[]>()

	for (const [s, e, t, places] of entries) {
		table.set(`${s}:${e}:${t}`, places)
	}

	return {
		candidatesFor(span, tag) {
			return table.get(`${span.start}:${span.end}:${tag}`) ?? []
		},
	}
}

/**
 * Build a `ParentChainLookup` from a list of WOF-like places where each carries a `parent_id`. Walks `parent_id` up the
 * chain until null/missing.
 */
function mockChain(places: ResolvedPlace[]): ParentChainLookup {
	const byId = new Map<string, ResolvedPlace>()

	for (const p of places) {
		byId.set(String(p.id), p)
	}

	return {
		parentsOf(place) {
			const chain: ResolvedPlace[] = []
			let cur: ResolvedPlace | undefined = place

			while (cur && cur.parent_id !== undefined && cur.parent_id !== null) {
				const next = byId.get(String(cur.parent_id))

				if (!next || chain.some((c) => String(c.id) === String(next.id))) break
				chain.push(next)
				cur = next
			}

			return chain
		},
	}
}

/**
 * Simulate the existing Stage 5 (pre-reconcile): take the highest-scoring classifier candidate per span (argmax over
 * tags), keep them in start order. No concordance, no resolver disambiguation. Returns the chosen tags in source order
 * for assertion against the post-reconcile output.
 */
function preReconcileTags(
	phraseProposals: ReadonlyArray<PhraseProposal>,
	classifierTopK: ReadonlyArray<ClassifierCandidate>
): Array<{ start: number; end: number; tag: ComponentTag }> {
	const seen = new Set<string>()
	const out: Array<{ start: number; end: number; tag: ComponentTag }> = []
	const ordered = classifierTopK.slice().sort((a, b) => b.score - a.score)

	for (const c of ordered) {
		const key = `${c.span.start}:${c.span.end}`

		if (seen.has(key)) continue
		// Only keep the candidate if it backs a real phrase proposal.
		const hasPhrase = phraseProposals.some((p) => p.span.start === c.span.start && p.span.end === c.span.end)

		if (!hasPhrase) continue
		seen.add(key)
		out.push({ start: c.span.start, end: c.span.end, tag: c.tag })
	}
	out.sort((a, b) => a.start - b.start)

	return out
}

// ---------- Contract tests ----------

describe("reconcileSpans — contract", () => {
	it("returns an empty tree when classifierTopK is empty", () => {
		const result = reconcileSpans({
			raw: "anything",
			phraseProposals: [proposal({ start: 0, end: 8, body: "anything" }, "LOCALITY_PHRASE", 0.7)],
			classifierTopK: [],
		})
		expect(result.tree.roots).toEqual([])
		expect(result.confidence).toBe(0)
		expect(result.runnersUp).toEqual([])
	})

	it("returns a tree with one root when one slot survives", () => {
		const raw = "10118"
		const result = reconcileSpans({
			raw,
			phraseProposals: [proposal({ start: 0, end: 5, body: raw }, "POSTCODE", 0.9)],
			classifierTopK: [tagC(0, 5, "postcode", 0.95)],
		})
		expect(result.tree.roots).toHaveLength(1)
		expect(result.tree.roots[0]?.tag).toBe("postcode")
		expect(result.tree.roots[0]?.value).toBe("10118")
	})

	it("non-overlapping span pruning keeps left-most + best-scoring", () => {
		const raw = "New York"
		// Two overlapping phrase proposals: "New York" (whole) vs "York" (right half).
		// Classifier prefers the whole-locality reading.
		const result = reconcileSpans({
			raw,
			phraseProposals: [
				proposal({ start: 0, end: 8, body: "New York" }, "LOCALITY_PHRASE", 0.85),
				proposal({ start: 4, end: 8, body: "York" }, "LOCALITY_PHRASE", 0.6),
			],
			classifierTopK: [tagC(0, 8, "locality", 0.92), tagC(4, 8, "locality", 0.4)],
		})
		expect(result.tree.roots).toHaveLength(1)
		expect(result.tree.roots[0]?.value).toBe("New York")
	})

	it("opts.beamWidth = 1 still produces a valid tree (greedy mode)", () => {
		const raw = "Paris, FR"
		const result = reconcileSpans({
			raw,
			phraseProposals: [
				proposal({ start: 0, end: 5, body: "Paris" }, "LOCALITY_PHRASE", 0.8),
				proposal({ start: 7, end: 9, body: "FR" }, "REGION_ABBREVIATION", 0.95),
			],
			classifierTopK: [tagC(0, 5, "locality", 0.9), tagC(7, 9, "country", 0.9)],
			opts: { beamWidth: 1 },
		})
		expect(result.tree.roots.length).toBeGreaterThan(0)
	})
})

// ---------- Kryptonite catalogue ----------
//
// Each fixture below is one of the operator's adversarial examples — inputs where the existing
// Stage 5 (argmax-per-span, sorted) produces a known-wrong parse because the per-span argmax
// happens to be internally inconsistent. Joint decode picks the second-best tag interpretation
// whenever it yields a parse that the gazetteer's parent_id chain admits.

describe("kryptonite catalogue — NY-NY Steakhouse, Houston, TX (post-reconcile picks venue over region)", () => {
	const raw = "NY-NY Steakhouse, Houston, TX"
	// Phrase grouper output (subset of what Thread E's kryptonite.test.ts asserts):
	//   "NY-NY"            HYPHENATED_COMPOUND  0.85
	//   "NY-NY Steakhouse" VENUE_PHRASE         0.85
	//   "Houston"          LOCALITY_PHRASE      0.65
	//   "TX"               REGION_ABBREVIATION  0.95
	const phraseProposals: PhraseProposal[] = [
		proposal({ start: 0, end: 16, body: "NY-NY Steakhouse" }, "VENUE_PHRASE", 0.85),
		proposal({ start: 0, end: 5, body: "NY-NY" }, "HYPHENATED_COMPOUND", 0.85),
		proposal({ start: 18, end: 25, body: "Houston" }, "LOCALITY_PHRASE", 0.65),
		proposal({ start: 27, end: 29, body: "TX" }, "REGION_ABBREVIATION", 0.95),
	]
	// Classifier top-k: argmax for "NY-NY" wants `region` (matches the surface form NY=New York),
	// but the venue interpretation is second-best — and the only one consistent with `Houston, TX`.
	const classifierTopK: ClassifierCandidate[] = [
		tagC(0, 5, "region", 0.7),
		tagC(0, 5, "venue", 0.6),
		tagC(0, 16, "venue", 0.55),
		tagC(18, 25, "locality", 0.85),
		tagC(27, 29, "region", 0.95),
	]
	// WOF mock: New York region (id 1), Texas region (id 2), Houston locality (parent=Texas).
	const usa = place(0, "United States", "country", "US", 39, -97)
	const ny = place(1, "New York", "region", "US", 43, -75, 0)
	const tx = place(2, "Texas", "region", "US", 31, -100, 0)
	const houston = place(3, "Houston", "locality", "US", 29.76, -95.37, 2)
	const resolver = mockResolver([
		[0, 5, "region", [ny]],
		[18, 25, "locality", [houston]],
		[27, 29, "region", [tx]],
		// VENUE has no gazetteer entry — slot survives with place=null, no concordance contribution.
	])
	const chain = mockChain([usa, ny, tx, houston])

	it("pre-reconcile (argmax) tags NY-NY as region — incongruent with Houston, TX", () => {
		const pre = preReconcileTags(phraseProposals, classifierTopK)
		const ny5 = pre.find((p) => p.start === 0 && p.end === 5)
		expect(ny5?.tag).toBe("region")
	})

	it("post-reconcile picks the venue interpretation for NY-NY Steakhouse", () => {
		const result = reconcileSpans({
			raw,
			phraseProposals,
			classifierTopK,
			resolverCandidates: resolver,
			parentChain: chain,
		})
		const ny5 = result.tree.roots.find((r) => r.start === 0 && (r.end === 5 || r.end === 16))
		// Either the venue-marker reads "NY-NY" as venue OR the whole "NY-NY Steakhouse" wins as venue.
		expect(ny5?.tag).toBe("venue")
	})

	it("post-reconcile resolves Houston + TX with consistent parent_id chain", () => {
		const result = reconcileSpans({
			raw,
			phraseProposals,
			classifierTopK,
			resolverCandidates: resolver,
			parentChain: chain,
		})
		const houstonNode = result.tree.roots.find((r) => r.value === "Houston")
		const txNode = result.tree.roots.find((r) => r.value === "TX")
		expect(houstonNode?.placeId).toContain(":3")
		expect(txNode?.placeId).toContain(":2")
	})
})

describe("kryptonite catalogue — Paris, Texas (post-reconcile picks Paris-TX over Paris-FR)", () => {
	const raw = "Paris, Texas"
	const phraseProposals: PhraseProposal[] = [
		proposal({ start: 0, end: 5, body: "Paris" }, "LOCALITY_PHRASE", 0.7),
		proposal({ start: 7, end: 12, body: "Texas" }, "LOCALITY_PHRASE", 0.8),
	]
	// Classifier top-k: "Paris" can be locality or country (in the FR=Paris-as-capital sense
	// the classifier sometimes does); "Texas" is region.
	const classifierTopK: ClassifierCandidate[] = [
		tagC(0, 5, "locality", 0.85),
		tagC(0, 5, "country", 0.4),
		tagC(7, 12, "region", 0.9),
		tagC(7, 12, "locality", 0.3),
	]
	// Two competing resolutions for Paris: Paris, France (well-known) and Paris, Texas (less so).
	// Resolver returns them in popularity order.
	const usa = place(0, "United States", "country", "US", 39, -97)
	const fra = place(1, "France", "country", "FR", 46, 2)
	const tx = place(2, "Texas", "region", "US", 31, -100, 0)
	const parisFR = place(10, "Paris", "locality", "FR", 48.86, 2.34, 1, /* score */ 1.0)
	const parisTX = place(11, "Paris", "locality", "US", 33.66, -95.55, 2, /* score */ 0.5)
	const resolver = mockResolver([
		[0, 5, "locality", [parisFR, parisTX]],
		[7, 12, "region", [tx]],
	])
	const chain = mockChain([usa, fra, tx, parisFR, parisTX])

	it("pre-reconcile (argmax + first resolver candidate) lands on Paris, France — wrong", () => {
		const pre = preReconcileTags(phraseProposals, classifierTopK)
		const parisTag = pre.find((p) => p.start === 0 && p.end === 5)
		expect(parisTag?.tag).toBe("locality")
		// And the resolver's first candidate (popularity argmax) is the FR one.
		expect(resolver.candidatesFor({ start: 0, end: 5 }, "locality")[0]!.country).toBe("FR")
	})

	it("post-reconcile prefers Paris, TX because TX is also assigned as region (concordance)", () => {
		const result = reconcileSpans({
			raw,
			phraseProposals,
			classifierTopK,
			resolverCandidates: resolver,
			parentChain: chain,
		})
		const parisNode = result.tree.roots.find((r) => r.value === "Paris")
		expect(parisNode?.placeId).toContain(":11") // Paris, TX
	})
})

describe("kryptonite catalogue — Saint Petersburg, FL (post-reconcile picks the joint span)", () => {
	const raw = "Saint Petersburg, FL"
	// Phrase grouper offers both the joint "Saint Petersburg" and the individual tokens.
	const phraseProposals: PhraseProposal[] = [
		proposal({ start: 0, end: 16, body: "Saint Petersburg" }, "LOCALITY_PHRASE", 0.75),
		proposal({ start: 0, end: 5, body: "Saint" }, "LOCALITY_PHRASE", 0.5),
		proposal({ start: 6, end: 16, body: "Petersburg" }, "LOCALITY_PHRASE", 0.55),
		proposal({ start: 18, end: 20, body: "FL" }, "REGION_ABBREVIATION", 0.95),
	]
	const classifierTopK: ClassifierCandidate[] = [
		tagC(0, 16, "locality", 0.88), // joint reading: Saint Petersburg, FL
		tagC(0, 5, "locality", 0.5),
		tagC(6, 16, "locality", 0.7), // higher single-token score for Petersburg (Russia)
		tagC(18, 20, "region", 0.95),
	]
	const usa = place(0, "United States", "country", "US", 39, -97)
	const rus = place(1, "Russia", "country", "RU", 61, 105)
	const fl = place(2, "Florida", "region", "US", 28, -82, 0)
	const stPete = place(10, "Saint Petersburg", "locality", "US", 27.77, -82.64, 2, 0.6)
	const petersburgRU = place(11, "Saint Petersburg", "locality", "RU", 59.93, 30.35, 1, 1.0)
	const resolver = mockResolver([
		[0, 16, "locality", [stPete]],
		[6, 16, "locality", [petersburgRU]],
		[18, 20, "region", [fl]],
	])
	const chain = mockChain([usa, rus, fl, stPete, petersburgRU])

	it("post-reconcile prefers the joint Saint Petersburg over the split Petersburg-Russia", () => {
		const result = reconcileSpans({
			raw,
			phraseProposals,
			classifierTopK,
			resolverCandidates: resolver,
			parentChain: chain,
		})
		const stPeteNode = result.tree.roots.find((r) => r.value === "Saint Petersburg")
		const petersburgNode = result.tree.roots.find((r) => r.value === "Petersburg")
		expect(stPeteNode).toBeDefined()
		expect(petersburgNode).toBeUndefined()
	})

	it("post-reconcile resolves Saint Petersburg to the US (FL) place, not the Russian one", () => {
		const result = reconcileSpans({
			raw,
			phraseProposals,
			classifierTopK,
			resolverCandidates: resolver,
			parentChain: chain,
		})
		const stPeteNode = result.tree.roots.find((r) => r.value === "Saint Petersburg")
		expect(stPeteNode?.placeId).toContain(":10") // US St Pete
	})
})

describe("kryptonite catalogue — Buffalo Buffalo (post-reconcile keeps both as locality)", () => {
	const raw = "Buffalo Buffalo"
	const phraseProposals: PhraseProposal[] = [
		// Single-token and combined locality proposals (mirroring phrase-grouper's surfacing).
		proposal({ start: 0, end: 7, body: "Buffalo" }, "LOCALITY_PHRASE", 0.7),
		proposal({ start: 8, end: 15, body: "Buffalo" }, "LOCALITY_PHRASE", 0.7),
		proposal({ start: 0, end: 15, body: "Buffalo Buffalo" }, "LOCALITY_PHRASE", 0.75),
	]
	// Classifier prefers the combined reading; the individual tokens are second-best.
	const classifierTopK: ClassifierCandidate[] = [
		tagC(0, 15, "locality", 0.82),
		tagC(0, 7, "locality", 0.5),
		tagC(8, 15, "locality", 0.5),
	]
	const usa = place(0, "United States", "country", "US", 39, -97)
	const ny = place(1, "New York", "region", "US", 43, -75, 0)
	const buffaloNY = place(10, "Buffalo", "locality", "US", 42.88, -78.87, 1, 1.0)
	const resolver = mockResolver([
		[0, 15, "locality", [buffaloNY]],
		[0, 7, "locality", [buffaloNY]],
		[8, 15, "locality", [buffaloNY]],
	])
	const chain = mockChain([usa, ny, buffaloNY])

	it("post-reconcile picks ONE coherent locality span (no double-count)", () => {
		const result = reconcileSpans({
			raw,
			phraseProposals,
			classifierTopK,
			resolverCandidates: resolver,
			parentChain: chain,
		})
		const localityRoots = result.tree.roots.filter((r) => r.tag === "locality")
		// Either one combined span (length 15) OR two non-overlapping spans (lengths 7+7).
		expect(localityRoots.length).toBeGreaterThan(0)
		expect(localityRoots.length).toBeLessThanOrEqual(2)

		// Whatever the search picks, the spans don't overlap.
		for (let i = 0; i < localityRoots.length; i++) {
			for (let j = i + 1; j < localityRoots.length; j++) {
				const a = localityRoots[i]!
				const b = localityRoots[j]!
				expect(a.end <= b.start || b.end <= a.start).toBe(true)
			}
		}
	})

	it("post-reconcile prefers the combined span (higher classifier confidence)", () => {
		const result = reconcileSpans({
			raw,
			phraseProposals,
			classifierTopK,
			resolverCandidates: resolver,
			parentChain: chain,
		})
		const combined = result.tree.roots.find((r) => r.start === 0 && r.end === 15)
		expect(combined).toBeDefined()
	})
})

describe("kryptonite catalogue — New York City (bare multiword famous name, no resolver evidence)", () => {
	// Regression for the v4.4.0 demo bug (2026-06-11): `runPipeline("New York City")` produced
	// `{region: "York", locality: "City"}` while plain argmax produced the correct
	// `{locality: "New York City"}`. Root cause: the per-token logit aggregation gives interior
	// fragments inflated confidence (`City` aggregates I-locality mass → 0.92 vs 0.60 for the full
	// span) and the per-SLOT inclusion bonus charged nothing for leaving "New York" uncovered — the
	// beam picked the bare `locality="City"` and the grouper-audit then promoted the orphaned `York`
	// to a spurious `region`. The per-WORD inclusion bonus makes the covering interpretation win.
	//
	// Phrase proposals + classifier top-K below are RECORDED from the live v4.4.0 ship config
	// (v130-boundary-40k-int8 + v0.6.0-a0 tokenizer + fst-en-US.bin) via
	// `scripts/diag-nyc-reconcile.ts`. No resolver / parent chain — the demo passes no backend, so
	// the reconciler must rank these on classifier + phrase evidence alone.
	const raw = "New York City"
	const phraseProposals: PhraseProposal[] = [
		proposal({ start: 4, end: 13, body: "York City" }, "LOCALITY_PHRASE", 0.85),
		proposal({ start: 0, end: 13, body: "New York City" }, "LOCALITY_PHRASE", 0.82),
		proposal({ start: 0, end: 8, body: "New York" }, "LOCALITY_PHRASE", 0.7),
		proposal({ start: 9, end: 13, body: "City" }, "LOCALITY_PHRASE", 0.7),
		proposal({ start: 0, end: 3, body: "New" }, "LOCALITY_PHRASE", 0.55),
		proposal({ start: 0, end: 13, body: "New York City" }, "VENUE_PHRASE", 0.55),
		proposal({ start: 4, end: 8, body: "York" }, "LOCALITY_PHRASE", 0.55),
	]
	const classifierTopK: ClassifierCandidate[] = [
		tagC(4, 13, "locality", 0.603),
		tagC(4, 13, "region", 0.2397),
		tagC(4, 13, "country", 0.0306),
		tagC(0, 13, "locality", 0.5951),
		tagC(0, 13, "region", 0.2472),
		tagC(0, 13, "country", 0.0328),
		tagC(0, 8, "locality", 0.433),
		tagC(0, 8, "region", 0.3669),
		tagC(0, 8, "country", 0.044),
		tagC(9, 13, "locality", 0.9192),
		tagC(9, 13, "country", 0.0104),
		tagC(0, 3, "locality", 0.5792),
		tagC(0, 3, "region", 0.2622),
		tagC(0, 3, "country", 0.0373),
		tagC(4, 8, "region", 0.4716),
		tagC(4, 8, "locality", 0.2868),
		tagC(4, 8, "country", 0.0508),
	]

	it("post-reconcile keeps the single full-span locality — no fragmentation into York/City", () => {
		const result = reconcileSpans({ raw, phraseProposals, classifierTopK })
		expect(result.tree.roots).toHaveLength(1)
		const root = result.tree.roots[0]!
		expect(root.tag).toBe("locality")
		expect(root.value).toBe("New York City")
	})

	it("post-reconcile leaves no span uncovered for the grouper-audit to mis-promote", () => {
		const result = reconcileSpans({ raw, phraseProposals, classifierTopK })

		// Every phrase proposal must overlap a chosen root — an uncovered `York` proposal is what
		// produced the spurious `region` node in the original bug.
		for (const p of phraseProposals) {
			const pEnd = p.span.start + p.span.body.length
			const covered = result.tree.roots.some((r) => r.start < pEnd && p.span.start < r.end)
			expect(covered, `proposal ${JSON.stringify(p.span.body)} should be covered`).toBe(true)
		}
	})
})

describe("reconcile — concordance hard veto", () => {
	const raw = "Paris, Texas"
	// Setup: classifier wants Paris=locality + Texas=region. Resolver candidates are *all*
	// inconsistent — Paris's only candidate is FR, Texas's is US. WOF chain explicitly says
	// Paris-FR's parent is France, not Texas. The reconciler should hard-veto this combination.
	const phraseProposals: PhraseProposal[] = [
		proposal({ start: 0, end: 5, body: "Paris" }, "LOCALITY_PHRASE", 0.7),
		proposal({ start: 7, end: 12, body: "Texas" }, "LOCALITY_PHRASE", 0.8),
	]
	const classifierTopK: ClassifierCandidate[] = [tagC(0, 5, "locality", 0.85), tagC(7, 12, "region", 0.9)]
	const usa = place(0, "United States", "country", "US", 39, -97)
	const fra = place(1, "France", "country", "FR", 46, 2)
	const tx = place(2, "Texas", "region", "US", 31, -100, 0)
	const parisFR = place(10, "Paris", "locality", "FR", 48.86, 2.34, 1, 1.0)
	const resolver = mockResolver([
		[0, 5, "locality", [parisFR]],
		[7, 12, "region", [tx]],
	])
	const chain = mockChain([usa, fra, tx, parisFR])

	it("hard veto: contradictory parent chain forces the empty / single-slot interpretation", () => {
		const result = reconcileSpans({
			raw,
			phraseProposals,
			classifierTopK,
			resolverCandidates: resolver,
			parentChain: chain,
		})
		// The contradictory combination (paris-FR + Texas) should not coexist as roots.
		const parisFRNode = result.tree.roots.find((r) => r.placeId?.includes(":10"))
		const txNode = result.tree.roots.find((r) => r.placeId?.includes(":2"))
		expect(parisFRNode && txNode).toBeFalsy()
	})
})

describe("reconcile — opts knobs are respected", () => {
	const raw = "10118"
	const inputs = {
		raw,
		phraseProposals: [proposal({ start: 0, end: 5, body: raw }, "POSTCODE", 0.9)],
		classifierTopK: [
			tagC(0, 5, "postcode", 0.95),
			tagC(0, 5, "house_number", 0.4),
			tagC(0, 5, "po_box", 0.2),
			tagC(0, 5, "unit", 0.1),
		],
	}

	it("kTag = 1 keeps only the top tag", () => {
		const result = reconcileSpans({ ...inputs, opts: { kTag: 1 } })
		expect(result.tree.roots[0]?.tag).toBe("postcode")
	})

	it("runnersUp = 0 returns no runner-up trees", () => {
		const result = reconcileSpans({ ...inputs, opts: { runnersUp: 0 } })
		expect(result.runnersUp).toEqual([])
	})

	it("runnersUp > 1 returns at least one runner-up if alternates exist", () => {
		const result = reconcileSpans({ ...inputs, opts: { runnersUp: 2 } })
		// With four tag interpretations there are at least four candidate beams beyond the winner.
		expect(result.runnersUp.length).toBeGreaterThan(0)
	})
})

describe("reconcile — score breakdown surfaces each factor", () => {
	it("breakdown.phrase × classifier × concordance ≈ total when resolver is absent", () => {
		const raw = "10118"
		const result = reconcileSpans({
			raw,
			phraseProposals: [proposal({ start: 0, end: 5, body: raw }, "POSTCODE", 0.9)],
			classifierTopK: [tagC(0, 5, "postcode", 0.8)],
		})
		const { phrase, classifier, resolver: res, concordance, total } = result.scoreBreakdown
		expect(phrase).toBeCloseTo(0.9)
		expect(classifier).toBeCloseTo(0.8)
		expect(res).toBeCloseTo(1.0)
		expect(concordance).toBeCloseTo(1.0)
		expect(total).toBeCloseTo(phrase * classifier * res * concordance, 5)
	})
})
