// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The older per-state street files of the United States, as sources of the region provider.
 *
 *   `address-points-us-<state>.db` and `interpolation-us-<state>.db` predate the address layer
 *   and have no manifest, so their names are a fact of this one country and are spelled here.
 *   A state's file is found through the active selection, then the release manifest's
 *   pinned version, then the unversioned name, as `resolveDatabasePath` resolves it.
 *
 *   The address layer replaces the address-point files for each state its manifest lists.
 *   Interpolation has no successor, so these files serve it for every state.
 */

import { US_STATE_BY_ABBREVIATION } from "@mailwoman/codex/us"
import type { AddressPointLookup, InterpolationLookup } from "@mailwoman/core/resolver"
import { streetLocaleForCountry } from "@mailwoman/resolver-wof-sqlite/labels/street/locale"
import { resolvePath, type PathBuilderLike } from "path-ts"

import { LayerCatalog } from "#data/catalog"
import { type DatabaseFamily, readReleaseManifest, resolveDatabasePath } from "#data/catalog/release"
import type { RegionDatabaseFactory, RegionFile, RegionFileSource } from "#geocode/layers/regions"

/**
 * The path of each state's and territory's file of one family, keyed by ISO 3166-2 code.
 * A state with no file on disk has no entry.
 */
async function statePaths(
	dataRoot: string,
	family: DatabaseFamily,
	catalog: LayerCatalog
): Promise<Map<string, string>> {
	const manifest = await readReleaseManifest(dataRoot)
	const paths = new Map<string, string>()

	for (const abbreviation of Object.keys(US_STATE_BY_ABBREVIATION)) {
		const path = await resolveDatabasePath(dataRoot, family, abbreviation.toLowerCase(), manifest, catalog)

		if (path) {
			paths.set(`US-${abbreviation}`, path)
		}
	}

	return paths
}

/**
 * The two sources of the older per-state files: address points, then interpolation.
 *
 * Each answers one file for every state and territory that has one on disk,
 * keyed by its ISO 3166-2 code, and zero entries on a data root that has none.
 *
 * @param catalog One reading of the active selection, so every path comes from one generation.
 * Read from `dataRoot` when omitted.
 * @throws From `locate`, when the selection or a selected artifact exists and can't be read.
 */
export function usStateFileSources(
	factory: Pick<RegionDatabaseFactory, "AddressPointSqliteLookup" | "StreetInterpolator">,
	dataRoot: PathBuilderLike,
	catalog?: LayerCatalog
): RegionFileSource[] {
	const root = resolvePath(dataRoot)
	// Without a snapshot each `locate` reads the selection as it stands, so a warmed provider sees a new one.
	const readCatalog = async (): Promise<LayerCatalog> => catalog ?? LayerCatalog.read(root)

	return [
		{
			tier: "addressPoints",
			async locate() {
				const files = new Map<string, RegionFile<AddressPointLookup>>()

				for (const [subdivision, path] of await statePaths(root, "address-points", await readCatalog())) {
					files.set(subdivision, {
						path,
						open: () => new factory.AddressPointSqliteLookup(path, { streetLocale: streetLocaleForCountry("US") }),
					})
				}

				return files
			},
		},
		{
			tier: "interpolation",
			async locate() {
				const files = new Map<string, RegionFile<InterpolationLookup>>()

				for (const [subdivision, path] of await statePaths(root, "interpolation", await readCatalog())) {
					files.set(subdivision, { path, open: () => new factory.StreetInterpolator({ dbPath: path }) })
				}

				return files
			},
		},
	]
}
