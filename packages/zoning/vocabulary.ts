/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Department's own words, as data: the product identity, the national generic-type domain it declares,
 *   the plan vocabulary, the exclusions it states, and the licence posture that holds this layer at
 *   `build-local`.
 *
 *   THE LOCAL CODE IS CARRIED VERBATIM AND THE CROSSWALK SITS BESIDE IT, NEVER INSTEAD OF IT. The Department
 *   publishes a national generic type over 30 local authorities' own zone codes and says in its own item
 *   description that the scheme "complements (rather than replaces) the existing statutory zoning used for
 *   each individual plan". So a row carries both: `local_code` as the authority spelled it, and
 *   `crosswalk_code` under {@link GZT_CROSSWALK_SCHEME} with its own provenance. Measured over the whole
 *   national set, 52 of 795 (authority, local code) pairs take MORE THAN ONE generic type, so the mapping is
 *   not a function of the pair and no code table can carry it — which is why `zoning_crosswalk_edge` ships
 *   empty and the mapping lives per polygon.
 *
 *   THE DECLARED DOMAIN IS CLOSED AND THE SOURCE ALREADY BREAKS IT. The service declares 54 generic types in
 *   its own coded-value domain; the data uses 55. `N/A` appears on 4 rows and in no domain. So the ingest
 *   carries the declared domain PLUS the values observed in the data and records the difference
 *   (`zoning_vocabulary.declared`) rather than coercing an undeclared value to a neighbour or to null —
 *   either of which turns "the source changed" into "there is nothing here".
 *
 *   `CURRENT_PLAN = 1` DOES NOT MEAN "IN FORCE TODAY". All 85,330 rows in the Current layer carry it, and the
 *   domain defines it as `Current plan` against `Expired and not replaced` and `Expired and replaced`. It
 *   means "not superseded". The plan's own `PLAN_FROM`/`PLAN_TO` window is a separate fact a consumer must
 *   read, and it is carried on `zoning_plan` for that reason.
 *
 *   `LA_CODE` IS DIRTY AND IS NEVER REPAIRED. Fingal's code is `Fl` with a lowercase second letter against
 *   `CL`, `CO`, `DU` and the rest. It is the publisher's key; repairing it would put this package's spelling
 *   into an artifact that claims to repeat the authority's.
 */

/**
 * The layer name written into `layer_manifest.name`, and the only name the reader accepts.
 */
export const GZT_LAYER_NAME = "zoning-ie-gzt"

/**
 * The ArcGIS Online item the product is published as, written into `layer_manifest.source`.
 */
export const GZT_ITEM_ID = "5c2608ebedd84013aaeff8bf669e8596"

/**
 * The publishing organisation's ArcGIS Online id.
 */
export const GZT_ORG_ID = "NzlPQPKn5QF9v2US"

/**
 * The feature layer the product is served from.
 */
export const GZT_SERVICE_URL = `https://services.arcgis.com/${GZT_ORG_ID}/arcgis/rest/services/GZT_Current_Plan/FeatureServer/0`

/**
 * The item page, cited wherever a statement of the Department's is quoted.
 */
export const GZT_ITEM_URL = `https://www.arcgis.com/home/item.html?id=${GZT_ITEM_ID}`

/**
 * The Department's own zoning map viewer, which is where its coverage detail is published — and the reason
 * `zoning_mapped_extent` ships empty (see {@link GZT_COVERAGE_LIMIT}).
 */
export const GZT_MAP_VIEWER_URL = "https://www.myplan.ie/zoning-map-viewer/"

/**
 * The attribution the item's `accessInformation` field carries, plus the licensor its `licenseInfo` names.
 *
 * BOTH HALVES RIDE, because the second is the half that holds this layer at `build-local`. The Department's own credit
 * line is the first; the all-rights-reserved clause naming Tailte Éireann as an upstream licensor is the second, and a
 * re-user who saw only the first would not know it exists.
 */
export const GZT_ATTRIBUTION =
	"Department of Housing, Local Government, and Heritage (Generalised Zoning Types, MyPlan.ie). " +
	"© Copyright 2011 DHLGH. All rights reserved. © Tailte Éireann. All rights reserved. Licence No. 2023/OSi_NMA_073"

/**
 * The licence expression written into `layer_manifest.license`.
 *
 * `NOASSERTION` IS THE HONEST VALUE AND IT IS NOT A PLACEHOLDER. Three published statements disagree about the grant —
 * see {@link GZT_LICENSE_CONTRADICTION} — and the manifest column is a string a consumer reads as the terms it may rely
 * on. Writing `CC-BY-4.0` there while an all-rights-reserved clause names a licensor would be this program asserting a
 * grant nobody made; leaving the column empty would read as a layer whose licence nobody looked at. `NOASSERTION` is
 * SPDX's own token for a determination that has not been made, which is exactly the state.
 *
 * {@linkcode assertTierMatchesLicense} refuses a `shipped` build while this holds, so moving the tier takes a
 * deliberate edit at a guard that names the reason rather than a manifest field nobody notices.
 */
