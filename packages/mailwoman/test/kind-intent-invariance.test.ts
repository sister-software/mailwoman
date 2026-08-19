/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   THE ZERO-RECLASSIFICATION RECEIPT for the ROAD_TO_V9 §4 intent vocabulary.
 *
 *   Four kinds were added to Stage 2.5. The D-rule obligation attached to that addition is that an
 *   ADDRESS-SHAPED query behaves identically — and "identically" has to be a measurement, not a
 *   claim, so this file states exactly what it pins and over what.
 *
 *   ## What actually reaches the parser
 *
 *   The kind classifier's verdict influences the rest of the pipeline through exactly three doors,
 *   and this file walks all three:
 *
 *   1. `deriveInputMode(kind)` — the register handed to `classifier.parse` on EVERY geocode
 *       (`geocode-core.ts`'s `deriveGeocodeRegister`) and every `runPipeline` full-path parse. This
 *       is the one that would silently change a parse, because the evidence-bundle channels feed in
 *       `fragmented` and not in `formatted`.
 *   2. `canShortCircuit(kind, …)` — whether stages 3-5 run at all. Keyed on the TOP kind plus a
 *       0.95 confidence floor.
 *   3. The coordinator's POI branch — keyed on the top kind being `poi_query` or (now)
 *       `poi_category`.
 *
 *   A verdict whose top `kind` and `confidence` are unchanged cannot move any of the three. So the
 *   pin below is over `(kind, confidence, inputMode)` for EVERY committed corpus row (the size test pins the count) in BOTH
 *   registers, computed against a from-scratch replay of the PRE-§4 scorer set. That is a stronger
 *   receipt than a sample of parses would be — it is every row, it is exact rather than
 *   within-tolerance, and it needs no weights, so it runs in CI on every commit rather than on the
 *   days someone has the ~9 GB shard set mounted.
 *
 *   ## Why the baseline is replayed rather than snapshotted
 *
 *   A committed golden file would drift silently the first time someone tuned an INCUMBENT rule and
 *   regenerated it. Replaying the pre-§4 scorer list in-process means the baseline is derived from
 *   the same `rules.ts` the shipped classifier uses: this test can only fail because an intent kind
 *   displaced an incumbent, which is the exact thing it exists to forbid.
 */

import { deriveInputMode } from "@mailwoman/core/pipeline"
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
import type { NormalizedInputLite, QueryKind, QueryKindResult, QueryShapeLike } from "@mailwoman/kind-classifier"
import { computeQueryShape } from "@mailwoman/query-shape"
import { beforeAll, describe, expect, test } from "vitest"

import { loadRegressionCases } from "../eval-harness/gauntlet/cases/load.ts"
import { poiTaxonomyLookup } from "../poi-intent.ts"

/**
 * The scorer set as it stood BEFORE ROAD_TO_V9 §4 — a verbatim replay of `classify.ts`'s list at commit `4ebd955`,
 * minus the three intent scorers and the POI pair (which are lexicon-gated and unreachable from `classifyKindSync`).
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
 * The tuple that decides everything downstream. Compared as a STRING so a failure prints the whole verdict rather than
 * three separate assertion messages.
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
 * A FLOOR, not the current count. The failure worth catching is a corpus that loads SHORT — a truncated read or a
 * silently-filtered set makes every zero-reclassification claim below vacuous while still passing. Growth is the normal
 * operation: a board row lands most working days, and an exact pin turns each one into a red build in a file nobody
 * editing the board would think to open. Raise this only when the floor stops being a meaningful lower bound.
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
				// The #1649 category-query rows are THING-queries — reclassifying is their entire point,
				// and the address-shaped zero-reclassification claim never covered them.
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
		// The geocode path now injects createKindClassifier({ poiLexicon }) for first refusal; an
		// ADDRESS-shaped row whose top kind flips to a poi kind would silently abstain from geocoding.
		// The category-query rows themselves are excluded — they are THING-queries and flipping is
		// their entire point (each one's id carries the -cat- infix).
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
	 * THE MEASURED RESIDUAL, pinned by name.
	 *
	 * `route_pair` cannot be separated from a two-token single place name by structure alone — that separation needs to
	 * know Guatemala is a country and Jaya is not, which is a gazetteer fact. The morphology guard in `intent-rules.ts`
	 * (head particles, tail generics, reduplication) takes the corpus population from 12 rows to these 4, and the rest is
	 * irreducible at Stage 2.5.
	 *
	 * That is not a defect being tolerated — it is the reason ROAD_TO_V9 §4.3 specifies a DECLARED FORK rather than a
	 * router. All four rows keep their existing top kind (`locality_only`, asserted above), keep their register, take the
	 * same path, and resolve to the same answer. The only thing that changed for them is that the result now says out
	 * loud that the string reads two ways.
	 *
	 * The list is exhaustive and exact so that a future rule change which GROWS the fork population fails here rather
	 * than passing quietly.
	 */
	// 2026-08-10: grew 4 → 19 with the operator-supplied street-name-boundaries and
	// world-structures boards (306 → 514 cases). The 15 additions are all bare famous-street
	// rows ('Avenida Alvear', 'Savile Row', 'Gran Vía' …) — single street-name surfaces with no
	// structural anchor, exactly the declared-fork shape the marker exists for. Deliberate pin
	// move, reviewed row-by-row; not silent growth.
	// 2026-08-11: corpus 514 → 523 with the bare-foreign-postcode board (#1589) — 9 postcode
	// surfaces ('100 00', 'SW1A 1AA', 'N7 0BT', …), then 523 → 530 with the #1585 fuzzy-scope
	// board (bare toponyms + two exact-match controls). None are fork-shaped; the fork list is
	// unchanged.
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
		"Rue Saint-Honoré",
		"Rue Sainte-Catherine",
		"Savile Row",
		"Via Laietana",
	]

	test("the fork population over the corpus is the 19 rows structure cannot resolve", () => {
		const marked: Array<{ input: string; codes: string[]; kind: QueryKind }> = []

		for (const raw of corpus) {
			// The #1649 category-query rows carry intent markers by DESIGN — they are the thing-query
			// board, not the irreducible address-shaped fork this exhaustive list pins.
			if (CATEGORY_QUERY_INPUTS.has(raw)) continue

			for (const text of [raw, raw.toLowerCase()]) {
				const verdict = classifyKindSync({ raw: text, normalized: text }, computeQueryShape(text))

				if (verdict.intentMarkers?.length) {
					marked.push({ input: text, codes: verdict.intentMarkers.map((m) => m.code), kind: verdict.kind })
				}
			}
		}

		// Both registers of each row, and nothing else. Compared as SETS of inputs: the corpus may
		// legitimately carry the same surface in two boards ('Rua Augusta' is a Lisbon case AND a
		// São Paulo case), and the population claim is about distinct inputs, not case rows.
		expect([...new Set(marked.map((m) => m.input))].toSorted()).toEqual(
			[...EXPECTED_FORK_ROWS, ...EXPECTED_FORK_ROWS.map((r) => r.toLowerCase())].toSorted()
		)

		// Every one is a declared fork, and every one KEPT its incumbent top kind. The second assertion is the
		// answer-neutrality claim: a marker rode along, nothing was rerouted.
		expect(new Set(marked.flatMap((m) => m.codes))).toEqual(new Set(["declared_fork"]))

		// `landmark` and `locality_only`, and the split is by REGISTER: `scoreVenueLandmark` requires a capital letter
		// (`rules.ts`'s `/[A-Z]/` gate) and scores 0.88, so "Diego Garcia" is a landmark and "diego garcia" is a
		// locality. That is a PRE-EXISTING case-keyed rule, unchanged here and recorded because it is exactly the kind
		// of thing this receipt would otherwise be read as having introduced. What matters for the D-rule is that the
		// same two kinds come out with and without §4 — which the byte-identical routing test above already pinned.
		expect(new Set(marked.map((m) => m.kind))).toEqual(new Set<QueryKind>(["landmark", "locality_only"]))
	})
})
