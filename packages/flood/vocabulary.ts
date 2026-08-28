/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Environment Agency's own words, as data: the product identity, the zone domain it publishes, the
 *   coverage sentence that licenses a `designated` basis, and the attribution string OGL v3.0 requires.
 *
 *   THE ZONE DOMAIN IS CLOSED AND THE BUILDER THROWS ON A VALUE OUTSIDE IT. An unknown code is a
 *   source-schema change, which is the event a reader most needs to hear about; coercing it to a nearest
 *   neighbour or to null converts "the source changed" into "there is nothing here".
 *
 *   THE STORED CODES ARE `FZ2` AND `FZ3`, NOT "Flood Zone 2"/"Flood Zone 3". The published metadata
 *   describes the column as "Assigned Flood Zone (Flood Zone 2 or 3)"; the shipped geodatabase declares
 *   `flood_zone` as a 3-character string and fills it with `FZ2` / `FZ3`. Measured over the whole file:
 *   540,282 `FZ2` and 273,345 `FZ3`, 813,627 together. A builder written against the metadata prose finds
 *   nothing.
 *
 *   ZONE 1 IS NOT IN THIS TABLE, BECAUSE IT IS NOT IN THE DATA. The Planning Practice Guidance defines it
 *   as "all land outside Zones 2, 3a and 3b" — an absence, not a polygon. It reaches a reader through
 *   `layer_coverage` instead: inside England a cell the authority designated and no polygon covering the
 *   point IS the Zone 1 designation. {@linkcode FLOOD_ZONE_1} carries its definition for that reading.
 *
 *   3a AND 3b ARE NOT DISTINGUISHED, and the EA says so: it is "not required to map the outer boundary of
 *   the extent of Flood Zone 3b, and it is usually included within our mapped extent of Flood Zone 3". A
 *   consumer that split them would be inventing a boundary the authority declines to draw.
 */

/**
 * One zone code the authority publishes, with the definition it publishes and where that definition is stated.
 */
export interface FloodZoneDefinition {
	/**
	 * The code as it appears in the source file — never re-spelled, never normalized.
	 */
	code: string
	/**
	 * The authority's own name for the zone.
	 */
	label: string
	/**
	 * The definition, verbatim, in the words of the document `definitionURL` names.
	 */
	definition: string
	definitionURL: string
}

/**
 * The zone codes the shipped `Flood_Zones_2_3_Rivers_and_Sea` layer carries — the closed set the builder validates
 * against. Definitions are the Planning Practice Guidance's, because the PPG is what defines the zones and the EA's
 * product description says so.
 */
export const EA_FLOOD_ZONE_DEFINITIONS: ReadonlyArray<FloodZoneDefinition> = [
	{
		code: "FZ2",
		label: "Flood Zone 2 — Medium Probability",
		definition:
			"Land having between a 1% and 0.1% annual probability of river flooding; or land having between a 0.5% and 0.1% annual probability of sea flooding.",
		definitionURL: "https://www.gov.uk/guidance/flood-risk-and-coastal-change",
	},
	{
		code: "FZ3",
		label: "Flood Zone 3 — High Probability",
		definition:
			"Land having a 1% or greater annual probability of river flooding; or Land having a 0.5% or greater annual probability of sea.",
		definitionURL: "https://www.gov.uk/guidance/flood-risk-and-coastal-change",
	},
]

/**
 * The declared domain as a membership set. A `flood_zone` value outside this is a source-schema change.
 */
export const EA_FLOOD_ZONE_CODES: ReadonlySet<string> = new Set(EA_FLOOD_ZONE_DEFINITIONS.map((zone) => zone.code))

/**
 * Zone 1, which the product represents by ABSENCE. Not a row in `flood_zone_vocabulary`, because the authority ships no
 * Zone 1 polygon; carried here so a reader rendering a designated-absence answer can quote the definition it rests on.
 */
export const FLOOD_ZONE_1: FloodZoneDefinition = {
	code: "FZ1",
	label: "Flood Zone 1 — Low Probability",
	definition:
		"Land having a less than 0.1% annual probability of river or sea flooding. (Shown as 'clear' on the Flood Map for Planning – all land outside Zones 2, 3a and 3b)",
	definitionURL: "https://www.gov.uk/guidance/flood-risk-and-coastal-change",
}

