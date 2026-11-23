// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The geocode's first refusal: a query that asks for a thing, such as a category of place, gets markers and no coordinate.
 */

import type { QueryIntentMarker, QueryKindResult } from "@mailwoman/core/pipeline"
import { computeQueryShape } from "@mailwoman/postcode/recognizer/query-shape"
import { QueryShapeGeneration } from "@mailwoman/postcode/recognizer/rule-generation"

const REFUSAL_KINDS: ReadonlySet<string> = new Set(["poi_query", "poi_category", "near_me"])

/**
 * The check itself: the abstention's markers when the query is a thing-query, else null (geocode proceeds).
 */
export async function thingQueryRefusalMarkers(
	classifyKind: (
		input: { raw: string; normalized: string },
		shape: ReturnType<typeof computeQueryShape>
	) => Promise<QueryKindResult>,
	parseInput: string,
	generation: QueryShapeGeneration = QueryShapeGeneration.Legacy
): Promise<QueryIntentMarker[] | null> {
	const verdict = await classifyKind(
		{ raw: parseInput, normalized: parseInput },
		computeQueryShape(parseInput, generation)
	)

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
			evidence: null,
		})
	}

	return markers
}
