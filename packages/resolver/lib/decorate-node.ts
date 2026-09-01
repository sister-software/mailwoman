/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Node decoration shared by the resolver walk and its post-walk passes — split from `resolve.ts`
 *   (the `bare-toponym-race.ts` precedent: the walk file holds the walk) so the coherence passes can
 *   live in their own module without an import cycle back into the walk.
 */

import type { AddressNode } from "@mailwoman/core/decoder"
import type { ResolvedPlace } from "@mailwoman/core/resolver"

import type { CoordinateOptionalPlace } from "#postcode/prefix"

/**
 * A resolved node carries a real coordinate (placeID set + non-zero lat/lon).
 */
export function isResolvedWithCoord(n: AddressNode): boolean {
	return !!(n.placeID && typeof n.lat === "number" && typeof n.lon === "number" && (n.lat !== 0 || n.lon !== 0))
}

/**
 * Stamp a node with resolver-supplied attribution. Displaces any prior classifier `source` / `sourceID` into
 * `metadata.classifier_source` / `metadata.classifier_source_id` so debugging tools can still see who made the original
 * assertion. Surfaces the runner-up candidates on `alternatives` so callers can disambiguate (Springfield-class
 * failures, [#8 in the failure catalogue]).
 */
export function decorateNode(
	node: AddressNode,
	resolved: CoordinateOptionalPlace,
	alternatives: ResolvedPlace[]
): void {
	if (node.source !== undefined || node.sourceID !== undefined) {
		const meta = { ...node.metadata }

		if (node.source !== undefined) {
			meta["classifier_source"] = node.source
		}

		if (node.sourceID !== undefined) {
			meta["classifier_source_id"] = node.sourceID
		}

		node.metadata = meta
	}

	node.source = "resolver"
	node.sourceID = `${resolved.placetype}:${resolved.id}`

	// `0,0` is the gazetteer's UNLOCATED sentinel, not a location in the Gulf of Guinea. Extracts carry a lot of it —
	// 48,216 of 142,604 JP postcodes, 86,377 GB, 9,708 intl, 414 US — and stamping it produces a node that answers
	// "yes" to every `lat != null` guard downstream, including the admin ladder's. Absence is the representable form
	// (`AddressNode.lat` is optional and {@link isResolvedWithCoord} already reads the sentinel this way), so the
	// place resolves and identifies itself while stating it cannot say where it is.
	//
	// Both are cleared together rather than left stale: a coordinate from a previously-decorated place beside this
	// one's `placeID` would be a worse answer than none.
	const located = resolved.lat !== undefined && resolved.lon !== undefined && (resolved.lat !== 0 || resolved.lon !== 0)

	if (located) {
		node.lat = resolved.lat
		node.lon = resolved.lon
	} else {
		delete node.lat
		delete node.lon
	}

	node.placeID = `wof:${resolved.id}` // v1: only WOF resolvers; the URI scheme stays this simple
	// Record the resolver's ranking score AND the resolved place's CANONICAL name. The name is the
	// gazetteer's truth for the place we picked — distinct from `node.value` (the raw input span). It
	// lets consumers display the canonical name and lets the end-to-end eval check the resolver chose
	// the right PLACE (gazetteer-name vs ground-truth) rather than merely echoing the parser's text.
	node.metadata = { ...node.metadata, resolver_score: resolved.score, resolver_name: resolved.name }

	// The winner's PROMINENCE, when the backend computed one. `alternatives` below are full `ResolvedPlace`s and
	// already carry theirs; without this stamp the WINNER's is the one value in the ranked list that gets dropped,
	// which makes a top-1-vs-top-2 margin uncomputable from the tree — and that margin is what
	// `mailwoman/query-intent.ts` reads to decide whether a bare-toponym answer was a clear win. Additive metadata
	// only; nothing in the resolve reads it back.
	if (resolved.prominence !== undefined) {
		node.metadata["resolver_prominence"] = resolved.prominence
	}

	// The resolved place's ISO-3166 alpha-2 country (from the gazetteer/candidate row), when known. #1014: lets a
	// forward consumer fill country/countrycode without an ancestry walk — the candidate backend carries this even
	// though it has no `ancestors()` table.
	if (resolved.country) {
		node.metadata["resolver_country"] = resolved.country
	}

	// The score-channel carries (ROAD_TO_V9 §2 + #28). Written ONLY when the backend actually has a
	// value: an absent score means "unmeasured" or "pre-split gazetteer", and a `resolver_*: 0` on the
	// node would assert a measurement nobody made. Nothing in the resolve path reads these keys back —
	// they exist for annotation / API surfaces downstream. `resolver_importance` is the blended #28
	// prior (the value the ranking consulted); `resolver_encyclopedic` is the strict channel, reserved
	// until a strict-channel source ships.
	if (resolved.referential !== undefined) {
		node.metadata["resolver_referential"] = resolved.referential
	}

	if (resolved.encyclopedic !== undefined) {
		node.metadata["resolver_encyclopedic"] = resolved.encyclopedic
	}

	if (resolved.importance !== undefined) {
		node.metadata["resolver_importance"] = resolved.importance
	}

	// The postcode/locality conflict flag (the falsehood differentiator): the postcode pointed to a
	// geographically different place than the parsed city name. Surface it so callers can warn rather
	// than silently trust the resolved point.
	if (resolved.mismatch) {
		node.metadata["postcode_city_mismatch"] = true
	}

	// Fallback-observability (#718): a broader admin tier (macroregion/macrocounty) stood in for the
	// true region/county because no exact-type candidate existed. Additive annotation only — the
	// resolved coordinate/identity above is untouched; this just lets a consumer / QA pass see it.
	if (resolved.resolutionQuality) {
		node.metadata["resolution_quality"] = resolved.resolutionQuality
	}

	if (alternatives.length) {
		node.alternatives = alternatives
	}
}