/**
 * The layer name written into `layer_manifest.name`, and the only name the reader accepts.
 */
export const EA_FLOOD_LAYER_NAME = "flood-zones-ea-england"

/**
 * The dataset identifier on `environment.data.gov.uk`, written into `layer_manifest.source`.
 */
export const EA_FLOOD_DATASET_ID = "04532375-a198-476e-985e-0579a0a11b47"

/**
 * The layer inside the published geodatabase.
 */
export const EA_FLOOD_LAYER = "Flood_Zones_2_3_Rivers_and_Sea"

/**
 * The attribution string the ISO metadata specifies. OGL v3.0 requires a re-user to "acknowledge the source of the
 * Information in your product or application by including or linking to any attribution statement specified by the
 * Information Provider(s)", so this string is not decoration — it is the licence condition, and it rides in
 * `layer_manifest.attribution`.
 */
export const EA_FLOOD_ATTRIBUTION = "© Environment Agency copyright and/or database right 2025. All rights reserved."

/**
 * The licence expression written into `layer_manifest.license`.
 */
export const EA_FLOOD_LICENSE = "OGL-UK-3.0"

/**
 * The licence text OGL v3.0 asks a re-user to link to.
 */
export const EA_FLOOD_LICENSE_URL = "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/"

/**
 * The authority's coverage statement — the sentence that makes `CoverageBasis.Designated` reachable at all, and the
 * only thing `flood_map_extent` is derived from.
 *
 * The union of hazard polygons is NOT the mapped area: Zone 1 is the mapped area minus the polygons, so a footprint
 * derived from the polygons would report every Zone 1 location as unmapped — the exact inversion this layer exists to
 * avoid.
 */
export const EA_COVERAGE_STATEMENT =
	"The mapping of Flood Zone datasets covers all of England, down to catchments with an area of 3km2. " +
	"Where we have suitable data for smaller catchments, we will also show this."

/**
 * Where {@linkcode EA_COVERAGE_STATEMENT} is published.
 */
export const EA_COVERAGE_STATEMENT_URL = `https://environment.data.gov.uk/dataset/${EA_FLOOD_DATASET_ID}`

/**
 * What the product does NOT cover, in the authority's own words. Carried into the observation so a caller can see what
 * an answer is silent about: a Zone 1 reading says nothing about surface water, groundwater, sewer failure, or the
 * residual risk behind a defence.
 */
export const EA_PRODUCT_LIMITS: ReadonlyArray<string> = [
	"Flood Zones are a planning tool and they do not necessarily mean somewhere will or will not flood.",
	"The Flood Zone datasets are designed to only give an indication of flood risk from rivers and the sea to an area of land and are not suitable for showing whether an individual property is at risk of flooding.",
	"They do not take account of the presence and effect of flood defences, unless they increase the area potentially at risk of flooding.",
	"Locations may also be at risk from other sources of flooding, such as high groundwater levels, or failure of infrastructure such as sewers and storm drains. These sources are not represented in these datasets.",
	"The Flood Zones shown on the Environment Agency's Flood Map for Planning (Rivers and Sea) do not take account of the possible impacts of climate change.",
]

/**
 * The bounding box the OGC API Features collection declares for the published layer, in CRS84 order `[minLon, minLat,
 * maxLon, maxLat]`.
 *
 * The ingest asserts the reprojected data lands inside this, which is the check that catches a coordinate-order or
 * projection mistake before 813,627 polygons are written to the wrong side of the planet. Read 2026-08-28 from
 * `https://environment.data.gov.uk/spatialdata/flood-map-for-planning-flood-zones/ogc/features/v1/collections`.
 */
export const EA_DECLARED_BBOX: readonly [number, number, number, number] = [
	-6.9869611877272115, 49.881520456225346, 2.0738245399754374, 55.81077481587207,
]

/**
 * The projected CRS the published geodatabase declares. The file is NOT in WGS84 — it is OSGB36 / British National
 * Grid, in metres — so the ingest reprojects and the builder refuses a source that declares anything else.
 */
export const EA_SOURCE_EPSG = 27_700
