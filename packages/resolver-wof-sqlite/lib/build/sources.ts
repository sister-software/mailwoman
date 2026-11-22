// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The sources a gazetteer build records in its `layer_manifest.source`, and
 *   where a user obtains each one.
 *
 *   The admin build writes these names, joined with `+`, and a server reads them
 *   back to link each collection to the data behind it.
 *   One table serves both, so a name the build writes always has its location here.
 */

import type { SourceLocation } from "@mailwoman/core/resolver"

/**
 * The name each gazetteer source goes by in a manifest's `source`.
 */
export const GazetteerSourceName = {
	WhosOnFirst: "whosonfirst",
	OvertureDivisions: "overture-divisions",
	GeoNames: "geonames",
} as const

export type GazetteerSourceName = (typeof GazetteerSourceName)[keyof typeof GazetteerSourceName]

/**
 * The location of each gazetteer source.
 *
 * Who's On First points to the `mailwoman` organization.
 * It holds the forks of the `whosonfirst-data-admin-<cc>` repositories the admin build clones.
 *
 * Each fork's upstream is the repository of the same name under `whosonfirst-data`.
 */
export const GAZETTEER_SOURCE_LOCATIONS: Readonly<Record<GazetteerSourceName, SourceLocation>> = {
	[GazetteerSourceName.WhosOnFirst]: { title: "Who's On First", url: "https://github.com/mailwoman" },
	[GazetteerSourceName.OvertureDivisions]: {
		title: "Overture Maps divisions theme",
		url: "https://docs.overturemaps.org/guides/divisions/",
	},
	[GazetteerSourceName.GeoNames]: { title: "GeoNames", url: "https://download.geonames.org/export/dump/" },
}

/**
 * The location of a source a manifest records, or null when the name has none here.
 */
export function gazetteerSourceLocation(name: string): SourceLocation | null {
	return Object.hasOwn(GAZETTEER_SOURCE_LOCATIONS, name)
		? GAZETTEER_SOURCE_LOCATIONS[name as GazetteerSourceName]
		: null
}
