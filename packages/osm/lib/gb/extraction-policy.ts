/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The United Kingdom's OpenStreetMap extraction policy. `europe/britain-and-ireland` also holds Ireland and
 *   the Isle of Man, so a build from it clips the United Kingdom by its geoBoundaries outline.
 */

import type { OSMExtractionPolicy } from "#extraction-policy"

/**
 * The United Kingdom's Geofabrik regions, its own extract first, and its geoBoundaries ADM0 outline.
 */
export const extractionPolicy: OSMExtractionPolicy = {
	country: "GB",
	version: 1,
	regions: ["europe/united-kingdom", "europe/britain-and-ireland"],
	outline: { publisher: "geoBoundaries", iso3: "GBR" },
}
