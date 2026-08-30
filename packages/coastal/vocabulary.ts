/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Environment Agency's own words, as data: the product identity, the twelve scenarios it publishes,
 *   the policy and defence domains those scenarios carry, and the attribution string OGL v3.0 requires.
 *
 *   A SCENARIO IS PART OF THE CLAIM, NEVER A PARAMETER OF IT. NCERM publishes twelve erosion-zone layers
 *   because the answer depends on which management scenario, which horizon and which sea-level-rise
 *   allowance the reader means. Pooling them would answer a question no authority asked, and would let a
 *   reader take a 2105 projection for a present-day designation. So every stored row, every index row and
 *   every reading names its scenario.
 *
 *   THE DOMAINS BELOW ARE CLOSED AND THE BUILDER THROWS ON A VALUE OUTSIDE THEM. An unknown code is a
 *   source-schema change, which is the event a reader most needs to hear about; coercing it to a nearest
 *   neighbour or to null converts "the source changed" into "there is nothing here". Each one is a census
 *   of all twelve published layers rather than of one, taken from the 2024 geodatabase — a domain read from
 *   a single layer is a domain that throws on the day another layer carries its ninth value.
 *
 *   BLANK IS A SINGLE SPACE, NOT AN EMPTY STRING. Every "blank" value in this product is `" "`, on 87 rows
 *   across the twelve layers — the same 87 that carry `published = 0`, and all of them on SMP layers (13 to
 *   16 per layer; the NFI layers have none). A reader testing `=== ""` finds nothing and reports the
 *   anomalous rows as ordinary ones.
 *
 *   `def_type` IS DIRTY AND THE FOLD IS FOR COMPARING, NEVER FOR STORING. The census returns 14 distinct
 *   values and 12 distinct case-folded ones: `Sheet piles` 1,344 beside `Sheet Piles` 270, and
 *   `Vertical Wall - Concrete` 16,074 beside `Vertical Wall - concrete` 12. The stored value is the source's
 *   own string.
 *
 *   AND THE TWO POLICY FIELDS DO NOT AGREE WITH EACH OTHER ON SPELLING. `mt_smp` writes
 *   `No Active Intervention / Managed Realignment` where `lt_smp` writes
 *   `No Active Intervention/Managed Realignment` — same 72 rows, different spacing. Both spellings are in the
 *   domain below; neither is normalized away.
 */

/**
 * One value the authority publishes, with the definition it publishes and where that definition is stated.
 */
export interface CoastalTermDefinition {
	/**
	 * The value as it appears in the source file — never re-spelled, never normalized.
	 */
	value: string
	/**
	 * The authority's own name for it.
	 */
	label: string
	/**
	 * The definition, in the words of the document `definitionURL` names.
	 */
	definition: string
	definitionURL: string
}

/**
 * The layer name written into `layer_manifest.name`, and the only name the reader accepts.
 */
export const NCERM_LAYER_NAME = "coastal-erosion-ea-england"

/**
 * The dataset identifier on `environment.data.gov.uk`, written into `layer_manifest.source`.
 */
export const NCERM_DATASET_ID = "9fede91f-5acd-4fd2-9bd8-98153fa3c2ff"

/**
 * The data.gov.uk catalogue entry for the product — the readable primary source for its ISO reference dates, its
 * licence field, and the direct file URLs.
 */
export const NCERM_CATALOGUE_PACKAGE_ID = "e75374d5-ef4b-4f9f-abc1-6aefde4627b7"

/**
 * The OGC service slug, and it is a MISSPELLING OF THE PRODUCT.
 *
 * `…/spatialdata/ncerm-national-2024/wfs?…GetCapabilities` — the correct spelling of NCERM — answers HTTP 404;
 * `…/spatialdata/ncern-national-2024/wfs?…` answers HTTP 200 with 110,478 bytes. Any client must use the misspelling,
 * and a build that "corrected" it would lose the service half of the two-path verification while reporting a clean
 * run.
 */
export const NCERM_SERVICE_SLUG = "ncern-national-2024"

/**
 * The attribution string the record's structured licence field carries, trimmed of its trailing space.
 *
 * OGL v3.0 requires a re-user to "acknowledge the source of the Information in your product or application by including
 * or linking to any attribution statement specified by the Information Provider(s)", so this string is the licence
 * condition rather than decoration, and it rides in `layer_manifest.attribution`.
 *
 * TAKEN FROM THE STRUCTURED FIELD, NEVER FROM THE ABSTRACT. The abstract ends with a doubled and malformed pair — "…©
 * Environment Agency copyright and/or database right Attribution statement: © Environment Agency copyright and/or
 * database right 2025. All rights reserved. " — whose FIRST copy is inherited from the superseded 2018–2021 record and
 * carries no year. The ISO record has no `gmd:credit` element at all. `parseAttributionStatement` in `sdk/client.ts` is
 * the reader that refuses the yearless copy.
 */
