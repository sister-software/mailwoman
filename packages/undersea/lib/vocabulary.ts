/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The GEBCO undersea gazetteer as this layer reads it: the publisher's service, its three geometry
 *   layers, the citation the publisher asks for, and how a feature's display name is formed.
 *
 *   The IHO-IOC GEBCO Gazetteer of Undersea Feature Names is published by NOAA NCEI, a United States
 *   federal body, as a public ArcGIS item owned by `ncei_noaa`. Names and positions are facts.
 *   GEBCO asks only for a citation, and its disclaimer excludes use for navigation or safety at sea.
 *   Issue #2896 records that reading.
 */

/**
 * The layer's name in its `layer_manifest`.
 */
export const UNDERSEA_LAYER_NAME = "undersea-gebco"

/**
 * The layer's schema version.
 *
 * A change to a table or to the browser asset's shape raises it.
 */
export const UNDERSEA_SCHEMA_VERSION = 1

/**
 * The license expression the manifest records: a work of the United States Government.
 */
export const UNDERSEA_LICENSE = "LicenseRef-USGov-Public-Domain"

/**
 * The citation GEBCO asks for, recorded in the manifest and shown in the Earth credits.
 */
export const UNDERSEA_ATTRIBUTION = "IHO-IOC GEBCO Gazetteer of Undersea Feature Names, www.gebco.net"

/**
 * The scope GEBCO's disclaimer excludes, in its own words.
 */
export const UNDERSEA_USE_LIMIT =
	"Not for navigation or for any purpose relating to safety at sea (https://www.gebco.net/disclaimer)."

/**
 * The NOAA NCEI feature service that holds the gazetteer.
 */
export const UNDERSEA_SERVICE_URL =
	"https://services2.arcgis.com/C8EMgrsFcRFL6LrL/arcgis/rest/services/Undersea_Features/FeatureServer"

/**
 * The most records one query returns, from the service's `maxRecordCount`.
 *
 * A full pull pages in steps of this size.
 */
export const UNDERSEA_SERVICE_PAGE_SIZE = 2000

/**
 * The geometry of a gazetteer record, one kind per service layer.
 */
export const UnderseaGeometryKind = {
	Point: "point",
	Line: "line",
	Polygon: "polygon",
} as const

export type UnderseaGeometryKind = (typeof UnderseaGeometryKind)[keyof typeof UnderseaGeometryKind]

/**
 * The service layer index of each geometry kind.
 */
export const UNDERSEA_SERVICE_LAYERS: ReadonlyArray<{ id: number; kind: UnderseaGeometryKind }> = [
	{ id: 0, kind: UnderseaGeometryKind.Point },
	{ id: 1, kind: UnderseaGeometryKind.Line },
	{ id: 2, kind: UnderseaGeometryKind.Polygon },
]

/**
 * The name a reader sees: the specific name followed by the generic term.
 *
 * The gazetteer stores the two apart, as `NAME` "Challenger" and `TYPE` "Deep",
 * and the feature is known as Challenger Deep.
 * A name that already ends with its generic term is kept as it is.
 */
export function underseaDisplayName(name: string, genericTerm: string): string {
	const specific = name.trim()
	const generic = genericTerm.trim()

	if (!generic) return specific

	if (specific.toLowerCase().endsWith(` ${generic.toLowerCase()}`)) return specific

	return `${specific} ${generic}`
}
