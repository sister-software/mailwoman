/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   This module defines the structure-source register's types. A structure source is a published dataset of building
 *   footprints, 3D building models, landmark meshes or tree heights that a basemap or a 3D layer draws.
 *
 *   License decisions use the shape `@mailwoman/core/license/decision` defines for every register of third-party
 *   data, with {@link StructureOperation} as the operation list.
 */

import type { LicenseDecision } from "@mailwoman/core/license/decision"

/**
 * The acts this repository performs on a structure source, in pipeline order.
 *
 * A grant can permit some and stay silent on others, so a license decision
 * records a permission per operation.
 */
export const StructureOperation = {
	/**
	 * Bulk copy of the published files into the build host or `$MAILWOMAN_DATA_ROOT`.
	 */
	Fetch: "fetch",
	/**
	 * A change of format, coordinate system, axis order or vertical datum that keeps every vertex.
	 */
	Convert: "convert",
	/**
	 * A change to the geometry itself: simplification, decimation, corner rounding,
	 * merging footprints or deriving points from a raster.
	 * Share-alike licenses treat this as making adapted material.
	 */
	Adapt: "adapt",
	/**
	 * Publication of the converted or adapted geometry, such as a PMTiles archive,
	 * a glTF model or a 3D Tiles set, where any viewer's browser can download it.
	 */
	Redistribute: "redistribute",
	/**
	 * Commercial sublicensing of the result.
	 */
	CommercialSublicense: "commercial-sublicense",
} as const

/**
 * One of the {@link StructureOperation} values.
 */
export type StructureOperation = (typeof StructureOperation)[keyof typeof StructureOperation]

/**
 * The operations a published map layer performs on a source: every one of them,
 * because a browser downloads the adapted geometry.
 */
export const PUBLISH_OPERATIONS: readonly StructureOperation[] = Object.values(StructureOperation)

/**
 * What a source's geometry represents, from least to most detailed.
 *
 * Level-of-detail names follow CityGML, but a publisher's own variant can differ from the
 * standard, so a source's `note` records what its LoD label means for that publisher.
 */
export const StructureDetail = {
	/**
	 * A footprint polygon with an optional height, drawn as a prism.
	 */
	Footprint: "footprint",
	/**
	 * A footprint with roof-shape attributes, from which a renderer builds a roof.
	 */
	RoofAttributes: "roof-attributes",
	LoD1: "lod1",
	LoD2: "lod2",
	LoD3: "lod3",
	/**
	 * A photogrammetric surface mesh.
	 * One surface can merge buildings, terrain and vegetation.
	 */
	Mesh: "mesh",
	/**
	 * An individually modeled structure, such as one landmark.
	 */
	Model: "model",
	/**
	 * A raster of heights, such as a canopy height model, from which points or volumes are derived.
	 */
	HeightRaster: "height-raster",
	/**
	 * Land-cover polygons, such as forest, grass and farmland, drawn under the buildings.
	 */
	LandCover: "land-cover",
	/**
	 * Small-scale cartographic data, such as coastlines and boundaries for low zooms.
	 */
	Cartographic: "cartographic",
} as const

/**
 * One of the {@link StructureDetail} values.
 */
export type StructureDetail = (typeof StructureDetail)[keyof typeof StructureDetail]

/**
 * The jurisdiction value for a source that spans countries, such as OpenStreetMap or Overture Maps.
 */
export const INTERNATIONAL = "international"

/**
 * One structure source: one publisher's dataset in one jurisdiction.
 */
export interface StructureSource {
	/**
	 * The id `<jurisdiction>-<slug>`, which stays stable across rebuilds.
	 */
	sourceID: string
	/**
	 * The lowercase ISO 3166-1 alpha-2 code of the country whose law governs the
	 * publisher, or {@link INTERNATIONAL}.
	 */
	jurisdiction: string
	/**
	 * The ISO 3166-2 code of the subdivision that publishes the dataset, such as `DE-HH` for
	 * Hamburg, when the publisher is a state or city government rather than a national one.
	 */
	region?: string
	/**
	 * The municipality the dataset covers, when it covers one city inside {@link StructureSource.region}.
	 */
	municipality?: string
	name: string
	publisher: string
	/**
	 * The publisher's own page for the dataset.
	 */
	datasetURL: string
	detail: readonly StructureDetail[]
	/**
	 * The formats the publisher distributes, as the publisher names them.
	 */
	formats: readonly string[]
	/**
	 * The `licenseID` of a decision in the register's `licenses` table.
	 */
	license: string
	/**
	 * The attribution text the elected terms require, verbatim, once a reviewer has read the terms.
	 */
	attribution?: string
	/**
	 * The page a map credit links to, so a reader can find the terms the credit discharges.
	 */
	attributionURL?: string
	note?: string
}

/**
 * The committed structure-source register.
 */
export interface StructureSourceRegister {
	sources: readonly StructureSource[]
	licenses: readonly LicenseDecision<StructureOperation>[]
}
