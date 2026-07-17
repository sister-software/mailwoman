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

/**
 * Coarse per-country bounding boxes `[latMin, latMax, lonMin, lonMax]` for the cross-country guard (guard B). These are
 * DELIBERATELY rough — a guard needs "obviously the wrong country", not cartography — and they mirror the boxes the
 * 2026-07-15 coordinate-parity receipt harness measured with (`scratchpad/coord-parity.mjs`). The US box spans Alaska →
 * the mainland east coast; continental FR only; etc. A country absent here simply never trips the guard (fail-open).
 */
const COUNTRY_BBOX: Readonly<Record<string, readonly [number, number, number, number]>> = {
	US: [18, 72, -180, -66],
	AU: [-44, -10, 112, 154],
	BR: [-34, 6, -74, -34],
	CZ: [48, 51.5, 12, 19],
	DE: [47, 55.5, 5.5, 15.5],
	ES: [35, 44, -10, 5],
	FR: [41, 51.5, -5.5, 9.8],
	GB: [49, 61, -8.7, 2],
	HR: [42, 46.6, 13, 19.5],
	IN: [6, 36, 68, 98],
	NL: [50.7, 53.7, 3.3, 7.3],
	NO: [57, 71.5, 4, 31],
	PL: [49, 55, 14, 24.2],
	PT: [36.5, 42.2, -9.6, -6.1],
	RO: [43.5, 48.3, 20, 30],
	SE: [55, 69.1, 10.9, 24.2],
	SK: [47.7, 49.7, 16.8, 22.6],
	SI: [45.4, 46.9, 13.3, 16.6],
}

/** True when the coordinate lies outside `countryCode`'s coarse bbox. Unknown country codes are fail-open (false). */
export function outsideExpectedCountry(countryCode: string, lat: number, lon: number): boolean {
	const b = COUNTRY_BBOX[countryCode.toUpperCase()]

	if (!b) return false

	return lat < b[0] || lat > b[1] || lon < b[2] || lon > b[3]
}

/** Result of {@link isImplausibleResolution} — the boolean plus the reason, for telemetry + fallback logs. */
export interface PlausibilityVerdict {
	implausible: boolean
	/**
	 * Set when `implausible` is true. `country-centroid` = resolved no finer than a country (guard A);
	 * `outside-expected-country` = the served coordinate lies outside the expected country's bbox (guard B).
	 */
	reason?: "country-centroid" | "outside-expected-country"
	/** The coordinate the verdict was drawn from, when anything resolved. */
	coordinate?: ResolvedCoordinate
}

export interface PlausibilityOpts {
	/**
	 * ISO-2 country the resolution is EXPECTED to land in, when the caller knows it (a locale hint, a parsed country, a
	 * fixture's gold country). Enables guard B: a coordinate outside this country's coarse bbox is implausible — the
	 * cross-country-jump class guard A structurally cannot catch (`1210a IA 10 W IA` → a coordinate ~10,000 km from the
	 * US was country-centroid-free and sailed through until guard B landed here, 2026-07-17; previously the check lived
	 * only in the receipt harness, so the shipped residual read 5/321 while the receipt said 3/321).
	 */
	expectedCountry?: string
}

/**
 * Decide whether a resolved tree's geocode is implausible for a structured address — the cheap guard the v7 hybrid gate
 * runs after routing an input to the neural parser (#38). Trips when the finest resolved place is a bare `country`
 * centroid (guard A), or — when the caller supplies `expectedCountry` — when the served coordinate falls outside that
 * country's coarse bbox (guard B). An unresolved tree (nothing to serve) is plausible: there is no garbage to serve.
 */
export function isImplausibleResolution(tree: AddressTree, opts: PlausibilityOpts = {}): PlausibilityVerdict {
	const coordinate = finestResolvedCoordinate(tree)

	if (coordinate && coordinate.tag === "country") {
		return { implausible: true, reason: "country-centroid", coordinate }
	}

	if (
		coordinate &&
		opts.expectedCountry &&
		outsideExpectedCountry(opts.expectedCountry, coordinate.lat, coordinate.lon)
	) {
		return { implausible: true, reason: "outside-expected-country", coordinate }
	}

	return { implausible: false, coordinate: coordinate ?? undefined }
}
