/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The baseline is replayed from the shipped rules rather than snapshotted, so this can only fail because an intent kind displaced an incumbent.
 */

import { deriveInputMode, type QueryKind, type QueryKindResult } from "@mailwoman/core/pipeline"
import {
	classifyKindSync,
	createKindClassifier,
	scoreIntersection,
	scoreLandmark,
	scoreLocalityOnly,
	scorePoBox,
	scorePostcodeOnly,
	scoreStructuredAddress,
	scoreVague,
	scoreVenueLandmark,
} from "@mailwoman/kind-classifier"
import {
	computeQueryShape,
	type NormalizedInputLite,
	type QueryShapeSegmentsView as QueryShapeLike,
} from "@mailwoman/query-shape"
import { loadRegressionCases } from "mailwoman/eval-harness/gauntlet/cases/load"
import { poiTaxonomyLookup } from "mailwoman/poi"
import { beforeAll, describe, expect, test } from "vitest"

/**
 * The pre-intent scorer set `classifyKindSync` can reach, minus the intent scorers
 * and the lexicon-restricted POI pair.
 */
const PRE_INTENT_SCORERS: ReadonlyArray<{
	kind: QueryKind
	score: (i: NormalizedInputLite, s: QueryShapeLike) => number
}> = [
	{ kind: "po_box", score: scorePoBox },
	{ kind: "landmark", score: (i, s) => Math.max(scoreLandmark(i, s), scoreVenueLandmark(i, s)) },
	{ kind: "intersection", score: scoreIntersection },
	{ kind: "postcode_only", score: scorePostcodeOnly },
	{ kind: "locality_only", score: scoreLocalityOnly },
	{ kind: "structured_address", score: scoreStructuredAddress },
	{ kind: "vague", score: scoreVague },
]

function classifyPreIntent(input: NormalizedInputLite, shape: QueryShapeLike): QueryKindResult {
	const scored = PRE_INTENT_SCORERS.map((s) => ({ kind: s.kind, confidence: s.score(input, shape) })).filter(
		(s) => s.confidence > 0
	)

	scored.sort((a, b) => b.confidence - a.confidence)

	const top = scored[0] ?? { kind: "vague" as QueryKind, confidence: 0.3 }

	return { kind: top.kind, confidence: top.confidence, alternatives: scored.slice(1) }
}

/**
 * Compared as a string so a failure prints the whole verdict rather than three separate assertion messages.
 */
function routingKey(text: string, classify: (i: NormalizedInputLite, s: QueryShapeLike) => QueryKindResult): string {
	const input: NormalizedInputLite = { raw: text, normalized: text }
	const verdict = classify(input, computeQueryShape(text))

	return `${verdict.kind}|${verdict.confidence}|${deriveInputMode(verdict.kind)}`
}

let corpus: string[] = []
let CATEGORY_QUERY_INPUTS = new Set<string>()

beforeAll(async () => {
	const cases = await loadRegressionCases()

	corpus = cases.map((c) => c.input)
	CATEGORY_QUERY_INPUTS = new Set(cases.filter((c) => c.id.includes("-cat-")).map((c) => c.input))
})

/**
 * A floor rather than the current count: a truncated read would make every
 * zero-reclassification claim below vacuous, while corpus growth is normal.
 */
const CORPUS_FLOOR = 550

