/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   NRCS's own words, as data: the product identity, the licence sentence it ships inside every archive,
 *   the acknowledgement it asks for, and the caveats that decide what a reading may claim.
 *
 *   THE RATING VOCABULARY IS NOT HERE, BECAUSE THE AUTHORITY SHIPS IT. `msdomdet.txt` inside each survey
 *   area's tabular export carries the declared domain for every `Choice` column, WITH the authority's own
 *   prose definition of each member — capability classes 1 through 8, subclasses `c`/`e`/`s`/`w`, the 28
 *   farmland classifications, the six component kinds. So the layer reads the domain out of the file it
 *   ingested rather than transcribing it from the National Soil Survey Handbook, and an out-of-domain value
 *   throws: an unknown code is a source-schema change, which is the event a reader most needs to hear
 *   about, and coercing it to a nearest neighbour or to NULL converts "the source changed" into "there is
 *   nothing here".
 *
 *   THE FARMLAND VOCABULARY IS CONDITIONAL AND THE CONDITION IS THE CLAIM. 28 declared values, of which 24
 *   carry an "if" — `Prime farmland if drained`, `Prime farmland if irrigated and reclaimed of excess salts
 *   and sodium`. A boolean `arable` column would be this layer's invention rather than the authority's
 *   statement, so the string is stored whole.
 *
 *   AND TWO OF ITS CATEGORIES TRAVEL WHILE THE OTHERS DO NOT. 7 CFR 657.5 defines prime farmland and unique
 *   farmland nationally against nine specific criteria; §657.5(c) and (d) hand "additional farmland of
 *   statewide importance" and "of local importance" to state and local agencies respectively. So
 *   `Farmland of statewide importance` in Iowa and in Georgia are not the same claim, and a consumer that
 *   pooled them into one rank would be pooling incompatible vocabularies. {@link FARMLAND_SCOPE} carries
 *   that distinction into the artifact rather than leaving it in a document.
 */

/**
 * The layer-name prefix. The suffix names the REGION the build covers, because the manifest's declared extent and the
 * coverage rows describe the same set and that set is a list of published survey areas rather than "the United
 * States".
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
 * The acknowledgement string the shipped FGDC metadata asks for, verbatim as the metadata gives the agency name. This
 * is not decoration: the use constraints say the agency "should be acknowledged as the data source in products derived
 * from these data", so it rides in `layer_manifest.attribution`.
 */
export const SSURGO_ATTRIBUTION = "U.S. Department of Agriculture, Natural Resources Conservation Service"

/**
 * The licence expression written into `layer_manifest.license`.
 *
 * A public-domain identifier, and the grant behind it is the producing agency's own sentence rather than a catalogue
 * field: data.gov's entry points at `usa.gov/publicdomain/label/1.0/`, which redirects to a page that declines a
 * blanket grant and tells the reader to check with the agency. The agency was checked at the strongest available place
 * — the FGDC metadata NRCS ships inside the archive — and it says {@link SSURGO_PUBLIC_INFORMATION_SENTENCE}.
 */
export const SSURGO_LICENSE = "LicenseRef-USGov-Public-Domain"

/**
 * The sentence that makes this layer shippable, verbatim from the `useconst` element of the FGDC metadata inside every
 * survey-area archive.
 *
 * The ingest asserts it is present in each area's metadata. A survey area whose use constraints no longer say this is a
 * licence change, and a build that absorbed one would ship an artifact under terms nobody checked.
 */
export const SSURGO_PUBLIC_INFORMATION_SENTENCE = "This is public information"

/**
 * The use constraints in full, as the metadata states them. Carried so a reader can check the licence claim against the
 * authority's own words rather than against this package's summary of them.
 */
export const SSURGO_USE_CONSTRAINTS =
	"The U.S. Department of Agriculture, Natural Resources Conservation Service, should be acknowledged as the data " +
	"source in products derived from these data. This data set is not designed for use as a primary regulatory tool " +
	"in permitting or citing decisions, but may be used as a reference source. This is public information and may be " +
	"interpreted by organizations, agencies, units of government, or others based on needs; however, they are " +
	"responsible for the appropriate application."

/**
 * What a reading is NOT, in the authority's own words. Carried on every reading, because a caller cannot see from a
 * capability class that the survey declines to speak about a specific site.
 *
 * The first two sentences are why §3.1 of the survey forbids a point-level determination: the map is authoritative
 * about an area at its own scale and explicitly declines to be authoritative about a point.
 */
export const SSURGO_PRODUCT_LIMITS: ReadonlyArray<string> = [
	"The depicted soil boundaries, interpretations, and analysis derived from them do not eliminate the need for onsite sampling, testing, and detailed study of specific sites for intensive uses. Thus, these data and their interpretations are intended for planning purposes only.",
	"Photographic or digital enlargement of these maps to scales greater than at which they were originally mapped can cause misinterpretation of the data. If enlarged, maps do not show the small areas of contrasting soils that could have been shown at a larger scale.",
	"This data set is not designed for use as a primary regulatory tool in permitting or citing decisions, but may be used as a reference source.",
	"Digital data files are periodically updated. Files are dated, and users are responsible for obtaining the latest version of the data.",
	"The difference in positional accuracy between the soil boundaries and special soil features locations in the field and their digitized map locations is unknown.",
]

