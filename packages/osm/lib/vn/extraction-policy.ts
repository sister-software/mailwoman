// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Vietnam's OpenStreetMap extraction policy.
 */

import type { OSMExtractionPolicy } from "#extraction-policy"

/**
 * Vietnam's Geofabrik region and its geoBoundaries ADM0 outline.
 */
export const extractionPolicy: OSMExtractionPolicy = {
	country: "VN",
	version: 1,
	regions: ["asia/vietnam"],
	outline: { publisher: "geoBoundaries", iso3: "VNM" },
}
