/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `layer_manifest` row of an OpenStreetMap address-point database.
 *
 *   The row records the license and credit the database carries, the Geofabrik URL and SHA-256 of the
 *   extract it was built from, the snapshot date, and the repository revision of the code that built it.
 *   Together those identify the database's inputs and the program that transformed them, which is what a
 *   recipient needs to find the data the database derives from.
 */

import { assertTierMatchesLicense, LayerFreshnessPolicy, LayerTier, type LayerManifest } from "@mailwoman/core/layers"

import { OSM_ADDRESS_H3_RESOLUTION } from "#address-point-schema"
import { OSM_ATTRIBUTION, OSM_LICENSE } from "#license"
import type { ExtractProvenance } from "#sdk/extract/receipt"

/**
 * The build facts {@link osmAddressPointLayerManifest} records.
 */
export interface OSMAddressPointBuild {
	/**
	 * ISO 3166-1 alpha-2 code, lowercase.
	 */
	country: string
	slug: string
	/**
	 * The build's release tag, recorded as the layer version.
	 */
	release: string
	createdAt: string
	/**
	 * The full git commit of the repository that ran the build.
	 */
	buildSHA: string
	buildCmd: string
	provenance: ExtractProvenance
}

/**
 * The manifest row of an OpenStreetMap address-point database.
 *
 * The source vintage is the snapshot date the receipt recorded, and the release tag
 * when the extract had no receipt.
 */
export function osmAddressPointLayerManifest(build: OSMAddressPointBuild): LayerManifest {
	const distribution = { tier: LayerTier.BuildLocal, license: OSM_LICENSE }

	assertTierMatchesLicense(distribution, "osm build")

	return {
		name: `osm-address-points-${build.country}-${build.slug}`,
		version: build.release,
		schemaVersion: 1,
		...distribution,
		attribution: OSM_ATTRIBUTION,
		source: `openstreetmap:${build.country}`,
		sourceVintage: build.provenance.snapshotDate ?? build.release,
		buildCmd: build.buildCmd,
		buildSHA: build.buildSHA,
		freshnessPolicy: LayerFreshnessPolicy.Sealed,
		spineKeys: { h3: { column: "h3_cell", resolution: OSM_ADDRESS_H3_RESOLUTION } },
		createdAt: build.createdAt,
		sourceRecords: null,
		sourceURL: build.provenance.sourceURL,
		sourceSHA256: build.provenance.sourceSHA256,
	}
}
