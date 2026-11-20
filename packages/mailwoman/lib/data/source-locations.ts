// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Where a user obtains each source a layer manifest may record, gathered from
 *   the packages that own the sources.
 *
 *   Each owner keeps its own table beside the build that writes the name.
 *   This module only joins them, so `mailwoman data inventory` and the OGC
 *   adapter locate a source the same way.
 */

import { BAN_SOURCE_LOCATIONS } from "@mailwoman/ban/source"
import type { SourceLocator } from "@mailwoman/core/layers/provenance"
import type { SourceLocation } from "@mailwoman/core/resolver"
import { GNAF_SOURCE_LOCATIONS } from "@mailwoman/corpus/au/adapters/gnaf/source"
import { US_ADDRESS_LAYER_SOURCE_LOCATIONS } from "@mailwoman/corpus/us/address-records/sources"
import { GAZETTEER_SOURCE_LOCATIONS } from "@mailwoman/resolver-wof-sqlite/sources"

/**
 * The joined source tables, and the owners whose table couldn't be loaded.
 */
export interface SourceLocations {
	/**
	 * Every known source's location, keyed by the name a manifest's `source` gives it.
	 */
	table: Readonly<Record<string, SourceLocation>>
	locate: SourceLocator
	/**
	 * Packages whose table is absent from this installation, such as the optional `@mailwoman/osm`.
	 *
	 * A source those packages own reads as unlocated, and a report states the package.
	 */
	unavailable: string[]
}

/**
 * Join every owner's source table.
 *
 * `@mailwoman/osm` is an optional peer, so its table is imported when installed
 * and its absence is reported in `unavailable`.
 *
 * @throws When `@mailwoman/osm` is installed and its table fails to load.
 */
export async function readSourceLocations(): Promise<SourceLocations> {
	const unavailable: string[] = []

	const osm = await import("@mailwoman/osm/source").catch((error: unknown) => {
		// Only an absent package means "no OSM table".
		// Any other failure is a fault to report.
		if ((error as { code?: unknown } | null)?.code === "ERR_MODULE_NOT_FOUND") return null

		throw error
	})

	if (!osm) {
		unavailable.push("@mailwoman/osm")
	}

	const table: Record<string, SourceLocation> = {
		...GAZETTEER_SOURCE_LOCATIONS,
		...BAN_SOURCE_LOCATIONS,
		...US_ADDRESS_LAYER_SOURCE_LOCATIONS,
		...GNAF_SOURCE_LOCATIONS,
		...osm?.OSM_SOURCE_LOCATIONS,
	}

	return {
		table,
		locate: (name) => (Object.hasOwn(table, name) ? table[name]! : null),
		unavailable,
	}
}
