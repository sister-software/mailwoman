// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Where the U.S. Department of Transportation publishes the National Address Database,
 *   for the US address layer build that records it and for a reader that links a user to it.
 */

import type { SourceLocation } from "@mailwoman/core/resolver"

/**
 * The name the US address layer build records in a manifest's `source` for the National Address Database.
 */
export const NAD_SOURCE_NAME = "usgov-nad"

/**
 * Where a user obtains the National Address Database.
 *
 * The page describes the database and links its current release on DOT's open-data portal.
 */
export const NAD_SOURCE_LOCATIONS: Readonly<Record<string, SourceLocation>> = {
	[NAD_SOURCE_NAME]: {
		title: "U.S. Department of Transportation, National Address Database",
		url: "https://www.transportation.gov/gis/national-address-database",
	},
}
