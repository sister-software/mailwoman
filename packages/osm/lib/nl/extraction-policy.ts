/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Netherlands' OpenStreetMap extraction policy.
 */

import type { OSMExtractionPolicy } from "#extraction-policy"

/**
 * The Netherlands' Geofabrik region and its geoBoundaries ADM0 outline.
 */
export const extractionPolicy: OSMExtractionPolicy = {
	country: "NL",
	version: 1,
	regions: ["europe/netherlands"],
	outline: { publisher: "geoBoundaries", iso3: "NLD" },
}
