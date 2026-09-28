/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Node decoration shared by the resolver walk and its post-walk passes, in its own module so the
 *   coherence passes do not import the walk.
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
 * Stamp a node with resolver-supplied attribution, displacing any prior classifier `source`
 * / `sourceID` into `metadata.classifier_source` / `metadata.classifier_source_id`
 * and surfacing runner-up candidates on `alternatives`.
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

	// `0,0` is the gazetteer's unlocated sentinel, so an unlocated place gets both coordinates
	// cleared rather than a coordinate that satisfies every `lat != null` guard downstream.
	const located = resolved.lat !== undefined && resolved.lon !== undefined && (resolved.lat !== 0 || resolved.lon !== 0)

	if (located) {
		node.lat = resolved.lat
		node.lon = resolved.lon
	} else {
		delete node.lat
		delete node.lon
	}

	node.placeID = `wof:${resolved.id}` // v1: only WOF resolvers. the URI scheme stays this simple
	node.metadata = { ...node.metadata, resolver_score: resolved.score, resolver_name: resolved.name }

	// Additive metadata only.
	// No part of the resolve reads it back.
	if (resolved.prominence !== undefined) {
		node.metadata["resolver_prominence"] = resolved.prominence
	}

	if (resolved.country) {
		node.metadata["resolver_country"] = resolved.country
	}

	// Written only when the backend supplies a value, because `resolver_*: 0`
	// would assert an unmeasured value.
	if (resolved.referential !== undefined) {
		node.metadata["resolver_referential"] = resolved.referential
	}

	if (resolved.encyclopedic !== undefined) {
		node.metadata["resolver_encyclopedic"] = resolved.encyclopedic
	}

	if (resolved.importance !== undefined) {
		node.metadata["resolver_importance"] = resolved.importance
	}

	// The postcode pointed to a geographically different place than the parsed city name,
	// surfaced so callers can warn rather than silently trust the resolved point.
	if (resolved.mismatch) {
		node.metadata["postcode_city_mismatch"] = true
	}

	// A broader admin tier stood in for the true region/county because no exact-type candidate existed.
	// Additive annotation only.
	if (resolved.resolutionQuality) {
		node.metadata["resolution_quality"] = resolved.resolutionQuality
	}

	if (alternatives.length) {
		node.alternatives = alternatives
	}
}
