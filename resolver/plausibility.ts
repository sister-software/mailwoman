/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Resolution-plausibility guard (#727 / v7 excision arc).
 *
 *   The 2026-07-15 coordinate-parity study
 *   (`docs/articles/evals/2026-07-15-v7-parity-floor-diagnosis.md`) found the neural parser is
 *   coordinate-safe on well-formed input (98.6% within 1 km of the rules parser through the same
 *   resolver) but produces a garbage-geocode tail on the bare-fragment / bare-state-name / US-highway
 *   classes — inputs like `California` or `6000, NSW, Australia` that resolve to nothing finer than a
 *   country centroid.
 *
 *   This guard is the cheap post-resolve check for that tail: a resolved tree whose finest resolved
 *   place is only a `country` centroid is implausible for a structured address. It reads only the
 *   decorated tree — no gazetteer, no extra query — so it is free to run on every resolve. It is
 *   deliberately DIRECTION-AGNOSTIC about what the caller does with the signal: serve the result with
 *   a low-confidence marker, prefer a sibling parse hypothesis (the #727 k-best rerank), or decline to
 *   emit a coordinate. It is NOT a rules-fallback trigger — the v7 excision deletes the rules parser
 *   outright (operator ruling 2026-07-15), so no consumer may route through legacy rules on a trip.
 *
 *   It deliberately does NOT flag region-tier resolutions: a US state or a province centroid
 *   (`Texas` → the TX centroid) is a legitimate coarse geocode, not garbage. Only "resolved no finer
 *   than a country" trips it.
 */

import type { AddressNode, AddressTree, ComponentTag } from "@mailwoman/core/decoder"

/**
 * Resolution granularity, coarse → fine. A resolved node's {@link AddressNode.tag} places it on this ladder; the
 * geocode a caller serves comes from the FINEST resolved node. Tags absent here (unit, po_box, intersection halves, …)
 * are treated as street-tier specificity when resolved.
 */
const RESOLUTION_TIER: Partial<Record<ComponentTag, number>> = {
	country: 0,
	region: 1,
	subregion: 2,
	dependent_locality: 3,
	locality: 3,
	postcode: 4,
	venue: 4,
	street: 4,
	street_prefix: 4,
	street_suffix: 4,
	house_number: 5,
}

/** A resolved place lifted off the tree — the coordinate a caller would serve, plus its granularity tag. */
export interface ResolvedCoordinate {
	tag: ComponentTag
	lat: number
	lon: number
	/** Canonical place URI (`wof:…`) when the resolver supplied one. */
	placeID?: string
}

/**
 * Walk a resolved {@link AddressTree} and return the FINEST resolved place — the node carrying a resolver-supplied
 * coordinate at the deepest granularity tier. Returns `null` when nothing resolved (no node carries a `lat`/`lon`).
 * Ties break toward the first node in document order.
 */
export function finestResolvedCoordinate(tree: AddressTree): ResolvedCoordinate | null {
	let best: ResolvedCoordinate | null = null
	let bestTier = -1

	const visit = (node: AddressNode): void => {
		if (node.lat !== undefined && node.lon !== undefined) {
			const tier = RESOLUTION_TIER[node.tag] ?? 4

			if (tier > bestTier) {
				bestTier = tier
				best = { tag: node.tag, lat: node.lat, lon: node.lon, placeID: node.placeID }
			}
		}

		for (const child of node.children) {
			visit(child)
		}
	}

	for (const root of tree.roots) {
		visit(root)
	}

	return best
}

/** Result of {@link isImplausibleResolution} — the boolean plus the reason, for telemetry + fallback logs. */
export interface PlausibilityVerdict {
	implausible: boolean
	/** Set when `implausible` is true. `country-centroid` = resolved no finer than a country. */
	reason?: "country-centroid"
	/** The coordinate the verdict was drawn from, when anything resolved. */
	coordinate?: ResolvedCoordinate
}

/**
 * Decide whether a resolved tree's geocode is implausible for a structured address — the cheap guard the v7 hybrid gate
 * runs after routing an input to the neural parser (#38). Trips only when the finest resolved place is a bare `country`
 * centroid; an unresolved tree (nothing to serve) and any region-or-finer resolution are both plausible.
 */
export function isImplausibleResolution(tree: AddressTree): PlausibilityVerdict {
	const coordinate = finestResolvedCoordinate(tree)

	if (coordinate && coordinate.tag === "country") {
		return { implausible: true, reason: "country-centroid", coordinate }
	}

	return { implausible: false, coordinate: coordinate ?? undefined }
}
