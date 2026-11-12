// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   France's OpenStreetMap extraction policy.
 *
 *   Geofabrik's `europe/france` extract holds metropolitan France.
 */

import type { OSMExtractionPolicy } from "#extraction-policy"

/**
 * France's Geofabrik region and its geoBoundaries ADM0 outline.
 */
export const extractionPolicy: OSMExtractionPolicy = {
	country: "FR",
	version: 1,
	regions: ["europe/france"],
	outline: { publisher: "geoBoundaries", iso3: "FRA" },
}