/**
 * The coverage statement a `designated` basis rests on: what NRCS declares complete inside a published survey area.
 *
 * It is the mapping at the survey's own scale, NOT a site-specific determination — which is why the observation reports
 * what the survey assigns to the map unit covering a location and never whether the land can be farmed.
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
 * The projection every SSURGO survey-area shapefile declares. The `.prj` is an ESRI WKT naming `GCS_WGS_1984`, which
 * GDAL resolves to this authority code — so no reprojection is needed before H3, and a survey area declaring anything
 * else is a product change rather than a variation to absorb.
 */
export const SSURGO_SOURCE_EPSG = 4326

/**
 * Whether a farmland classification's criteria are set nationally or by a state or local agency.
 *
 * 7 CFR 657.5 defines prime and unique farmland against nine national criteria; (c) and (d) delegate statewide and
 * local importance. A consumer comparing two states may compare the national categories and must not compare the
 * delegated ones.
 */
export const FarmlandScope = {
	/**
	 * Criteria set by 7 CFR 657.5(a)–(b). Comparable across the country.
	 */
	Federal: "federal",
	/**
	 * Criteria "determined by the appropriate State agency or agencies" — 7 CFR 657.5(c).
	 */
	State: "state",
	/**
	 * Criteria "identified by the local agency or agencies concerned" — 7 CFR 657.5(d).
	 */
	Local: "local",
	/**
	 * The value states no farmland importance at all.
	 */
	None: "none",
} as const

export type FarmlandScope = (typeof FarmlandScope)[keyof typeof FarmlandScope]

/**
 * Which scope a declared `farmlndcl` value falls under, decided on the phrase the regulation itself uses.
 *
 * Matching on the phrase rather than on an enumerated list of the 28 values is deliberate: the domain grows — the
 * conditional tail is generated by combining a base category with a condition — and a new `Farmland of statewide
 * importance, if …` must land in {@link FarmlandScope.State} on the day it appears rather than silently defaulting to
 * the comparable bucket.
 */
export function farmlandScope(value: string | null | undefined): FarmlandScope {
	if (!value) return FarmlandScope.None

	const lowered = value.toLowerCase()

	// FIRST, because it CONTAINS the phrase the federal test looks for. `Not prime farmland` is a declared value stating
	// no farmland importance at all, and a substring test that ran the other way round would call it federally comparable
	// prime farmland — which it is the exact negation of. It is also the most common value in the domain: 192,120 of the
	// 339,191 national map units carry it.
	if (lowered.startsWith("not prime farmland")) return FarmlandScope.None

	if (lowered.includes("statewide importance")) return FarmlandScope.State

	if (lowered.includes("local importance")) return FarmlandScope.Local

	if (lowered.includes("prime farmland") || lowered.includes("unique importance")) return FarmlandScope.Federal

	return FarmlandScope.None
}

/**
 * Map-unit symbols NRCS uses for a delineation it has drawn and has no soil mapping behind.
 *
 * These are polygons rather than holes — the same wall-to-wall discipline that makes them separable from land outside a
 * survey area entirely. Measured nationally through Soil Data Access: 37 map units carry `NOTCOM` (`No Digital Data
 * Available`) and 7 carry `NOTPUB` (`Not Public Information`).
 */
export const SSURGO_NO_MAPPING_SYMBOLS: ReadonlySet<string> = new Set(["NOTCOM", "NOTPUB"])

/**
 * Map-unit names for the same case, where the symbol does not carry it. Measured nationally: 72 map units are named
 * `Area not surveyed, access denied`.
 *
 * Matched case-insensitively on the whole name. A prefix match would catch a future `Area not surveyed, access denied —
 * pending` and would also catch nothing else, but it would equally catch a real soil name beginning with those words,
 * and there is no such thing to be gained by guessing.
 */
export const SSURGO_NO_MAPPING_NAMES: ReadonlySet<string> = new Set([
	"area not surveyed, access denied",
	"not public information",
	"no digital data available",
])

/**
 * The interpretation rule whose overall value this layer carries, exactly as `cointerp.mrulename` spells it.
 *
 * Its `interphr` is an index in [0, 1] — measured 0.001 to 0.991 nationally, 0.022 to 0.990 on `IA153` — and it is
 * never blended with the capability class: they are two ratings from one authority answering different questions, and
 * combining them would produce a number NRCS does not publish.
 */
export const NCCPI_V3_RULE_NAME = "NCCPI - National Commodity Crop Productivity Index (Ver 3.0)"

/**
 * The interpretation depth at which a rule reports its own overall value. Sub-rules sit at greater depths and are the
 * submodels (corn, soybeans, small grains, cotton), which this layer does not carry.
 */
export const COINTERP_OVERALL_RULE_DEPTH = "0"

/**
 * How the per-cell shares were produced, recorded on every row.
 *
 * The survey names this as a required record because the weighting mixes two different things — polygon geometry, which
 * the survey does know, and component percentages, which are a proportion without a location. "60% of this cell's area
 * lies in map units whose components are class 2" and "the components in this cell sum to 60% class 2" are different
 * claims, and a reader holding only a share cannot tell which one it is holding.
 */
export const SOIL_SHARE_WEIGHTING = "cell_area_x_comppct_r"

/**
 * The one-sentence expansion of {@link SOIL_SHARE_WEIGHTING}, stored beside it so the artifact explains itself.
 */
export const SOIL_SHARE_WEIGHTING_DESCRIPTION =
	"Each map-unit delineation contributes the area of the cell it covers; that area is split across the delineation's " +
	"components in proportion to comppct_r, the component's representative percentage of its map unit. Component " +
	"percentages are a proportion without a location, so a share states how much of the cell's area lies in map units " +
	"whose components carry a rating — not where within the cell that rating applies."
