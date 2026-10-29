/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   New Zealand's OpenStreetMap extraction policy.
 */

import type { OSMExtractionPolicy } from "#extraction-policy"

/**
 * New Zealand's Geofabrik region and its geoBoundaries ADM0 outline.
 */
export const extractionPolicy: OSMExtractionPolicy = {
	country: "NZ",
	version: 1,
	regions: ["australia-oceania/new-zealand"],
	outline: { publisher: "geoBoundaries", iso3: "NZL" },
}
