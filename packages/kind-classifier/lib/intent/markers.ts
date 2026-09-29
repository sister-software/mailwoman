/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Marker derivation for the ROAD_TO_V9 §4 intent vocabulary. This code is pure and synchronous. It is the only place the
 * classifier turns a fired rule into something a caller reads.
 *
 * Three of the four intent kinds can raise their marker here from the string by itself. The fourth,
 * Stage 2.5 cannot raise `bare_toponym`'s `declared_ambiguity` from the string by itself.
 * Its trigger is the dominance margin of the resolved candidate list. `mailwoman/query-intent.ts` raises it
 * after the resolve against `DECISIVE_MARGIN_LOG10`. This module therefore never emits
 * `declared_ambiguity`, since a marker asserting ambiguity from the string by itself would declare every
 * bare city name ambiguous.
 */

import type { QueryIntentMarker, QueryKind } from "@mailwoman/core/pipeline"
import type { NormalizedInputLite } from "@mailwoman/query-shape"

import { nearMeSubject } from "#intent/rules"
import { matchPOICategory, type POIPhraseLookup } from "#poi"

/**
 * Context the marker builder needs beyond the scored kinds.
 */
export interface IntentMarkerContext {
	input: NormalizedInputLite
	/**
	 * The injected POI lexicon when one was wired.
	 *
	 * Absent means no `poi_category` marker can be built, consistent with the
	 * kind not firing without it either.
	 */
	poiLexicon?: POIPhraseLookup
	locale?: string
}

/**
 * Build the advisories for one classified query, taking the full verdict — top plus alternatives —
 * because two of the four intent kinds live in `alternatives` by design (see `intent-rules.ts`).
 *
 * @returns `[]` when no intent kind fired.
 * Callers surface that empty array rather than dropping the field, because an
 * empty array is the classifier stating it looked.
 */
export function deriveIntentMarkers(
	kinds: ReadonlyArray<{ kind: QueryKind; confidence: number }>,
	ctx: IntentMarkerContext
): QueryIntentMarker[] {
	const fired = new Set<QueryKind>(kinds.map((k) => k.kind))
	const markers: QueryIntentMarker[] = []

	if (fired.has("route_pair")) {
		// Whitespace-only split rather than `wordsOf`, because `route_pair` inputs are
		// comma-free by construction and the tokens are re-joined verbatim into the message.
		const tokens = ctx.input.normalized.trim().split(/\s+/)

		markers.push({
			kind: "route_pair",
			code: "declared_fork",
			mechanism: "kind:route_pair",
			message: `"${tokens.join(" ")}" reads two ways and the pipeline is not choosing between them: two distinct places, or one place with its admin context.`,
			evidence: {
				tokens,
				/**
				 * Both readings, listed.
				 *
				 * The order is stable: pair first, then the admin reading.
				 * A consumer can index it.
				 * This order does not rank the entries.
				 */
				interpretations: ["two_toponyms", "locality_with_admin_context"],
			},
		})
	}

	if (fired.has("near_me")) {
		const subject = nearMeSubject(ctx.input)

		markers.push({
			kind: "near_me",
			code: "focus_point_required",
			mechanism: "kind:near_me",
			message: `"${subject}" was asked for relative to the asker, and no focus point was supplied.`,
			evidence: {
				subject,
				/**
				 * The plug point is documented but not wired.
				 *
				 * `photon/` is the eventual consumer.
				 * Its `/api` already accepts `lat`/`lon` location-bias params.
				 */
				focusParameter: "photon:lat/lon",
			},
		})
	}

	if (fired.has("poi_category") && ctx.poiLexicon) {
		const match = matchPOICategory(ctx.input.normalized, ctx.locale ?? ctx.input.appliedLocale, ctx.poiLexicon)

		if (match) {
			markers.push({
				kind: "poi_category",
				code: "poi_category",
				mechanism: "poi-taxonomy:synonym",
				message: `"${match.matchedPhrase}" is a POI category with no place to search; resolution against poi.db is out of scope.`,
				evidence: {
					categoryID: match.categoryID,
					matchedPhrase: match.matchedPhrase,
					...(match.wikidata ? { wikidata: match.wikidata } : {}),
				},
			})
		}
	}

	return markers
}
