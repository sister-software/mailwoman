// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The sources the US address layer build records in its `layer_manifest.source`,
 *   and where a user obtains each one.
 *
 *   The build writes these names, joined with `+`, and a reader looks each one up here,
 *   so a name the build writes always has its location.
 */

import type { SourceLocation } from "@mailwoman/core/resolver"

import { OPENADDRESSES_SOURCE_LOCATIONS, OPENADDRESSES_SOURCE_NAME } from "#adapters/openaddresses/source"
import { OVERTURE_ADDRESSES_SOURCE_LOCATIONS, OVERTURE_ADDRESSES_SOURCE_NAME } from "#adapters/overture/source"
import { NAD_SOURCE_LOCATIONS, NAD_SOURCE_NAME } from "#us/adapters/usgov/nad/source"

/**
 * The `source` each US address layer's manifest records.
 */
export const US_ADDRESS_LAYER_SOURCE = [
	NAD_SOURCE_NAME,
	OVERTURE_ADDRESSES_SOURCE_NAME,
	OPENADDRESSES_SOURCE_NAME,
].join("+")

/**
 * Where a user obtains each source a US address layer records.
 */
export const US_ADDRESS_LAYER_SOURCE_LOCATIONS: Readonly<Record<string, SourceLocation>> = {
	...NAD_SOURCE_LOCATIONS,
	...OVERTURE_ADDRESSES_SOURCE_LOCATIONS,
	...OPENADDRESSES_SOURCE_LOCATIONS,
}