export const NCERM_ATTRIBUTION = "© Environment Agency copyright and/or database right 2025. All rights reserved."

/**
 * The licence expression written into `layer_manifest.license`.
 */
export const NCERM_LICENSE = "OGL-UK-3.0"

/**
 * The licence text OGL v3.0 asks a re-user to link to.
 */
export const NCERM_LICENSE_URL = "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/"

/**
 * The dataset page, cited wherever a statement of the authority's is quoted.
 */
export const NCERM_DATASET_URL = `https://environment.data.gov.uk/dataset/${NCERM_DATASET_ID}`

/**
 * The projected CRS every published layer declares. The file is NOT in WGS84 — it is OSGB36 / British National Grid, in
 * metres — so the ingest reprojects and the builder refuses a source that declares anything else.
 */
export const NCERM_SOURCE_EPSG = 27_700

/**
 * The bounding box the OGC API Features collections declare for the twelve erosion-zone layers, in CRS84 order
 * `[minLon, minLat, maxLon, maxLat]`.
 *
 * The ingest asserts every reprojected vertex lands inside this, which is the check that catches a coordinate-order or
 * projection mistake before 89,371 polygons are written to the wrong side of the planet. The two ground-instability
 * collections declare tighter boxes inside this one, so the same assertion serves all fourteen.
 */
export const NCERM_DECLARED_BBOX: readonly [number, number, number, number] = [
	-6.985185754838781, 49.88191020135657, 2.066346185189053, 55.81031119080681,
]

/**
 * The management scenario half of a scenario key.
 */
export const CoastalManagementScenario = {
	/**
	 * No Future Intervention — the authority's baseline, in which no future coastal works are delivered.
	 */
	NoFutureIntervention: "NFI",
	/**
	 * With Shoreline Management Plans delivered.
	 */
	ShorelineManagementPlan: "SMP",
} as const

export type CoastalManagementScenario = (typeof CoastalManagementScenario)[keyof typeof CoastalManagementScenario]

/**
 * One of the twelve erosion-zone scenarios, as the authority publishes it.
 */
export interface CoastalScenario {
	/**
	 * The key this package identifies the scenario by, everywhere: `NFI_2055_0CC`, `SMP_2105_95CC`, and so on. It is the
	 * source's own layer name with the `NCERM_` prefix removed.
	 */
	key: string
	/**
	 * The layer inside the published geodatabase.
	 */
	layer: string
	management: CoastalManagementScenario
	/**
	 * `2055` Medium Term, `2105` Long Term.
	 */
	horizon: number
	/**
	 * `0CC` present day (2020); `70CC` and `95CC` the UKCP18 RCP8.5 sea-level-rise 70th and 95th percentile allowances.
	 */
	climateAllowance: string
	/**
	 * The cumulative-erosion-distance column, in metres.
	 *
	 * ITS NAME VARIES PER LAYER and that is the trap: `nfi2055_0` on NFI/2055/0CC, `smp2105_95` on SMP/2105/95CC. A
	 * builder that read one fixed column name would find the column missing on eleven of the twelve layers, which
	 * `ogr2ogr` reports as a SQL error rather than as a silent null — but a builder that coalesced it would write NULL
	 * distances for eleven scenarios and report a successful build.
	 */
	distanceColumn: string
	label: string
}

/**
 * Whether a scenario's layer carries the four Shoreline Management Plan policy fields.
 *
 * The NFI layers omit them, and the reason is stated rather than worked around: under a no-future-intervention scenario
 * there is no policy to record. A builder that read `mt_smp` from an NFI layer gets a SQL error; one that defaulted it
 * to a blank would invent a policy the authority declines to state.
 */
export function scenarioCarriesPolicy(scenario: CoastalScenario): boolean {
	return scenario.management === CoastalManagementScenario.ShorelineManagementPlan
}

const HORIZON_LABELS: Readonly<Record<number, string>> = { 2055: "Medium Term", 2105: "Long Term" }

const ALLOWANCE_LABELS: Readonly<Record<string, string>> = {
	"0CC": "present day (2020)",
	"70CC": "UKCP18 RCP8.5 70th percentile sea-level-rise allowance",
	"95CC": "UKCP18 RCP8.5 95th percentile sea-level-rise allowance",
}

const MANAGEMENT_LABELS: Readonly<Record<CoastalManagementScenario, string>> = {
	NFI: "No Future Intervention",
	SMP: "With Shoreline Management Plans delivered",
}

