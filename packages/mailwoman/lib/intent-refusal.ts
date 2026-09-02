/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The #1649 FIRST-REFUSAL check: a lexicon-aware kind classifier, when the caller injects one, gets
 *   first look at the query. A top-slot `poi_query` / `poi_category` / `near_me` verdict means the
 *   string asks for a THING, not an address — the address lanes can only manufacture confident
 *   nonsense from it ("Statue of Liberty" resolved Of, Trabzon through a fuzzy locality; "Restaurants
 *   in London" resolved London, Kentucky). The geocode ABSTAINS with the verdict's intent markers
 *   attached; POI-lane answering lives in the runtime pipeline's poiIntent stage. The refusal is a
 *   VERDICT, not a miss — {@link hasRefusalMarker} lets the register-flip retry stand down (a retry
 *   with a pinned register would skip this check and resolve the refused nonsense; measured on the
 *   harness's "Pharmacy near me" → a Hungarian namesake).
 *
 *   Checks: injected classifier only (absent → byte-identical geocoding), no explicit register pin —
 *   a caller-supplied tree does NOT skip it (the CLI session pre-parses every query as an
 *   optimization; a pre-parse of "train station" is still a thing-query). The kind-intent invariance
 *   receipt proves the top slot never flips on an ADDRESS-shaped corpus row under the wired lexicon.
 *
 *   Pure over its arguments — no geocode-core import, so no module cycle: the caller assembles the
 *   abstention result and attaches the markers this module returns.
 */

import type { QueryIntentMarker, QueryKindResult } from "@mailwoman/core/pipeline"
import { computeQueryShape } from "@mailwoman/query-shape"

/**
 * The kinds this refusal applies to. `near_me` additionally needs a focus point no plain geocode carries.
 */
const REFUSAL_KINDS: ReadonlySet<string> = new Set(["poi_query", "poi_category", "near_me"])

/**
 * The check itself: the abstention's markers when the query is a thing-query, else null (geocode proceeds).
 */
export async function thingQueryRefusalMarkers(
	classifyKind: (
		input: { raw: string; normalized: string },
		shape: ReturnType<typeof computeQueryShape>
	) => Promise<QueryKindResult>,
	parseInput: string
): Promise<QueryIntentMarker[] | null> {
	const verdict = await classifyKind({ raw: parseInput, normalized: parseInput }, computeQueryShape(parseInput))

	if (!REFUSAL_KINDS.has(verdict.kind)) return null

	const markers = [...(verdict.intentMarkers ?? [])]

	// `poi_query` is a structural kind with no marker of its own (the runtime pipeline EXECUTES it) —
	// on this path the abstention must still say why, so synthesize one.
	if (!markers.length) {
		markers.push({
			kind: verdict.kind,
			code: "poi_category",
			mechanism: "kind:poi_query",
			message:
				"The query asks for a kind of place, not an address — the address lanes abstain. " +
				"Use the POI search surface (the pipeline's poiIntent stage / poi_search) for an answer.",
		})
	}

	return markers
}