export const GZT_LICENSE = "NOASSERTION"

/**
 * Why the licence is unresolved, in one sentence a receipt can carry.
 */
export const GZT_LICENSE_CONTRADICTION =
	"Three published statements disagree about the grant: data.gov.ie declares CC-BY-4.0; the ArcGIS item's licenseInfo " +
	'states the Department "aims to publish its data holdings into the future, where possible, as Open Data licensed under ' +
	'Creative Commons Attribution 4.0" and, in the same field, that copyright "belonging to our licensors (Tailte Éireann) ' +
	"may not be copied, transmitted or reproduced without their prior consent\"; and myplan.ie's own disclaimer grants " +
	"distribution and commercial use while pointing at a map-viewer splash screen for the operative terms. " +
	"A shipped layer needs one grant it can quote, so this one is built locally and never redistributed."

/**
 * The projected CRS the service and its bulk export both declare. The source is NOT in WGS84 — it is IRENET95 / Irish
 * Transverse Mercator, in metres — so the ingest reprojects and refuses a source declaring anything else.
 */
export const GZT_SOURCE_EPSG = 2157

/**
 * The extent the Department declares for the item, in CRS84 order `[minLon, minLat, maxLon, maxLat]` — the Republic of
 * Ireland, excluding Northern Ireland.
 *
 * The ingest asserts every reprojected vertex lands inside this. That is the check a projection check cannot make: the
 * bulk export carries Irish Transverse Mercator metres under a legacy `crs` member, so a reader that took the numbers
 * as degrees would place Ireland's zoning at latitude 735,435 — a well-formed set of coordinates in the Southern
 * Ocean.
 */
export const GZT_DECLARED_BBOX: readonly [number, number, number, number] = [
	-10.54553193079905, 51.452765583177616, -5.947766999109422, 54.47387941831219,
]

/**
 * The feature count the service's own `returnCountOnly` and the bulk export agree on.
 */
export const GZT_DECLARED_FEATURE_COUNT = 85_330

/**
 * The crosswalk scheme the Department publishes — its national Generalised Zoning Type code.
 */
export const GZT_CROSSWALK_SCHEME = "IE-GZT"

/**
 * The Department's second, coarser national code (`SZO`, Standardised Zoning Objective).
 *
 * Carried as published rather than derived. Measured over the whole national set it is a STRICT COARSENING of the
 * generic type — no generic type maps to more than one `SZO` — but the roll-up is the Department's to change, so
 * re-deriving it here would replace a published fact with this package's arithmetic.
 */
export const GZT_ROLLUP_SCHEME = "IE-SZO"

/**
 * The vocabulary scheme one local authority's own zone codes belong to.
 *
 * PER AUTHORITY RATHER THAN ONE POOLED LOCAL SCHEME, because the codes collide: `Residential` means one thing in Cork
 * County Council's plan and another in Westmeath's, and pooling them would assert an equivalence no authority stated.
 */
export function localSchemeFor(authorityCode: string): string {
	return `IE-LOCAL:${authorityCode}`
}

/**
 * One value a publisher declares, with the label it publishes for it.
 */
export interface ZoningTermDefinition {
	/**
	 * The code as the publisher spells it — never re-spelled, never normalized.
	 */
	code: string
	label: string
}

/**
 * The Department's declared generic-type domain, verbatim from the service's own `GZT Code` coded-value domain.
 *
 * FIFTY-FOUR DECLARED AGAINST FIFTY-FIVE USED. `N/A` appears on 4 of 85,330 rows and in no domain, so the ingest
 * records it as observed-but-undeclared rather than adding it here — a declaration this package wrote would be
 * indistinguishable from one the Department made.
 */