function scenarioOf(management: CoastalManagementScenario, horizon: number, climateAllowance: string): CoastalScenario {
	const key = `${management}_${horizon}_${climateAllowance}`

	return {
		key,
		layer: `NCERM_${key}`,
		management,
		horizon,
		climateAllowance,
		// `0CC` → `_0`, `70CC` → `_70`. The column drops the `CC` and lowercases the management code.
		distanceColumn: `${management.toLowerCase()}${horizon}_${climateAllowance.replace("CC", "")}`,
		label: `${MANAGEMENT_LABELS[management]}, ${HORIZON_LABELS[horizon]} (${horizon}), ${ALLOWANCE_LABELS[climateAllowance]}`,
	}
}

/**
 * The twelve erosion-zone scenarios, in the order the authority's layer names sort.
 */
export const NCERM_SCENARIOS: ReadonlyArray<CoastalScenario> = [
	CoastalManagementScenario.NoFutureIntervention,
	CoastalManagementScenario.ShorelineManagementPlan,
].flatMap((management) =>
	[2055, 2105].flatMap((horizon) =>
		["0CC", "70CC", "95CC"].map((allowance) => scenarioOf(management, horizon, allowance))
	)
)

/**
 * The scenarios by key.
 */
export const NCERM_SCENARIOS_BY_KEY: ReadonlyMap<string, CoastalScenario> = new Map(
	NCERM_SCENARIOS.map((scenario) => [scenario.key, scenario])
)

/**
 * The scenario a reading answers under when a caller names none.
 *
 * NOT AN ARBITRARY PICK, AND NEVER A HIDDEN ONE — every reading names the scenario it answered under, so a caller can
 * see which of the twelve spoke. Among them this is the least projected: `NFI` assumes no future works are delivered
 * rather than assuming a plan's delivery, `0CC` is the present-day allowance rather than a sea-level-rise projection,
 * and `2055` is the nearer of the two horizons. A caller wanting another scenario names it.
 */
export const DEFAULT_NCERM_SCENARIO = "NFI_2055_0CC"

/**
 * The two ground-instability layers, which are a DIFFERENT HAZARD and live in their own table.
 *
 * They carry a different schema (`location`, `local_auth`, `smp_pu1`…`smp_pu5`, `rearscarpr`), 80 features each, and no
 * erosion distance and no scenario at all. Folding them into the erosion zones would let a reader answer an erosion
 * question from a landslide polygon.
 */
export const NCERM_GROUND_INSTABILITY_LAYERS: ReadonlyArray<{ layer: string; kind: string; label: string }> = [
	{
		layer: "NCERM_Ground_Instability_Zone",
		kind: "zone",
		label: "Ground instability zone",
	},
	{
		layer: "NCERM_Ground_Instability_Recession",
		kind: "recession",
		label: "Ground instability recession",
	},
]

/**
 * Every layer the build reads, erosion scenarios first.
 */
export const NCERM_ALL_LAYERS: ReadonlyArray<string> = [
	...NCERM_SCENARIOS.map((scenario) => scenario.layer),
	...NCERM_GROUND_INSTABILITY_LAYERS.map((instability) => instability.layer),
]

/**
 * The feature total the geodatabase and the WFS both report. Measured both ways on the 2024 edition and identical.
 */
export const NCERM_DECLARED_FEATURE_COUNT = 89_371

/**
 * The blank value this product uses. A single space, on 87 rows.
 */
export const NCERM_BLANK = " "

/**
 * The Shoreline Management Plan policy domain — `mt_smp` and `lt_smp` pooled.
 *
 * NINE spellings for eight policies, because the two fields disagree on the spacing around one slash. Both are members;
 * neither is normalized.
 */
export const NCERM_POLICY_VALUES: ReadonlySet<string> = new Set([
	"Hold The Line",
	"No Active Intervention",
	"Managed Realignment",
	"Hold The Line / Managed Realignment",
	"Hold The Line / No Active Intervention",
	"No Active Intervention / Managed Realignment",
	"No Active Intervention/Managed Realignment",
	"Pending Agreement",
	NCERM_BLANK,
])

/**
 * The policy-interpretation domain — `mt_smp_int` and `lt_smp_int`. This is the field that says what the policy means
 * for erosion.
 */
export const NCERM_POLICY_INTERPRETATIONS: ReadonlyArray<CoastalTermDefinition> = [
	{
		value: "Erosion restricted",
		label: "Erosion restricted",
		definition:
			"The shoreline management policy for this frontage restricts erosion over the period, so the mapped zone reflects a defended shoreline.",
		definitionURL: NCERM_DATASET_URL,
	},
	{
		value: "Erosion unrestricted",
		label: "Erosion unrestricted",
		definition:
			"The shoreline management policy for this frontage does not restrict erosion over the period, so the mapped zone reflects an undefended shoreline.",
		definitionURL: NCERM_DATASET_URL,
	},
	{
		value: "Stop Maintaining",
		label: "Stop Maintaining",
		definition:
			"The shoreline management policy for this frontage stops maintaining the existing defence during the period, so the mapped zone reflects the defence ceasing to hold.",
		definitionURL: NCERM_DATASET_URL,
	},
	{
		value: NCERM_BLANK,
		label: "blank",
		definition:
			"No interpretation is recorded. Carried as published on the 87 rows that also carry published = 0; the Environment Agency documents no meaning for them, so they are stored as-is rather than dropped or coerced.",
		definitionURL: NCERM_DATASET_URL,
	},
]

