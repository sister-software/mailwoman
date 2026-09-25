/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Environment Agency NCERM vocabulary: product identity, the twelve scenarios, the policy and defence
 *   domains, and the OGL v3.0 attribution.
 *
 *   Every stored row and every reading carries its scenario, because the twelve layers answer different
 *   questions and must not be pooled.
 *
 *   The domains are closed, and the builder throws on a value outside them because an unknown code means the
 *   source schema changed. The domains cover all twelve layers of the 2024 geodatabase.
 *
 *   Stored values keep the source spelling. A blank value is a single space. `def_type` has case variants,
 *   so membership is tested on the folded form. The two policy fields also space one value differently, and the
 *   policy domain holds both spellings.
 */

/**
 * One published value with the authority's label, definition and source URL.
 */
export interface CoastalTermDefinition {
	/**
	 * The value exactly as the source file spells it.
	 */
	value: string
	/**
	 * The authority's name for the value.
	 */
	label: string
	/**
	 * The definition from the document at `definitionURL`.
	 */
	definition: string
	definitionURL: string
}

/**
 * The layer name in `layer_manifest.name`.
 * The reader accepts only this name.
 */
export const NCERM_LAYER_NAME = "coastal-erosion-ea-england"

/**
 * The dataset ID on `environment.data.gov.uk`, written into `layer_manifest.source`.
 */
export const NCERM_DATASET_ID = "9fede91f-5acd-4fd2-9bd8-98153fa3c2ff"

/**
 * The data.gov.uk catalogue package, which lists the ISO reference dates,
 * the licence field and the file URLs.
 */
export const NCERM_CATALOGUE_PACKAGE_ID = "e75374d5-ef4b-4f9f-abc1-6aefde4627b7"

/**
 * The OGC service slug.
 *
 * The service path misspells the product as `ncern`.
 * The correctly spelled `ncerm` path returns HTTP 404, so clients must keep the misspelling.
 */
export const NCERM_SERVICE_SLUG = "ncern-national-2024"

/**
 * The attribution string from the record's structured licence field, with its trailing space trimmed.
 *
 * OGL v3.0 requires this attribution, and it is written to `layer_manifest.attribution`.
 * The abstract carries a second, yearless copy that `parseAttributionStatement` in `sdk/client.ts` rejects.
 */
export const NCERM_ATTRIBUTION = "© Environment Agency copyright and/or database right 2025. All rights reserved."

/**
 * The licence expression written into `layer_manifest.license`.
 */
export const NCERM_LICENSE = "OGL-UK-3.0"

/**
 * The OGL v3.0 licence text URL.
 */
export const NCERM_LICENSE_URL = "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/"

/**
 * The dataset page, cited as the source of quoted definitions.
 */
export const NCERM_DATASET_URL = `https://environment.data.gov.uk/dataset/${NCERM_DATASET_ID}`

/**
 * The EPSG code that every layer declares: British National Grid, in metres.
 *
 * The ingest reprojects to WGS84 and rejects a layer that declares any other code.
 */
export const NCERM_SOURCE_EPSG = 27_700

/**
 * The extent that the OGC API Features collections declare for the erosion-zone layers,
 * as `[minLon, minLat, maxLon, maxLat]` in CRS84.
 *
 * The ingest checks every reprojected vertex against it.
 * The ground-instability boxes lie inside it, so it covers all fourteen layers.
 */
export const NCERM_DECLARED_BBOX: readonly [number, number, number, number] = [
	-6.985185754838781, 49.88191020135657, 2.066346185189053, 55.81031119080681,
]

/**
 * The management half of a scenario key.
 */
export const CoastalManagementScenario = {
	/**
	 * No Future Intervention, the baseline in which no future coastal works are delivered.
	 */
	NoFutureIntervention: "NFI",
	/**
	 * With Shoreline Management Plans delivered.
	 */
	ShorelineManagementPlan: "SMP",
} as const

/**
 * A management scenario code.
 */
export type CoastalManagementScenario = (typeof CoastalManagementScenario)[keyof typeof CoastalManagementScenario]

/**
 * One of the twelve published erosion-zone scenarios.
 */
