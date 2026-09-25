/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { ComponentTag } from "@mailwoman/codex/component"
import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import type { CountryBBoxFact } from "@mailwoman/core/resolver"

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

/**
 * Holds the coordinate a caller would serve for a resolved tree, with the tag of the node that supplied it.
 */
export interface ResolvedCoordinate {
	tag: ComponentTag
	lat: number
	lon: number

	/**
	 * The canonical place URI, such as `wof:…`, when the resolver supplied one.
	 */
	placeID?: string
}

/**
 * Returns the resolved coordinate at the finest granularity tier in the tree,
 * preferring the earliest node on a tie.
 *
 * @returns `null` when no node carries a `lat`/`lon`.
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
 * Lists coarse per-country bounding boxes, as `[latMin, latMax, lonMin, lonMax]`,
 * for artifacts whose manifest declares none.
 *
 * Each box covers outlying territory rather than the populated core,
 * and a country without a box never trips the guard.
 */
export const COUNTRY_BBOX: Readonly<Record<string, readonly [number, number, number, number]>> = {
	US: [18, 72, -180, -66],
	AU: [-44, -10, 112, 154],
	BR: [-34, 6, -74, -34],
	CN: [15.7, 53.6, 73.4, 135.1],
	CZ: [48, 51.5, 12, 19],
	DE: [47, 55.5, 5.5, 15.5],
	ES: [35, 44, -10, 5],
	FR: [41, 51.5, -5.5, 9.8],
	GB: [49, 61, -8.7, 2],
	HR: [42, 46.6, 13, 19.5],
	IN: [6, 36, 68, 98],
	IT: [35.4, 47.1, 6.6, 18.6],
	JP: [20.2, 45.7, 122.8, 154.1],
	NL: [50.7, 53.7, 3.3, 7.3],
	NO: [57, 71.5, 4, 31],
	NZ: [-52.7, -29.1, -180, 180],
	PL: [49, 55, 14, 24.2],
	PT: [36.5, 42.2, -9.6, -6.1],
	RO: [43.5, 48.3, 20, 30],
	SE: [55, 69.1, 10.9, 24.2],
	SK: [47.7, 49.7, 16.8, 22.6],
	SI: [45.4, 46.9, 13.3, 16.6],
}

/**
 * Reports whether a coordinate lies outside the country's bounding box,
 * using `bboxes` in place of {@link COUNTRY_BBOX} when supplied.
 * A country with no box returns `false`.
 */
export function outsideExpectedCountry(
	countryCode: string,
	lat: number,
	lon: number,
	bboxes?: ReadonlyMap<string, CountryBBoxFact>
): boolean {
	const cc = countryCode.toUpperCase()

	if (bboxes) {
		const fact = bboxes.get(cc)

		if (!fact) return false

		return lat < fact.latMin || lat > fact.latMax || lon < fact.lonMin || lon > fact.lonMax
	}

	const b = COUNTRY_BBOX[cc]

	if (!b) return false

	return lat < b[0] || lat > b[1] || lon < b[2] || lon > b[3]
}

/**
 * Result of {@link isImplausibleResolution} — the boolean plus the reason, for telemetry + fallback logs.
 */
export interface PlausibilityVerdict {
	implausible: boolean

	/**
	 * Why the resolution is implausible, set only when `implausible` is true.
	 *
	 * `country-centroid` means nothing finer than a country resolved, and `outside-expected-country`
	 * means the coordinate falls outside the expected country's bounding box.
	 */
	reason?: "country-centroid" | "outside-expected-country"

	/**
	 * The coordinate the verdict was based on, present when anything resolved.
	 */
	coordinate?: ResolvedCoordinate
}

/**
 * Configures {@linkcode isImplausibleResolution} with the country the address should
 * fall in and optional artifact-declared bounding boxes.
 */
export interface PlausibilityOpts {
	/**
	 * The ISO 3166-1 alpha-2 country the resolution should land in, such as a locale hint or parsed country.
	 *
	 * Setting it enables the bounding-box check, which catches cross-country jumps
	 * that the country-centroid check cannot.
	 */
	expectedCountry?: string

	/**
	 * Artifact-declared country bounding boxes that replace the built-in
	 * {@link COUNTRY_BBOX} table entirely when supplied.
	 */
	countryBBoxes?: ReadonlyMap<string, CountryBBoxFact>
}

/**
 * Decides whether a resolved tree's coordinate is implausible: a bare country centroid,
 * or a point outside `expectedCountry`'s bounding box.
 *
 * An unresolved tree is plausible, because it serves no coordinate.
 */
export function isImplausibleResolution(tree: AddressTree, opts: PlausibilityOpts = {}): PlausibilityVerdict {
	const coordinate = finestResolvedCoordinate(tree)

	if (coordinate && coordinate.tag === "country") {
		return { implausible: true, reason: "country-centroid", coordinate }
	}

	if (
		coordinate &&
		opts.expectedCountry &&
		outsideExpectedCountry(opts.expectedCountry, coordinate.lat, coordinate.lon, opts.countryBBoxes)
	) {
		return { implausible: true, reason: "outside-expected-country", coordinate }
	}

	return { implausible: false, coordinate: coordinate ?? undefined }
}
