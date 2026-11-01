// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Indonesia's OpenStreetMap extraction policy.
 */

import type { OSMExtractionPolicy } from "#extraction-policy"

/**
 * Indonesia's Geofabrik region and its geoBoundaries ADM0 outline.
 */
export const extractionPolicy: OSMExtractionPolicy = {
	country: "ID",
	version: 1,
	regions: ["asia/indonesia"],
	outline: { publisher: "geoBoundaries", iso3: "IDN" },
}
