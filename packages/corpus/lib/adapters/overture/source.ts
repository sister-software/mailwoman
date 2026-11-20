// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Where Overture Maps publishes its addresses theme, for a layer build that records it
 *   and for a reader that links a user to it.
 */

import type { SourceLocation } from "@mailwoman/core/resolver"

/**
 * The name an address layer build records in a manifest's `source` for Overture's addresses theme.
 */
export const OVERTURE_ADDRESSES_SOURCE_NAME = "overture"

/**
 * Where a user obtains Overture's addresses theme.
 *
 * The guide lists the release's S3 and Azure locations and shows how to download an extract.
 */
export const OVERTURE_ADDRESSES_SOURCE_LOCATIONS: Readonly<Record<string, SourceLocation>> = {
	[OVERTURE_ADDRESSES_SOURCE_NAME]: {
		title: "Overture Maps addresses theme",
		url: "https://docs.overturemaps.org/guides/addresses/",
	},
}