/**
 * The policy-interpretation domain as a membership set.
 */
export const NCERM_POLICY_INTERPRETATION_VALUES: ReadonlySet<string> = new Set(
	NCERM_POLICY_INTERPRETATIONS.map((term) => term.value)
)

/**
 * The defence-type domain, case-folded — twelve distinct defences behind fourteen published spellings.
 *
 * Membership is tested on the fold, because `Sheet piles` and `Sheet Piles` are one defence; the STORED value is the
 * source's own string, because normalizing it would put this package's spelling into an artifact that claims to repeat
 * the authority's.
 */
export const NCERM_DEFENCE_TYPES_FOLDED: ReadonlySet<string> = new Set(
	[
		NCERM_BLANK,
		"Vertical Wall - Concrete",
		"Vertical Wall - Brick/Masonry",
		"Vertical Wall - Timber",
		"Vertical Wall - Gabions",
		"Revetment - Permeable",
		"Revetment - Impermeable",
		"Natural",
		"Natural (Vertical Wall - Brick/Masonry)",
		"Natural (Vertical Wall - Concrete)",
		"Embankment",
		"Sheet Piles",
	].map((value) => foldDefenceType(value))
)

/**
 * The comparison form of a defence type: case-folded and whitespace-collapsed.
 */
export function foldDefenceType(value: string): string {
	return value.trim().toLowerCase().replaceAll(/\s+/gu, " ")
}

/**
 * The scenario domain, as vocabulary rows a reader can quote.
 */
export const NCERM_SCENARIO_TERMS: ReadonlyArray<CoastalTermDefinition> = NCERM_SCENARIOS.map((scenario) => ({
	value: scenario.key,
	label: scenario.label,
	definition:
		`${MANAGEMENT_LABELS[scenario.management]}, at the ${HORIZON_LABELS[scenario.horizon]?.toLowerCase()} horizon of ${scenario.horizon}, ` +
		`under the ${ALLOWANCE_LABELS[scenario.climateAllowance]} allowance. The distance is cumulative erosion in metres, ` +
		`published in the source column ${scenario.distanceColumn}.`,
	definitionURL: NCERM_DATASET_URL,
}))

/**
 * What the product does NOT cover, in the authority's own words.
 *
 * Carried onto every reading, because a caller cannot see from an erosion distance that the answer is silent about
 * flooding, about foreshore features, or about any individual property. The first of these is the sharpest constraint
 * the source states, and it is why this layer reports what the map assigns at a location and never whether a property
 * will erode.
 */
export const NCERM_PRODUCT_LIMITS: ReadonlyArray<string> = [
	"The data and associated information are intended for guidance only - it cannot provide details for individual properties.",
	"The data shows areas of land likely to be at erosion risk but does not show the precise future position of the shoreline.",
	"Erosion may happen faster or slower than what we show, and risk may change over time.",
	"The information is provided as best estimates based upon historic data termed 'present day' and, the higher central and upper end sea level rise climate change allowances representing UKCP18 RCP8.5 sea level rise projections. Unlike the previous NCERM, data ranges based on percentiles are not provided.",
	"The NCERM information considers the predominant risk at the coast, although flooding and erosion processes are often linked, and data on erosion of foreshore features are, in general, not included.",
]

/**
 * Why this layer's coverage licenses no negative claim, in one sentence a receipt can carry.
 *
 * THE INVERSION OF THE FLOOD RULE, AND THE WHOLE REASON THIS LAYER EXISTS AS A SECOND ONE. For flood zones the
 * authority states England-wide coverage and defines Zone 1 as the absence, so a location with no polygon is a
 * designation. NCERM publishes no coverage statement at all, and a location in England with no erosion polygon is one
 * of two entirely different things — not on the coast, or on the coast and outside the mapped risk area — which the
 * published layers cannot tell apart. A builder that copied the flood rule would write "no erosion risk" over the whole
 * country.
 */
export const NCERM_COVERAGE_LIMIT =
	"The Environment Agency publishes erosion zones and no coverage statement for this product. " +
	"A location with no erosion polygon may be inland, or on the coast outside the mapped risk area, and the published " +
	"layers cannot tell those apart — so this layer records source presence only and supports no claim that a location " +
	"is not at risk."
