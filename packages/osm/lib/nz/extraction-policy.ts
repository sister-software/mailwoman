// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
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
