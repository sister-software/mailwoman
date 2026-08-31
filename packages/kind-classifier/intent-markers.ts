/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Marker derivation for the ROAD_TO_V9 §4 intent vocabulary. Pure, synchronous, and the ONLY place
 *   the classifier turns a fired rule into something a caller reads.
 *
 *   Three of the four intent kinds can raise their marker here, from the string alone. The fourth —
 *   `bare_toponym`'s `declared_ambiguity` — cannot: its trigger is the dominance margin of the
 *   RESOLVED candidate list, which does not exist yet at Stage 2.5. That one is raised by
 *   `mailwoman/query-intent.ts` after the resolve, against the measured 0.5-log10 cut. The split is
 *   deliberate and it is why this module never emits `declared_ambiguity`: a marker that asserted
 *   ambiguity from the string alone would be declaring that every bare city name is ambiguous, which
 *   is false 89.1% of the time (the measured table behind `DECISIVE_MARGIN_LOG10`).
 */

import { nearMeSubject } from "#intent-rules"
import { matchPOICategory, type POIPhraseLookup } from "#poi"
import type { NormalizedInputLite, QueryIntentMarker, QueryKind } from "#types"

/**
 * Context the marker builder needs beyond the scored kinds.
 */
export interface IntentMarkerContext {
	input: NormalizedInputLite
	/**
	 * The injected POI lexicon, when one was wired. Absent → no `poi_category` marker can be built, which is consistent
	 * because the kind cannot fire without it either.
	 */
	poiLexicon?: POIPhraseLookup
	locale?: string
}

/**
 * Build the advisories for one classified query.
 *
 * `kinds` is the FULL verdict — top plus alternatives — because two of the four intent kinds live in `alternatives` by
 * design (see `intent-rules.ts`). Reading only the top kind would make them invisible, which is the mistake this
 * signature exists to prevent.
 *
 * Returns `[]` when no intent kind fired. Callers surface that empty array rather than dropping the field: an empty
 * array is the classifier stating it looked.
 */
export function deriveIntentMarkers(
	kinds: ReadonlyArray<{ kind: QueryKind; confidence: number }>,
	ctx: IntentMarkerContext
): QueryIntentMarker[] {
	const fired = new Set<QueryKind>(kinds.map((k) => k.kind))
	const markers: QueryIntentMarker[] = []

	if (fired.has("route_pair")) {
		const tokens = ctx.input.normalized.trim().split(/\s+/)

		markers.push({
			kind: "route_pair",
			code: "declared_fork",
			mechanism: "kind:route_pair",
			message: `"${tokens.join(" ")}" reads two ways and the pipeline is not choosing between them: two distinct places, or one place with its admin context.`,
			evidence: {
				tokens,
				/**
				 * Both readings, named. The order is stable (pair first, then the admin reading) so a consumer can index it; it
				 * is NOT a ranking, and nothing downstream reads it as one.
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
				 * The SEAM, named but not wired (ROAD_TO_V9 §4.4 scopes v9 to classification). Photon's `/api` already accepts
				 * `lat`/`lon` location-bias params — `photon/` is the eventual consumer of this marker, and this string is the
				 * note that says where it plugs in.
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
