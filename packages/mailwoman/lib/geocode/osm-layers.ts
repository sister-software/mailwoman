/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Opens the OpenStreetMap address-point layers an operator built under the data root, for the geocode
 *   session and the Nominatim and Photon servers alike, so every path that serves OpenStreetMap rows applies
 *   the same license refusal.
 */

import type { RegionDatabaseProvider } from "@mailwoman/core/resolver"
import { resolvePathBuilder, type PathBuilderLike } from "path-ts"

import { assertLayerObligationsAccepted, parseObligationRefusals } from "#data/obligations"
import { $public } from "#env"

/**
 * Open the OpenStreetMap address-point layers under `dataRoot`, or return `null`
 * when `@mailwoman/osm`, an optional peer an operator installs to opt in, is not installed.
 *
 * A country with no built layer answers no rooftop, so a deployment without
 * one serves no OpenStreetMap data.
 * A row from a built layer carries its `openstreetmap:<cc>` source into the result's `coordinate_source`.
 *
 * When `MAILWOMAN_REFUSE_OBLIGATIONS` names a class an extract's recorded license carries,
 * the provider throws while it opens, and the error repeats the extract's recorded provenance.
 * The refusal stops the caller rather than leaving the country to read as uncovered.
 *
 * @throws When the package fails to load for a reason other than its absence, or when the refusal applies.
 */
export async function openOSMRegionDatabases(dataRoot: PathBuilderLike): Promise<RegionDatabaseProvider | null> {
	const imported = await import("@mailwoman/osm/region-database-provider").catch((error: unknown) => {
		// Only an absent package means "no OSM layer".
		// Any other failure is a fault to report.
		if ((error as { code?: unknown } | null)?.code === "ERR_MODULE_NOT_FOUND") return null

		throw error
	})

	if (!imported) return null

	const refuse = parseObligationRefusals([$public.MAILWOMAN_REFUSE_OBLIGATIONS ?? ""])

	return imported.OSMRegionDatabaseProvider.create(resolvePathBuilder(dataRoot), {
		admit: refuse.length ? (manifest, path) => assertLayerObligationsAccepted(manifest, path, refuse) : undefined,
	})
}
