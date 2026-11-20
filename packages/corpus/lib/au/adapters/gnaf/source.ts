// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Where Geoscape Australia's G-NAF is published, for the rooftop build that records it
 *   and for a reader that links a user to it.
 */

import type { SourceLocation } from "@mailwoman/core/resolver"

/**
 * The name the G-NAF rooftop build records in a manifest's `source`, before the `:au` scope.
 */
export const GNAF_SOURCE_NAME = "gnaf"

/**
 * Where a user obtains G-NAF.
 *
 * The data.gov.au dataset lists each quarterly release's download and its end-user license.
 */
export const GNAF_SOURCE_LOCATIONS: Readonly<Record<string, SourceLocation>> = {
	[GNAF_SOURCE_NAME]: {
		title: "Geoscape Australia, G-NAF",
		url: "https://data.gov.au/data/dataset/geocoded-national-address-file-g-naf",
	},
}