export interface CoastalScenario {
	/**
	 * The scenario key, such as `NFI_2055_0CC`.
	 * It is the layer name without the `NCERM_` prefix.
	 */
	key: string
	/**
	 * The layer name in the geodatabase.
	 */
	layer: string
	management: CoastalManagementScenario
	/**
	 * The horizon year: `2055` is Medium Term and `2105` is Long Term.
	 */
	horizon: number
	/**
	 * The climate allowance.
	 *
	 * `0CC` is present day (2020).
	 * `70CC` and `95CC` are the UKCP18 RCP8.5 70th and 95th percentile sea-level-rise allowances.
	 */
	climateAllowance: string
	/**
	 * The column that holds cumulative erosion distance in metres.
	 *
	 * Each layer uses a different name, such as `nfi2055_0` or `smp2105_95`.
	 */
	distanceColumn: string
	label: string
}

/**
 * Returns whether a scenario's layer has the four Shoreline Management Plan policy fields.
 *
 * NFI layers lack them because a no-intervention scenario has no policy.
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
		// The column lowercases the management code and drops `CC`, so `70CC` becomes `_70`.
		distanceColumn: `${management.toLowerCase()}${horizon}_${climateAllowance.replace("CC", "")}`,
		label: `${MANAGEMENT_LABELS[management]}, ${HORIZON_LABELS[horizon]} (${horizon}), ${ALLOWANCE_LABELS[climateAllowance]}`,
	}
}

/**
 * The twelve erosion-zone scenarios, in layer-name sort order.
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
 * The scenario used when a caller does not specify one.
 *
 * It is the least projected scenario: no future works, present-day allowance and the nearer horizon.
 * Every reading records the scenario it used.
 */
export const DEFAULT_NCERM_SCENARIO = "NFI_2055_0CC"

/**
 * The two ground-instability layers.
 *
 * These layers describe a different hazard with its own schema, and they have
 * no erosion distance or scenario.
 * They are stored in a separate table from the erosion zones.
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
 * The feature total of the 2024 edition, as reported by both the geodatabase and the WFS.
 */
export const NCERM_DECLARED_FEATURE_COUNT = 89_371

/**
 * The blank value in this product, which is a single space.
 */
export const NCERM_BLANK = " "

/**
 * The policy domain for `mt_smp` and `lt_smp`.
 *
 * The two fields space the slash in one policy differently, so the set holds both spellings.
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
 * The policy-interpretation domain for `mt_smp_int` and `lt_smp_int`,
 * which state what a policy means for erosion.
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
 * The defence-type domain in folded form.
 *
 * The source spells some defences with different case, such as `Sheet piles` and `Sheet Piles`.
 * Membership is tested on the folded form, and the stored value keeps the source spelling.
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
 * Folds a defence type for comparison by trimming, lowercasing and collapsing whitespace.
 */
export function foldDefenceType(value: string): string {
	return value.trim().toLowerCase().replaceAll(/\s+/gu, " ")
}

/**
 * The scenarios as vocabulary rows.
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
 * The product limitations, quoted from the Environment Agency.
 *
 * Every reading carries them.
 * The first limitation is why this layer reports the mapped zone at a location
 * and makes no claim about an individual property.
 */
export const NCERM_PRODUCT_LIMITS: ReadonlyArray<string> = [
	"The data and associated information are intended for guidance only - it cannot provide details for individual properties.",
	"The data shows areas of land likely to be at erosion risk but does not show the precise future position of the shoreline.",
	"Erosion may happen faster or slower than what we show, and risk may change over time.",
	"The information is provided as best estimates based upon historic data termed 'present day' and, the higher central and upper end sea level rise climate change allowances representing UKCP18 RCP8.5 sea level rise projections. Unlike the previous NCERM, data ranges based on percentiles are not provided.",
	"The NCERM information considers the predominant risk at the coast, although flooding and erosion processes are often linked, and data on erosion of foreshore features are, in general, not included.",
]

/**
 * The receipt text that explains why a location without a polygon has no erosion designation.
 *
 * The flood product states England-wide coverage, so its missing polygon means Zone 1.
 * NCERM publishes no coverage statement.
 *
 * A location without a polygon may be inland or outside the mapped coastal risk area.
 */
export const NCERM_COVERAGE_LIMIT =
	"The Environment Agency publishes erosion zones and no coverage statement for this product. " +
	"A location with no erosion polygon may be inland, or on the coast outside the mapped risk area, and the published " +
	"layers cannot tell those apart — so this layer records source presence only and supports no claim that a location " +
	"is not at risk."
