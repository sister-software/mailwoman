// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Where the U.S. Census Bureau publishes the TIGER/Line Shapefiles, for the interpolation
 *   build that records them and for a server that links a user to them.
 */

import type { SourceLocation } from "@mailwoman/core/resolver"

/**
 * The name the US interpolation build records in a manifest's `source` for TIGER/Line.
 */
export const TIGER_SOURCE_NAME = "tiger"

/**
 * Where a user obtains each source a TIGER/Line layer records.
 *
 * The page lists every TIGER/Line release by year and links each release's files.
 */
export const TIGER_SOURCE_LOCATIONS: Readonly<Record<string, SourceLocation>> = {
	[TIGER_SOURCE_NAME]: {
		title: "U.S. Census Bureau, TIGER/Line Shapefiles",
		url: "https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-line-file.html",
	},
}
