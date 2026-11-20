// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Where a user obtains an OpenStreetMap address layer.
 *
 *   The project publishes the builder and never a built database, so the location
 *   is the build documentation in this package's README.
 *   A user builds the layer from a Geofabrik extract on their own machine.
 */

import type { SourceLocation } from "@mailwoman/core/resolver"

/**
 * The name the OpenStreetMap builds record in a manifest's `source`, before the `:<country>` scope.
 */
export const OSM_SOURCE_NAME = "openstreetmap"

/**
 * Where a user obtains each source an OpenStreetMap layer records.
 */
export const OSM_SOURCE_LOCATIONS: Readonly<Record<string, SourceLocation>> = {
	[OSM_SOURCE_NAME]: {
		title: "OpenStreetMap, built locally with @mailwoman/osm",
		url: "https://github.com/sister-software/mailwoman/tree/main/packages/osm#build-a-per-country-database",
	},
}