export const GZT_DECLARED_CODES: ReadonlyArray<ZoningTermDefinition> = [
	{ code: "P1", label: "Agriculture" },
	{ code: "P2", label: "Forestry" },
	{ code: "P3", label: "Aquaculture and fishing" },
	{ code: "P4", label: "Quarrying / mining" },
	{ code: "P5", label: "Mixed/general primary sector uses, including ‘rural’" },
	{ code: "P6", label: "Other primary sector uses" },
	{ code: "C1.1", label: "Commercial, retail" },
	{ code: "C1.2", label: "Retail warehouse" },
	{ code: "C2.1", label: "Industrial, enterprise, employment" },
	{ code: "C2.2", label: "General industry" },
	{ code: "C3", label: "Office, business/technology park and related" },
	{ code: "C4", label: "Warehouse (excluding retail warehouse)" },
	{ code: "C5", label: "Tourism and related" },
	{ code: "C6", label: "Mixed/general commercial/industrial/enterprise uses" },
	{ code: "C7", label: "Other commerce/industrial/enterprise uses" },
	{ code: "S1", label: "Education" },
	{ code: "S2", label: "Health and related" },
	{ code: "S3", label: "Community facilities" },
	{ code: "S4", label: "General public administration" },
	{ code: "S5", label: "Mixed/general community services/facilities uses" },
	{ code: "S6", label: "Other community services/facilities uses" },
	{ code: "N1.1", label: "Road" },
	{ code: "N1.2", label: "Rail" },
	{ code: "N1.3", label: "Airport" },
	{ code: "N1.4", label: "Seaport/Harbour" },
	{ code: "N1.5", label: "Mixed/general transport uses" },
	{ code: "N1.6", label: "Other transport/general uses" },
	{ code: "N2.1", label: "Water" },
	{ code: "N2.2", label: "Wastewater" },
	{ code: "N2.3", label: "Mixed/general water/wastewater uses" },
	{ code: "N2.4", label: "Other water/waste water uses" },
	{ code: "N3.1", label: "Gas" },
	{ code: "N3.2", label: "Electricity" },
	{ code: "N3.3", label: "Mixed/general gas and electricity uses" },
	{ code: "N3.4", label: "Other gas and electricity uses" },
	{ code: "N4", label: "Telecommunications" },
	{ code: "N5", label: "Solid waste" },
	{ code: "N6", label: "Other networks and basic infrastructure/utilities uses" },
	{ code: "R1", label: "New/proposed residential" },
	{ code: "R2", label: "Existing residential" },
	{ code: "R3", label: "Residential, mixed residential and other uses" },
	{ code: "R4", label: "Strategic Residential Reserve" },
	{ code: "G1", label: "Open space, park" },
	{ code: "G2", label: "Walkway, cycleway, bridle path" },
	{ code: "G3", label: "Conservation, amenity or buffer space, corridor/belt, landscape protection" },
	{ code: "G4", label: "Active open space" },
	{ code: "G5", label: "Mixed/general ‘green’/recreation/conservation, other" },
	{ code: "M1", label: "Mixed Use, general development, opportunity/proposal site" },
	{ code: "M2", label: "City/Town/village Centre, central area" },
	{ code: "M3", label: "District, neighbourhood centre" },
	{ code: "M4", label: "Built up area" },
	{ code: "M5", label: "Other mix of uses" },
	{ code: "O1", label: "Strategic reserve, White land" },
	{ code: "O2", label: "General" },
]

/**
 * The declared generic-type codes as a membership set.
 */
export const GZT_DECLARED_CODE_SET: ReadonlySet<string> = new Set(GZT_DECLARED_CODES.map((term) => term.code))

/**
 * The `PLAN_LEVEL` domain, verbatim. `SDZ` is declared and used on no row of the current edition; it is carried anyway,
 * because the domain is the Department's statement of what a plan may be rather than a census of what it is.
 */
export const GZT_PLAN_LEVELS: ReadonlyArray<ZoningTermDefinition> = [
	{ code: "DP", label: "Development Plan" },
	{ code: "LAP", label: "Local Area Plan" },
	{ code: "SDZ", label: "Strategic Development Zone" },
]

/**
 * The `PLAN_LEVEL` domain as a membership set.
 */
export const GZT_PLAN_LEVEL_SET: ReadonlySet<string> = new Set(GZT_PLAN_LEVELS.map((term) => term.code))

/**
 * The `CURRENT_PLAN` domain, verbatim, keyed by the integer the source publishes.
 */
export const GZT_CURRENT_PLAN_VALUES: ReadonlyMap<number, string> = new Map([
	[1, "Current plan"],
	[2, "Expired and not replaced"],
	[0, "Expired and replaced"],
])

