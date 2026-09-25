/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * Every soil layer name starts with this prefix, and the reader refuses an
 * artifact whose layer name lacks it.
 */
export const SOIL_LAYER_NAME_PREFIX = "soil-capability-nrcs-ssurgo-"

/**
 * The layer name for a build over `region`.
 */
export function soilLayerName(region: string): string {
	return `${SOIL_LAYER_NAME_PREFIX}${region.toLowerCase()}`
}

/**
 * The pilot region — Iowa, whole, built survey area by survey area.
 */
export const SOIL_PILOT_REGION = "ia"

/**
 * Holds the agency acknowledgement that the SSURGO use constraints require,
 * written into `layer_manifest.attribution`.
 */
export const SSURGO_ATTRIBUTION = "U.S. Department of Agriculture, Natural Resources Conservation Service"

/**
 * Holds the public-domain licence expression written into `layer_manifest.license`.
 *
 * The grant rests on {@link SSURGO_PUBLIC_INFORMATION_SENTENCE} in each archive's
 * FGDC metadata, not on the data.gov entry.
 */
export const SSURGO_LICENSE = "LicenseRef-USGov-Public-Domain"

/**
 * Holds the public-information grant quoted from each survey area's FGDC use constraints.
 *
 * The survey-area loader refuses an area whose metadata lacks it, because that absence is a licence change.
 */
export const SSURGO_PUBLIC_INFORMATION_SENTENCE = "This is public information"

/**
 * Holds the full SSURGO use constraints, quoted from the FGDC metadata.
 */
export const SSURGO_USE_CONSTRAINTS =
	"The U.S. Department of Agriculture, Natural Resources Conservation Service, should be acknowledged as the data " +
	"source in products derived from these data. This data set is not designed for use as a primary regulatory tool " +
	"in permitting or citing decisions, but may be used as a reference source. This is public information and may be " +
	"interpreted by organizations, agencies, units of government, or others based on needs; however, they are " +
	"responsible for the appropriate application."

/**
 * Lists the limitations NRCS states for SSURGO, quoted verbatim, which every soil reading carries.
 *
 * They are why a reading describes the map unit covering a point and never
 * makes a site-specific determination.
 */
export const SSURGO_PRODUCT_LIMITS: ReadonlyArray<string> = [
	"The depicted soil boundaries, interpretations, and analysis derived from them do not eliminate the need for onsite sampling, testing, and detailed study of specific sites for intensive uses. Thus, these data and their interpretations are intended for planning purposes only.",
	"Photographic or digital enlargement of these maps to scales greater than at which they were originally mapped can cause misinterpretation of the data. If enlarged, maps do not show the small areas of contrasting soils that could have been shown at a larger scale.",
	"This data set is not designed for use as a primary regulatory tool in permitting or citing decisions, but may be used as a reference source.",
	"Digital data files are periodically updated. Files are dated, and users are responsible for obtaining the latest version of the data.",
	"The difference in positional accuracy between the soil boundaries and special soil features locations in the field and their digitized map locations is unknown.",
]

/**
 * States that soil mapping is complete at survey scale inside a published
 * survey area and absent outside one.
 */
export const SSURGO_COVERAGE_STATEMENT =
	"Soil surveys are published by survey area. Inside a published survey area the soil mapping is complete at the " +
	"survey's own scale; land outside any published survey area has no soil map unit at all."

/**
 * Where the product's identity and cadence are published.
 */
export const SSURGO_STATEMENT_URL =
	"https://www.nrcs.usda.gov/conservation-basics/natural-resource-concerns/soil/annual-soils-refresh"

/**
 * The dataset identifier written into `layer_manifest.source`.
 */
export const SSURGO_SOURCE = "nrcs.usda.gov/SSURGO"

/**
 * Gives the EPSG code every SSURGO survey-area shapefile declares, which the ingest requires by default.
 */
export const SSURGO_SOURCE_EPSG = 4326

/**
 * Enumerates the authorities that can set a farmland classification's criteria.
 *
 * `None` covers land that is not prime farmland and land with no classification.
 */
export const FarmlandScope = {
	Federal: "federal",

	State: "state",

	Local: "local",

	None: "none",
} as const

/**
 * Represents one {@link FarmlandScope} value, as stored in the `farmland_scope` column.
 */
export type FarmlandScope = (typeof FarmlandScope)[keyof typeof FarmlandScope]

/**
 * Classifies a `farmlndcl` value into a {@link FarmlandScope} by the phrase the regulation uses.
 *
 * It matches phrases rather than listing values, so a new conditional value such as
 * `Farmland of statewide importance, if …` still lands in the right scope.
 */
export function farmlandScope(value: string | null | undefined): FarmlandScope {
	if (!value) return FarmlandScope.None

	const lowered = value.toLowerCase()

	if (lowered.startsWith("not prime farmland")) return FarmlandScope.None

	if (lowered.includes("statewide importance")) return FarmlandScope.State

	if (lowered.includes("local importance")) return FarmlandScope.Local

	if (lowered.includes("prime farmland") || lowered.includes("unique importance")) return FarmlandScope.Federal

	return FarmlandScope.None
}

/**
 * Lists the upper-case map-unit symbols NRCS gives a delineation that it has drawn
 * but has no soil mapping for.
 */
export const SSURGO_NO_MAPPING_SYMBOLS: ReadonlySet<string> = new Set(["NOTCOM", "NOTPUB"])

/**
 * Lists the lower-case map-unit names that mark a delineation with no soil mapping when its symbol does not.
 *
 * The match is on the whole name, because a prefix could also match a real soil name.
 */
export const SSURGO_NO_MAPPING_NAMES: ReadonlySet<string> = new Set([
	"area not surveyed, access denied",
	"not public information",
	"no digital data available",
])

/**
 * Names the `cointerp.mrulename` of the productivity index this layer carries.
 *
 * The index stays separate from the capability class, because combining them
 * would produce a number NRCS does not publish.
 */
export const NCCPI_V3_RULE_NAME = "NCCPI - National Commodity Crop Productivity Index (Ver 3.0)"

/**
 * Gives the `cointerp.ruledepth` at which a rule reports its overall value rather than a crop submodel.
 */
export const COINTERP_OVERALL_RULE_DEPTH = "0"

/**
 * Identifies the area-times-component-percentage weighting that produced the per-cell shares.
 *
 * A share therefore says how much of a cell lies in map units with a rating,
 * not where in the cell the rating applies.
 */
export const SOIL_SHARE_WEIGHTING = "cell_area_x_comppct_r"

/**
 * Explains {@link SOIL_SHARE_WEIGHTING} in prose, stored beside it in the artifact.
 */
export const SOIL_SHARE_WEIGHTING_DESCRIPTION =
	"Each map-unit delineation contributes the area of the cell it covers; that area is split across the delineation's " +
	"components in proportion to comppct_r, the component's representative percentage of its map unit. Component " +
	"percentages are a proportion without a location, so a share states how much of the cell's area lies in map units " +
	"whose components carry a rating — not where within the cell that rating applies."
