// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The steps the resolver walk runs on the span outcome ordering applies to:
 *   the request's state, the extra fetches of the candidate table, the landmark candidates,
 *   the order-4 partition and the pick's stamps.
 */

import { DEFAULT_PLACETYPE_MAP } from "@mailwoman/codex/labels/placetype-map"
import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import type { LandmarkHit, ResolvedPlace, ResolveOpts, ResolverBackend } from "@mailwoman/core/resolver"
import { OutcomeLayer } from "@mailwoman/core/resolver/outcome"

import { BARE_SUBLOCALITY_BANDS } from "#bare-toponym-race"
import { OUTCOME_SET_KEY, OUTCOME_TARGET_KEY, outcomeOrderOf, secondFetchQuery } from "#outcome/fetch"
import { mergeByWikidata, mergeFetches, partitionByOutcome } from "#outcome/ordering"
import { landmarkSpanCandidates, outcomeTargetSpan, refuseLayersWithoutOutcomeTables } from "#outcome/span"
import type { CoordinateOptionalPlace } from "#postcode/prefix"
import type { ResolutionState } from "#resolve/passes"

/**
 * The outcome state of one span: the request, the span and the landmark layers it reads.
 */
export type OutcomeSpan = NonNullable<ResolutionState["outcome"]>

type FindPlaceQuery = Parameters<ResolverBackend["findPlace"]>[0]

/**
 * The resolver state of an outcome request, or an empty object without a request or a leading span to order.
 *
 * @throws {OutcomeRequestError} When a data layer predates the outcome tables.
 */
export function outcomeState(
	tree: AddressTree,
	opts: ResolveOpts,
	backend: ResolverBackend
): Pick<ResolutionState, "outcome"> {
	if (!opts.outcome) return {}

	const named = [
		...(opts.landmarks ? [{ name: OutcomeLayer.Landmarks, lookup: opts.landmarks }] : []),
		...(opts.osmPlaces ? [{ name: OutcomeLayer.OpenStreetMap, lookup: opts.osmPlaces }] : []),
	]

	refuseLayersWithoutOutcomeTables(backend, named)

	const target = outcomeTargetSpan(tree.roots, opts.placetypeMap ?? DEFAULT_PLACETYPE_MAP)

	if (!target) return {}

	return { outcome: { request: opts.outcome, target, layers: named.map((layer) => layer.lookup) } }
}

/**
 * The candidate table's fetches beyond the usual one.
 *
 * The hint, or the head's first reading, adds one fetch of the rows that satisfy it.
 * The bare-toponym race stands down on an outcome-ordered span, so a bare name also
 * reads the sub-locality and admin bands the race would have probed.
 */
export async function outcomeFetches(
	backend: ResolverBackend,
	query: FindPlaceQuery,
	span: OutcomeSpan,
	bareName: boolean,
	candidates: ResolvedPlace[]
): Promise<ResolvedPlace[]> {
	let merged = candidates
	const second = secondFetchQuery(span.request)

	if (second) {
		merged = mergeFetches(merged, await backend.findPlace({ ...query, outcome: second }))
	}

	if (bareName) {
		const bands = [...BARE_SUBLOCALITY_BANDS, "region", "country"]

		merged = mergeFetches(merged, await backend.findPlace({ ...query, placetype: bands }))
	}

	return merged
}

/**
 * The landmark layers' candidates for the span, admitted under the lookup's country
 * and the span's resolved locality parent.
 */
export function spanLayerCandidates(
	span: OutcomeSpan,
	node: AddressNode,
	country: string | null,
	parentResolved: CoordinateOptionalPlace | null
): ReturnType<typeof landmarkSpanCandidates> {
	const locality =
		parentResolved?.placetype === "locality" && parentResolved.lat != null && parentResolved.lon != null
			? { lat: parentResolved.lat, lon: parentResolved.lon }
			: null

	return landmarkSpanCandidates(span.layers, node.value, span.request, { country, locality })
}

/**
 * Order 4: one candidate list across the data layers, one place per Wikidata item,
 * then the outcome partition inside each conformance class.
 */
export function orderSpanByOutcome(
	ranked: readonly ResolvedPlace[],
	span: OutcomeSpan,
	layered: readonly ResolvedPlace[],
	posterior: Readonly<Record<string, number>> | null | undefined
): ResolvedPlace[] {
	const table = ranked.map((c) => ({ ...c, layer: OutcomeLayer.Candidate }))

	return partitionByOutcome(mergeByWikidata([...table, ...layered]), outcomeOrderOf(span.request), posterior)
}

/**
 * The metadata an outcome-ordered span's pick writes: the span's mark, the place's
 * outcome set, and a landmark winner's sitelinks and source.
 * The geocode result reads all four.
 */
export function outcomePickStamps(top: ResolvedPlace, hits: ReadonlyMap<string, LandmarkHit>): Record<string, unknown> {
	const hit = top.layer && top.layer !== OutcomeLayer.Candidate ? hits.get(String(top.id)) : undefined

	return {
		[OUTCOME_TARGET_KEY]: true,
		[OUTCOME_SET_KEY]: top.outcomes ?? [],
		...(hit ? { landmark_sitelinks: hit.sitelinks } : {}),
		...(top.layer === OutcomeLayer.OpenStreetMap ? { landmark_source: "openstreetmap:planet" } : {}),
	}
}
