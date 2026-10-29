/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Opens the national open-register (BAN) rooftop extracts under the data root for the geocode session.
 */

import type { BANRegionDatabaseProvider } from "@mailwoman/ban/region-database-provider"
import { ServingRole } from "@mailwoman/core/layers"
import { resolvePathBuilder, type PathBuilderLike } from "path-ts"

import { LayerCatalog } from "#data/catalog"

/**
 * Open the BAN extracts under `dataRoot`.
 *
 * A country with no built extract answers an empty bundle, and the session
 * moves on to the next national source.
 * `@mailwoman/ban` is a runtime dependency of this package, so a failure to load
 * it is a broken installation rather than an absent layer.
 *
 * The import stays dynamic so a parse-only command does not load the provider.
 *
 * @throws When the package fails to load, or when the provider cannot read the extract directory.
 */
export async function openBANRegionDatabases(
	dataRoot: PathBuilderLike,
	catalog?: LayerCatalog
): Promise<BANRegionDatabaseProvider> {
	const { BANRegionDatabaseProvider } = await import("@mailwoman/ban/region-database-provider")
	const { supportedBANCountries } = await import("@mailwoman/ban/street-locale")
	const snapshot = catalog ?? (await LayerCatalog.read(dataRoot))
	const addressPoints = new Map<string, string>()
	const streetCentroids = new Map<string, string>()

	// A country the active selection lists reads the selected file.
	// Every other country reads its conventional path.
	for (const cc of supportedBANCountries()) {
		const scope = { country: cc.toUpperCase(), subdivision: null }
		const points = await snapshot.firstPath(ServingRole.AddressPoints, scope)
		const streets = await snapshot.firstPath(ServingRole.StreetCentroids, scope)

		if (points) {
			addressPoints.set(cc, points)
		}

		if (streets) {
			streetCentroids.set(cc, streets)
		}
	}

	return BANRegionDatabaseProvider.create(resolvePathBuilder(dataRoot), { addressPoints, streetCentroids })
}
