/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Germany's OpenStreetMap extraction policy. `europe/dach` holds Germany with Austria and Switzerland, so a
 *   build from it clips Germany by its geoBoundaries outline.
 */

import type { OSMExtractionPolicy } from "#extraction-policy"

/**
 * Germany's Geofabrik regions, its own extract first, and its geoBoundaries ADM0 outline.
 */
export const extractionPolicy: OSMExtractionPolicy = {
	country: "DE",
	version: 1,
	regions: ["europe/germany", "europe/dach"],
	outline: { publisher: "geoBoundaries", iso3: "DEU" },
}