describe("ROAD_TO_V9 §4 — zero reclassification over the regression corpus", () => {
	test("the committed corpus loaded at full length rather than short", () => {
		expect(corpus.length).toBeGreaterThanOrEqual(CORPUS_FLOOR)
	})

	test.each(["as-written", "lowercase"] as const)(
		"(kind, confidence, inputMode) is byte-identical to the pre-intent classifier — %s",
		(register) => {
			const drift: Array<{ input: string; before: string; after: string }> = []

			for (const raw of corpus) {
				// Category-query rows are thing-queries excluded from the address-shaped zero-reclassification claim.
				if (CATEGORY_QUERY_INPUTS.has(raw)) continue
				const text = register === "lowercase" ? raw.toLowerCase() : raw
				const before = routingKey(text, classifyPreIntent)
				const after = routingKey(text, classifyKindSync)

				if (before !== after) {
					drift.push({ input: text, before, after })
				}
			}

			expect(drift, `${drift.length} of ${corpus.length} rows reclassified`).toEqual([])
		}
	)

	test("the LEXICON-WIRED classifier's top slot is byte-identical on every corpus row (#1649)", async () => {
		// A lexicon-wired classifier that flipped an address-shaped row to a poi
		// kind would silently abstain from geocoding.
		const classify = createKindClassifier({ poiLexicon: poiTaxonomyLookup })
		const flipped: Array<{ input: string; sync: string; wired: string }> = []

		for (const raw of corpus) {
			for (const text of [raw, raw.toLowerCase()]) {
				const input = { raw: text, normalized: text }
				const shape = computeQueryShape(text)
				const sync = classifyKindSync(input, shape).kind

				const wired = (
					await classify(input, shape, { locale: "en-US", confidence: 1, alternatives: [], source: "caller" })
				).kind

				if (sync !== wired && !CATEGORY_QUERY_INPUTS.has(raw)) {
					flipped.push({ input: text, sync, wired })
				}
			}
		}

		expect(flipped, `${flipped.length} corpus rows reclassified by the lexicon`).toEqual([])
	})

	test("no intent kind ever takes the top slot on a corpus row, in either register", () => {
		const INTENT_KINDS = new Set<QueryKind>(["bare_toponym", "route_pair", "near_me", "poi_category"])
		const claimed: Array<{ input: string; kind: QueryKind }> = []

		for (const raw of corpus) {
			if (CATEGORY_QUERY_INPUTS.has(raw)) continue

			for (const text of [raw, raw.toLowerCase()]) {
				const verdict = classifyKindSync({ raw: text, normalized: text }, computeQueryShape(text))

				if (INTENT_KINDS.has(verdict.kind)) {
					claimed.push({ input: text, kind: verdict.kind })
				}
			}
		}

		expect(claimed).toEqual([])
	})

	/**
	 * The measured residual, pinned by name: `route_pair` cannot be separated from
	 * a two-token place name by structure only.
	 *
	 * The list is exhaustive so a future rule change that grows the fork population fails here.
	 */
	const EXPECTED_FORK_ROWS = [
		"Antigua Guatemala",
		"Avenida Alvear",
		"Avenida Atlântica",
		"Avenida Corrientes",
		"Avenida Diagonal",
		"Avenida Paulista",
		"COMER parís.méxico",
		"Diego Garcia",
		"Gran Vía",
		"Kärntner Straße",
		"Mariahilfer Straße",
		"Nevsky Prospect",
		"Petaling Jaya",
		"Rua Augusta",
		"Rua Garrett",
	]

	test("the fork population over the corpus is the 15 rows structure cannot resolve", () => {
		const marked: Array<{ input: string; codes: string[]; kind: QueryKind }> = []

		for (const raw of corpus) {
			// Category-query rows include intent markers by design and are excluded from this address-shaped fork list.
			if (CATEGORY_QUERY_INPUTS.has(raw)) continue

			for (const text of [raw, raw.toLowerCase()]) {
				const verdict = classifyKindSync({ raw: text, normalized: text }, computeQueryShape(text))

				if (verdict.intentMarkers?.length) {
					marked.push({ input: text, codes: verdict.intentMarkers.map((m) => m.code), kind: verdict.kind })
				}
			}
		}

		// Compared as sets of distinct inputs because the corpus may include one surface in two boards.
		expect([...new Set(marked.map((m) => m.input))].toSorted()).toEqual(
			[...EXPECTED_FORK_ROWS, ...EXPECTED_FORK_ROWS.map((r) => r.toLowerCase())].toSorted()
		)

		expect(new Set(marked.flatMap((m) => m.codes))).toEqual(new Set(["declared_fork"]))

		// `scoreVenueLandmark` requires a capital letter, so the kinds split by register.
		expect(new Set(marked.map((m) => m.kind))).toEqual(new Set<QueryKind>(["landmark", "locality_only"]))
	})
})
