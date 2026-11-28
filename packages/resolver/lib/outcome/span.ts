// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The span outcome ordering applies to, and the landmark candidates it reads beside the candidate table's.
 *
 *   The hint and the filter describe the returned records, so they act on the input's
 *   leading name: the span that starts first among the spans the walk looks up.
 *   Every other span is context, ranked by the passes that exist today.
 */

import type { PlacetypeMap } from "@mailwoman/codex/labels/placetype-map"
import { collectNodes, type AddressNode } from "@mailwoman/core/decoder"
import type { LandmarkHit, LandmarkLookup, ResolvedPlace, ResolverBackend } from "@mailwoman/core/resolver"
import { OUTCOME_TABLES, refuseMissingOutcomeTables, type ResolveOutcome } from "@mailwoman/core/resolver/outcome"
import { haversine } from "@mailwoman/spatial/geometries/point/distance"

import { findWithOutcome } from "#outcome/fetch"
import { placeOfLandmark, STATED_LOCALITY_RADIUS_KM } from "#resolve/landmark"

/**
 * The span outcome ordering applies to: the input's leading span, when the walk looks it up.
 *
 * A leading span the walk doesn't look up, such as the venue or category in `coffee near Mt. Tabor`,
 * names the returned records, so every span after it is an anchor and keeps today's order.
 * The landmark pass reads a leading venue under the request instead.
 */
export function outcomeTargetSpan(roots: readonly AddressNode[], placetypeMap: PlacetypeMap): AddressNode | null {
	const leading = collectNodes(roots, (node) => !!node.value.trim()).toSorted((a, b) => a.start - b.start)[0]

	return leading && placetypeMap[leading.tag as keyof PlacetypeMap] ? leading : null
}

/**
 * Refuses an outcome request when the gazetteer or a landmark layer predates the outcome tables.
 *
 * A data layer without a report of its tables reads no outcome sets, so it is refused with every table.
 *
 * @throws {OutcomeRequestError} Naming the data layer and its missing tables.
 */
export function refuseLayersWithoutOutcomeTables(
	backend: Pick<ResolverBackend, "missingOutcomeTables">,
	layers: ReadonlyArray<{ name: string; lookup: LandmarkLookup }>
): void {
	refuseMissingOutcomeTables("the gazetteer database", backend.missingOutcomeTables?.() ?? OUTCOME_TABLES)

	for (const { name, lookup } of layers) {
		refuseMissingOutcomeTables(`the ${name} database`, lookup.missingOutcomeTables?.() ?? OUTCOME_TABLES)
	}
}

/**
 * The context a landmark candidate is admitted under: the lookup's country
 * and the nearest resolved locality above the span.
 */
export interface LandmarkContext {
	country: string | null
	locality: { lat: number; lon: number } | null
}

/**
 * The landmark layers' candidates for a span, each marked whether the stated context admits it,
 * under the layer's existing rule: the stated country, and 50 km of a stated locality.
 *
 * `hits` maps each candidate back to the hit it came from.
 */
export async function landmarkSpanCandidates(
	layers: readonly LandmarkLookup[],
	value: string,
	outcome: ResolveOutcome,
	context: LandmarkContext
): Promise<{ candidates: ResolvedPlace[]; hits: Map<string, LandmarkHit> }> {
	const hits = new Map<string, LandmarkHit>()
	const candidates: ResolvedPlace[] = []

	for (const layer of layers) {
		for (const hit of await findWithOutcome(layer, value, outcome)) {
			// A settlement row is the admin ladder's to answer.
			if (hit.kind !== "venue" || hits.has(hit.qid)) continue

			const inCountry = !context.country || hit.country === context.country

			const nearLocality =
				!context.locality ||
				haversine(context.locality.lat, context.locality.lon, hit.lat, hit.lon) <= STATED_LOCALITY_RADIUS_KM

			const admits = inCountry && nearLocality

			hits.set(hit.qid, hit)

			candidates.push({
				...placeOfLandmark(hit),
				exactMatch: hit.primary || hit.code,
				contextAdmits: admits,
				// A place within reach of the stated locality is inside it for the containment partition.
				containedByQualifier: context.locality ? admits : null,
			})
		}
	}

	// A candidate the stated context doesn't admit follows every one it does.
	return {
		candidates: [...candidates.filter((c) => c.contextAdmits), ...candidates.filter((c) => !c.contextAdmits)],
		hits,
	}
}