/**
 * The provenance grade a zoning claim carries. Exactly one per row, and the two never merge.
 *
 * `authoritative` is a planning or legislative authority for the land, or a government body republishing that
 * authority's own adopted records — the Department republishing 30 local authorities' plans is one. `inferred` is an
 * observation, a community mapping project or a research assembly: OpenStreetMap `landuse` is inferred, and so is
 * Overture's `base/land_use`, because it is the same data.
 *
 * NEITHER GRADE IS BETTER; THEY ANSWER DIFFERENT QUESTIONS. The rule is that a query answered from an `inferred` row
 * may never be presented as the authority's designation. Measured in one jurisdiction on one day: of 1,652
 * OpenStreetMap `landuse=residential` polygons in South Dublin, only 558 — 33.8% — sit on land the authority zones
 * residential, and the two largest wrong answers are agriculture (23.4%) and conservation (19.6%).
 *
 * ONE ARTIFACT HOLDS ONE GRADE. An observed land-use layer is a different database with a different
 * `layer_manifest.name`, because `layer_coverage.observed_rows` means "rows this layer actually holds in the cell" and
 * coverage measured over community-mapped polygons cannot describe an authority's zones. The licences make the
 * separation compulsory anyway: OpenStreetMap and Overture `base` are ODbL, and merging an ODbL row into this table
 * would relicense it.
 */
export const ProvenanceGrade = {
	Authoritative: "authoritative",
	Inferred: "inferred",
} as const

export type ProvenanceGrade = (typeof ProvenanceGrade)[keyof typeof ProvenanceGrade]

/**
 * The grade every row of THIS artifact carries. A government department republishing local authorities' adopted plans.
 */
export const GZT_PROVENANCE_GRADE: ProvenanceGrade = ProvenanceGrade.Authoritative

/**
 * What the product does NOT state, in the Department's own words.
 *
 * Carried onto every reading, because a caller holding a zone code cannot see from it that the answer is a generalised
 * republication rather than the plan itself. The first of these is the sharpest constraint the Department states, and
 * it is why this layer reports what a plan assigns at a location and never what may be built there.
 */
export const GZT_PRODUCT_LIMITS: ReadonlyArray<string> = [
	"Myplan.ie data are not published here as legal definitions of the current actuality with regard to Local Authority zoning or their geographic extents.",
	"Myplan.ie uses a generalised, homogenised version of Local Authority data. Original data should be sourced directly from the relevant Local Authority.",
	"This represents a consistent zoning scheme across all local authorities, and complements (rather than replaces) the existing statutory zoning used for each individual plan.",
	"Awaiting data for some Local Authorities - please see map viewer for coverage details.",
	"The Department does not guarantee that the digital data is free of minor errors not materially affecting performance.",
]

/**
 * Why this layer's coverage licenses no negative claim, in one sentence a receipt can carry.
 *
 * THE MEANING-OF-ZERO RULE UNDER ITS HARDEST CASE. For flood zones the Environment Agency states England-wide coverage
 * and the Planning Practice Guidance defines Zone 1 as the absence, so a location with no polygon IS a designation. No
 * such definition exists anywhere for zoning. A location with no zoning polygon is one of at least four different
 * things: outside any adopted plan area, inside a plan area on land the plan does not zone, in a jurisdiction that has
 * never adopted zoning, or in a jurisdiction whose records nobody has published. And the source can state one of them
 * positively — `ZONE_ORIG = "UNZ - Unzoned"` appears on 4 of 85,330 rows — which is what proves the other absences are
 * absences rather than designations.
 */
export const GZT_COVERAGE_LIMIT =
	"The Department publishes zoning polygons and states its coverage detail only inside a map viewer, so this layer " +
	"records source presence only. A location with no zoning polygon may be outside any adopted plan area, inside one on " +
	"land the plan does not zone, in a jurisdiction that has never adopted zoning, or in a jurisdiction whose records are " +
	"not yet published — and the product cannot tell those apart, so nothing here supports a claim that no restriction applies."

/**
 * The one local code that states unzoned land POSITIVELY, and the reason the coverage rule above is grounded rather
 * than asserted: where the authority means "unzoned" it says so on a row, so every other absence is a row that is not
 * there.
 */
export const GZT_UNZONED_LOCAL_CODE = "UNZ - Unzoned"

/**
 * Refuse a manifest that would ship this layer under a licence nobody resolved.
 *
 * A GUARD RATHER THAN A CONVENTION, for the same reason the coverage basis is one: the tier is a field, and a field can
 * be edited without anyone reading the three statements that disagree. Moving this layer to `shipped` has to go through
 * a line that names what is unresolved.
 *
 * @throws {Error} When a `shipped` tier is asked for while the licence is unresolved.
 */
export function assertTierMatchesLicense(tier: string, license: string): void {
	if (tier !== "shipped") return

	if (license === GZT_LICENSE) {
		throw new Error(
			`zoning build: tier "shipped" was asked for while the licence reads ${JSON.stringify(GZT_LICENSE)}. ` +
				`${GZT_LICENSE_CONTRADICTION} Resolve the grant in writing first, then change both this guard and the tier.`
		)
	}
}
