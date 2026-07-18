/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { LocaleHint, PipelineResult } from "@mailwoman/core/pipeline"
import { describe, expect, it } from "vitest"

import { createPOIIntentStage, poiTaxonomyLookup } from "./poi-intent.ts"
import { createRuntimePipeline } from "./runtime-pipeline.ts"

const LOCALE: LocaleHint = { locale: "en-US", confidence: 1, alternatives: [], source: "caller" }

const anchorResult = (raw: string): PipelineResult => ({
	input: raw,
	normalized: { raw, normalized: raw },
	queryShape: { knownFormats: [] },
	locale: LOCALE,
	kind: { kind: "structured_address", confidence: 0.5, alternatives: [] },
	phraseProposals: [],
	tree: { raw, roots: [] },
	timing: {},
	path: "full",
})

describe("poiTaxonomyLookup adapter", () => {
	it("maps taxonomy matches into POIPhraseMatch shape", () => {
		const hits = poiTaxonomyLookup("drinking fountain", "en-US")
		expect(hits[0]?.categoryID).toBe("drinking_water")
		expect(hits[0]?.confidence).toBe(1.0)
	})
})

describe("createPOIIntentStage", () => {
	it("returns a category intent with a parsed anchor", async () => {
		const parsed: string[] = []
		const stage = createPOIIntentStage({
			lookup: poiTaxonomyLookup,
			parseAnchor: async (text) => {
				parsed.push(text)

				return anchorResult(text)
			},
		})
		const outcome = await stage(
			{ raw: "hospital near Springfield IL", normalized: "hospital near Springfield IL" },
			LOCALE
		)

		expect(outcome?.type).toBe("intent")

		if (outcome?.type !== "intent") throw new Error("unreachable")

		expect(outcome.intent.subject).toEqual({ kind: "category", categoryID: "hospital", matched: "hospital" })
		expect(outcome.intent.anchor?.text).toBe("Springfield IL")
		expect(parsed).toEqual(["Springfield IL"])
	})

	it("returns a bare-subject intent with no anchor and no anchor parse", async () => {
		const stage = createPOIIntentStage({
			lookup: poiTaxonomyLookup,
			parseAnchor: async () => {
				throw new Error("must not parse an anchor for a bare subject")
			},
		})
		const outcome = await stage({ raw: "fire hydrant", normalized: "fire hydrant" }, LOCALE)

		expect(outcome?.type).toBe("intent")
	})

	it("returns null when no subject matches (fall-through)", async () => {
		const stage = createPOIIntentStage({ lookup: poiTaxonomyLookup, parseAnchor: async (t) => anchorResult(t) })
		const outcome = await stage({ raw: "Empire State Building", normalized: "Empire State Building" }, LOCALE)

		expect(outcome).toBeNull()
	})
})

// placeCountry/streetEvidence lazy-load bundled data on first call — off for hermetic tests
// (fresh worktrees may lack linked dev weights; the poi arc doesn't touch either stage).
const HERMETIC = { placeCountry: false as const, streetEvidence: false as const }

describe("createRuntimePipeline poiQueryKind flag", () => {
	it("OFF by default: a category phrase never takes the poi path", async () => {
		const pipeline = createRuntimePipeline({ ...HERMETIC })
		const result = await pipeline("hospital")

		expect(result.path).not.toBe("poi")
		expect("poiIntent" in result).toBe(false)
		expect(result.kind.kind).not.toBe("poi_query")
	})

	// Task 4 (executor): swapped from "drinking fountain" to "hospital" — `drinking_water` is a
	// build-local (`mailwoman-infra`-sourced) category, and now that the executor is wired for every
	// `poiQueryKind` mode, an anchor with no resolvable center is orthogonal to the build-local abstain
	// check (see the "bare build-local-only category" test below). `hospital` (`overture`-sourced) keeps
	// this test's original purpose intact: intent-only passthrough, end-to-end, with a parsed anchor.
	it("ON: a category phrase takes the poi path end-to-end", async () => {
		const pipeline = createRuntimePipeline({ ...HERMETIC, poiQueryKind: true })
		const result = await pipeline("hospital near Springfield")

		expect(result.path).toBe("poi")
		expect(result.poiIntent?.type).toBe("intent")

		if (result.poiIntent?.type !== "intent") throw new Error("unreachable")

		expect(result.poiIntent.intent.subject).toEqual({
			kind: "category",
			categoryID: "hospital",
			matched: "hospital",
		})
		expect(result.poiIntent.intent.anchor?.text).toBe("Springfield")
	})

	it("ON: a plain address stays on the normal path", async () => {
		const pipeline = createRuntimePipeline({ ...HERMETIC, poiQueryKind: true })
		const result = await pipeline("350 5th Ave, New York, NY 10118")

		expect(result.path).not.toBe("poi")
		expect("poiIntent" in result).toBe(false)
	})

	// Task 4 (executor): a bare-infra category with no local layer wired abstains, even in
	// intent-only mode (`poiQueryKind: true`, no db) — the build-local check needs no lookup.
	// CHANGED from Plan 2: this used to be intent-only (a bare `{ type: "intent", intent }`, no
	// abstain check at all); the executor now runs for every `poiQueryKind` mode.
	it("ON: a bare build-local-only category (no local layer, no db) abstains", async () => {
		const pipeline = createRuntimePipeline({ ...HERMETIC, poiQueryKind: true })
		const result = await pipeline("fire hydrant")

		expect(result.path).toBe("poi")
		expect(result.poiIntent).toEqual({ type: "abstain", reason: "requires_build_local_layer" })
	})

	it("object form degrades to intent-only when the poi db is missing (no throw, no retry storm)", async () => {
		const pipeline = createRuntimePipeline({
			...HERMETIC,
			poiQueryKind: { poiDatabasePath: "/nonexistent/never/poi.db" },
		})
		const first = await pipeline("hospital near Springfield")
		expect(first.path).toBe("poi")
		expect(first.poiIntent?.type).toBe("intent")

		if (first.poiIntent?.type !== "intent") throw new Error("unreachable")

		expect(first.poiIntent.results).toBeUndefined()
		// Second call must not throw either (lazy resolve happens once; degrade is sticky).
		const second = await pipeline("hospital near Springfield")
		expect(second.poiIntent?.type).toBe("intent")
	})
})
