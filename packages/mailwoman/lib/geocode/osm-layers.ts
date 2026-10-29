/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Opens the OpenStreetMap address-point layers an operator built under the data root, for the geocode
 *   session and the Nominatim and Photon servers alike, so every path that serves OpenStreetMap rows applies
 *   the same license refusal.
 */

import { type ArtifactManifest, BuildRecipeName, ServingRole } from "@mailwoman/core/layers"
import type { RegionDatabaseProvider } from "@mailwoman/core/resolver"
import { resolvePathBuilder, type PathBuilderLike } from "path-ts"

import { LayerCatalog } from "#data/catalog"
import { assertLayerObligationsAccepted, parseObligationRefusals } from "#data/obligations"
import { $public } from "#env"

/**
 * Whether an installed address-point artifact was built by the OpenStreetMap recipe.
 *
 * National registers, national Overture and OpenStreetMap builds all serve the
 * address-point role, and one selection entry may list several of them.
 * The session consults the national providers before the OpenStreetMap tier.
 *
 * Each provider therefore reads only its own sources from the entry, in the entry's order,
 * and the order between providers stays the session's.
 */
export function isOSMBuiltArtifact(manifest: ArtifactManifest): boolean {
	return manifest.recipe === BuildRecipeName.OSMAddressPoints
}

/**
 * Whether an installed address-point artifact is one a national provider reads:
 * any source but an OpenStreetMap build.
 */
export function isNationalAddressPointArtifact(manifest: ArtifactManifest): boolean {
	return !isOSMBuiltArtifact(manifest)
}

/**
 * Open the OpenStreetMap address-point layers under `dataRoot`, or return `null`
 * when `@mailwoman/osm`, an optional peer an operator installs to opt in, is not installed.
 *
 * A country the active selection lists an OpenStreetMap build for reads that build.
 * Every other country reads its conventional `db/osm/address-points-<cc>-<cc>.db`.
 *
 * A country with no built layer answers no rooftop, so a deployment without
 * one serves no OpenStreetMap data.
 * A row from a built layer copies its `openstreetmap:<cc>` source into the result's `coordinate_source`.
 *
 * When `MAILWOMAN_REFUSE_OBLIGATIONS` names a class of an extract's recorded license,
 * the provider throws while it opens, and the error repeats the extract's recorded provenance.
 * The refusal stops the caller rather than leaving the country to read as uncovered.
 *
 * @param catalog One reading of the active selection, read from `dataRoot` when omitted.
 * @throws When the package fails to load for a reason other than its absence,
 * when the selection or a selected extract cannot be read, or when the refusal applies.
 */
export async function openOSMRegionDatabases(
	dataRoot: PathBuilderLike,
	catalog?: LayerCatalog
): Promise<RegionDatabaseProvider | null> {
	const imported = await import("@mailwoman/osm/region-database-provider").catch((error: unknown) => {
		// Only an absent package means "no OSM layer".
		// Any other failure is a fault to report.
		if ((error as { code?: unknown } | null)?.code === "ERR_MODULE_NOT_FOUND") return null

		throw error
	})

	if (!imported) return null

	const { supportedOSMCountries } = await import("@mailwoman/osm/street-locale")
	const snapshot = catalog ?? (await LayerCatalog.read(dataRoot))
	const selected = new Map<string, string>()

	for (const cc of supportedOSMCountries()) {
		const path = await snapshot.firstPath(
			ServingRole.AddressPoints,
			{ country: cc.toUpperCase(), subdivision: null },
			isOSMBuiltArtifact
		)

		if (path) {
			selected.set(cc, path)
		}
	}

	const refuse = parseObligationRefusals([$public.MAILWOMAN_REFUSE_OBLIGATIONS ?? ""])

	return imported.OSMRegionDatabaseProvider.create(resolvePathBuilder(dataRoot), {
		selected,
		admit: refuse.length ? (manifest, path) => assertLayerObligationsAccepted(manifest, path, refuse) : undefined,
	})
}
