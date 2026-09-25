/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { PostcodePrefixIndexLike, PostcodePrefixNode, ResolvedPlace } from "@mailwoman/core/resolver"

/**
 * Describes a resolved place whose coordinate may be absent, such as a
 * postcode-prefix hit with ancestry only.
 *
 * A missing coordinate must stay `undefined` rather than become an invented centroid,
 * which would place the postcode somewhere it is not.
 */
export type CoordinateOptionalPlace = Omit<ResolvedPlace, "lat" | "lon"> & { lat?: number; lon?: number }

const MIN_GB_OUTWARD_CODE_LENGTH = 5

const MIN_US_SECTION_CODE_LENGTH = 3

/**
 * Derives the key a postcode prefix index uses for `code`: the GB outward code
 * or the US three-digit prefix.
 *
 * @returns `null` for a country with no rule or a code too short to carry a prefix.
 */
export function derivePostcodePrefix(code: string, country?: string): string | null {
	if (!code || !country) return null

	const compact = code.replaceAll(/\s+/g, "")

	switch (country.toUpperCase()) {
		case "GB":
			return compact.length >= MIN_GB_OUTWARD_CODE_LENGTH ? compact.slice(0, -3) : null

		case "US":
			return compact.length >= MIN_US_SECTION_CODE_LENGTH ? compact.slice(0, 3) : null
		default:
			return null
	}
}

/**
 * The outcome of a successful prefix probe.
 */
export interface PostcodePrefixProbeResult {
	/**
	 * The prefix derived from the code that matched an index entry.
	 */
	prefix: string

	/**
	 * The matched index node, whose ancestors and optional centroid and radius supply the prior.
	 */
	node: PostcodePrefixNode
}

/**
 * Looks up `code`'s prefix in the index, returning `null` when the query's country
 * differs from the index's or no indexed prefix can be derived.
 */
export function probePostcodePrefix(
	code: string,
	index: PostcodePrefixIndexLike,
	queryCountry?: string
): PostcodePrefixProbeResult | null {
	const indexCountry = index.country?.toUpperCase()

	if (queryCountry && indexCountry && queryCountry.toUpperCase() !== indexCountry) return null

	const prefix = derivePostcodePrefix(code, indexCountry)

	if (!prefix) return null

	const node = index.probe(prefix)

	return node ? { prefix, node } : null
}

/**
 * Builds the synthetic `postalcode` place for a prefix hit, with `id: 0` because it is not a gazetteer row.
 * It carries a coordinate only when the prefix node has one.
 */
export function postcodePrefixResolvedPlace(
	prefix: string,
	node: PostcodePrefixNode,
	index: PostcodePrefixIndexLike
): CoordinateOptionalPlace {
	return {
		id: 0,
		name: prefix,
		placetype: "postalcode",

		country: index.country?.toUpperCase() ?? "",
		...(node.lat !== undefined && node.lon !== undefined ? { lat: node.lat, lon: node.lon } : {}),
		score: 0,
		exactMatch: false,
	}
}
