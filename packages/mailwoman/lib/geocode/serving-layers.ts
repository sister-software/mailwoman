// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The rooftop providers the Nominatim and Photon servers attach, read from
 *   one generation of the active selection.
 *
 *   Both servers consult the national open register (BAN) and then the OpenStreetMap tier,
 *   and neither attaches national Overture.
 *   That order is the order they had before the selection existed.
 */

import type { BANRegionDatabaseProvider } from "@mailwoman/ban/region-database-provider"
import type { OSMRegionDatabaseProvider } from "@mailwoman/osm/region-database-provider"
import type { PathBuilderLike } from "path-ts"

import { LayerCatalog } from "#data/catalog"
import { openBANRegionDatabases } from "#geocode/ban-layers"
import { openOSMRegionDatabases } from "#geocode/osm-layers"

/**
 * The rooftop providers a server attaches, and the selection generation they read.
 */
export interface ServingRooftopProviders extends Disposable {
	/**
	 * The generation the providers read, or `null` when the data root has no selection.
	 */
	generation: number | null
	national: BANRegionDatabaseProvider
	/**
	 * `null` when `@mailwoman/osm` isn't installed.
	 */
	osm: OSMRegionDatabaseProvider | null
}

/**
 * One startup line for each layer the providers found on disk and didn't attach,
 * naming the file and the reason.
 *
 * An empty array means every layer on disk was attached.
 */
export function unattachedLayerLines(providers: Pick<ServingRooftopProviders, "osm">): string[] {
	return (providers.osm?.unreadExtracts ?? []).map(({ path, reason }) => `  refused: ${path}, because ${reason}`)
}

/**
 * Open the national and OpenStreetMap rooftop providers under `dataRoot` from one reading of the selection.
 *
 * @throws When the selection or a selected file cannot be read, or an obligation refusal applies.
 */
export async function openServingRooftopProviders(dataRoot: PathBuilderLike): Promise<ServingRooftopProviders> {
	const catalog = await LayerCatalog.read(dataRoot)
	const national = await openBANRegionDatabases(dataRoot, catalog)
	let osm: OSMRegionDatabaseProvider | null

	try {
		osm = await openOSMRegionDatabases(dataRoot, catalog)
	} catch (error) {
		national[Symbol.dispose]()

		throw error
	}

	return {
		generation: catalog.generation,
		national,
		osm,
		[Symbol.dispose]: () => {
			national[Symbol.dispose]()
			osm?.[Symbol.dispose]()
		},
	}
}
