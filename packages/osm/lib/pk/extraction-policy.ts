// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Pakistan's OpenStreetMap extraction policy.
 */

import type { OSMExtractionPolicy } from "#extraction-policy"

/**
 * Pakistan's Geofabrik region and its geoBoundaries ADM0 outline.
 */
export const extractionPolicy: OSMExtractionPolicy = {
	country: "PK",
	version: 1,
	regions: ["asia/pakistan"],
	outline: { publisher: "geoBoundaries", iso3: "PAK" },
}
