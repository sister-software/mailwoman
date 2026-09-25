/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { QueryIntentMarker, QueryKindResult } from "@mailwoman/core/pipeline"
import { computeQueryShape } from "@mailwoman/query-shape"

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

	if (!markers.length) {
		markers.push({
			kind: verdict.kind,
			code: "poi_category",
			mechanism: "kind:poi_query",
			message:
				"The query asks for a kind of place rather than an address — the address lanes abstain. " +
				"Use the POI search surface (the pipeline's poiIntent stage / poi_search) for an answer.",
		})
	}

	return markers
}
