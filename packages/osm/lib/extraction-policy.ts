/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The country extraction policies of the OpenStreetMap address-point build. Each country's policy lives
 *   in `lib/<cc>/extraction-policy.ts` and states which publisher regions may supply the country and which
 *   outline clips it out of a region that holds other countries. The policy is OpenStreetMap-specific: postal
 *   conventions stay in `@mailwoman/codex`, and corpus rendering stays in `@mailwoman/corpus`.
 *
 *   A policy selects inputs and clipping. It makes no claim that every address of the country is mapped.
 */

import { extractionPolicy as CA } from "#ca/extraction-policy"
import { extractionPolicy as DE } from "#de/extraction-policy"
import { extractionPolicy as FR } from "#fr/extraction-policy"
import { extractionPolicy as GB } from "#gb/extraction-policy"
import { extractionPolicy as ID } from "#id/extraction-policy"
import { extractionPolicy as NL } from "#nl/extraction-policy"
import { extractionPolicy as NZ } from "#nz/extraction-policy"
import { extractionPolicy as PK } from "#pk/extraction-policy"
import { extractionPolicy as PL } from "#pl/extraction-policy"
import { extractionPolicy as VN } from "#vn/extraction-policy"

/**
 * The row filter every policy applies, recorded in each artifact's derivation.
 */
export const ADDRESS_POINT_FILTER = "a node or area tagged addr:housenumber and addr:street, with a finite coordinate"

/**
 * One country's extraction policy.
 */
export interface OSMExtractionPolicy {
	/**
	 * The uppercase alpha-2 code.
	 */
	country: string
	/**
	 * Raised whenever a change to the policy would change the rows it derives,
	 * so an extraction under an earlier version is never reused.
	 */
	version: number
	/**
	 * Geofabrik region identities that hold the country, the country's own extract first.
	 *
	 * The build acquires the first unless the request names another region that holds the country.
	 */
	regions: readonly string[]
	/**
	 * The outline that clips the country out of a region holding other countries,
	 * by its publisher's ISO 3166-1 alpha-3 key.
	 *
	 * A region whose only country is this one is not clipped, as the rooftop builder has never clipped one.
	 */
	outline: { publisher: "geoBoundaries"; iso3: string }
}

const POLICIES: ReadonlyMap<string, OSMExtractionPolicy> = new Map(
	[CA, DE, FR, GB, ID, NL, NZ, PK, PL, VN].map((policy) => [policy.country, policy])
)

/**
 * The policy for an alpha-2 country, or `null` when the build has none for it.
 */
export function extractionPolicyFor(country: string): OSMExtractionPolicy | null {
	return POLICIES.get(country.toUpperCase()) ?? null
}

/**
 * The countries the build has a policy for, sorted.
 */
export function extractionPolicyCountries(): string[] {
	return [...POLICIES.keys()].toSorted()
}

/**
 * The name a policy is recorded under in an artifact's derivation.
 */
export function extractionPolicyName(policy: OSMExtractionPolicy): string {
	return `osm/${policy.country.toLowerCase()}/extraction-policy`
}
