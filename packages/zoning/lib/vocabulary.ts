import { stringifyJSON } from "@mailwoman/core/json"

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Department's product identity, declared vocabularies, stated limits and licence status for the zoning layer.
 */

/**
 * The layer name written to `layer_manifest.name`.
 * The reader accepts no other name.
 */
export const GZT_LAYER_NAME = "zoning-ie-gzt"

/**
 * The ArcGIS Online item id of the product, written to `layer_manifest.source`.
 */
export const GZT_ITEM_ID = "5c2608ebedd84013aaeff8bf669e8596"

/**
 * The publishing organisation's ArcGIS Online id.
 */
export const GZT_ORG_ID = "NzlPQPKn5QF9v2US"

/**
 * The feature layer that serves the product.
 */
export const GZT_SERVICE_URL = `https://services.arcgis.com/${GZT_ORG_ID}/arcgis/rest/services/GZT_Current_Plan/FeatureServer/0`

/**
 * The item page, cited wherever a statement of the Department's is quoted.
 */
export const GZT_ITEM_URL = `https://www.arcgis.com/home/item.html?id=${GZT_ITEM_ID}`

/**
 * The Department's zoning map viewer, which is the only place it publishes coverage detail.
 *
 * This is why `zoning_mapped_extent` is empty.
 * See {@link GZT_COVERAGE_LIMIT}.
 */
export const GZT_MAP_VIEWER_URL = "https://www.myplan.ie/zoning-map-viewer/"

/**
 * The item's `accessInformation` credit line followed by the Tailte Éireann clause from its `licenseInfo`.
 *
 * The second part must stay, because the all-rights-reserved clause for the upstream
 * licensor is what keeps this layer at the `build-local` tier.
 */
export const GZT_ATTRIBUTION =
	"Department of Housing, Local Government, and Heritage (Generalised Zoning Types, MyPlan.ie). " +
	"© Copyright 2011 DHLGH. All rights reserved. © Tailte Éireann. All rights reserved. Licence No. 2023/OSi_NMA_073"

/**
 * The licence expression written to `layer_manifest.license`.
 *
 * `NOASSERTION` is the SPDX token for an undetermined licence.
 * Three published statements disagree about the grant, as {@link GZT_LICENSE_CONTRADICTION}
 * explains. {@link assertTierMatchesLicense} rejects a `shipped` build while this value is set.
 */
export const GZT_LICENSE = "NOASSERTION"

/**
 * The explanation of why the licence is unresolved, for build reports.
 */
export const GZT_LICENSE_CONTRADICTION =
	"Three published statements disagree about the grant: data.gov.ie declares CC-BY-4.0; the ArcGIS item's licenseInfo " +
	'states the Department "aims to publish its data holdings into the future, where possible, as Open Data licensed under ' +
	'Creative Commons Attribution 4.0" and, in the same field, that copyright "belonging to our licensors (Tailte Éireann) ' +
	"may not be copied, transmitted or reproduced without their prior consent\"; and myplan.ie's own disclaimer grants " +
	"distribution and commercial use while pointing at a map-viewer splash screen for the operative terms. " +
	"A shipped layer needs one grant it can quote, so this one is built locally and never redistributed."

/**
 * The projected CRS that the service and its bulk export declare: IRENET95 /
 * Irish Transverse Mercator, in metres.
 *
 * The ingest reprojects from it and rejects a source that declares any other code.
 */
export const GZT_SOURCE_EPSG = 2157

/**
 * The extent that the Department declares for the item, as `[minLon, minLat, maxLon, maxLat]` in CRS84.
 *
 * The ingest checks that every reprojected vertex falls inside it.
 * This catches a read that treats the source's projected metres as degrees,
 * which the projection check misses.
 */
export const GZT_DECLARED_BBOX: readonly [number, number, number, number] = [
	-10.54553193079905, 51.452765583177616, -5.947766999109422, 54.47387941831219,
]

/**
 * The feature count reported by both the service's `returnCountOnly` query and the bulk export.
 */
export const GZT_DECLARED_FEATURE_COUNT = 85_330

/**
 * The crosswalk scheme of the Department's national Generalised Zoning Type codes.
 */
export const GZT_CROSSWALK_SCHEME = "IE-GZT"

/**
 * The scheme of the Department's coarser national code, `SZO` (Standardised Zoning Objective).
 *
 * The roll-up is stored as published, because the Department may change it.
 */
export const GZT_ROLLUP_SCHEME = "IE-SZO"

/**
 * Returns the vocabulary scheme for one local authority's zone codes.
 *
 * Each authority has its own scheme because the same code, such as `Residential`,
 * can mean different things in different plans.
 */
export function localSchemeFor(authorityCode: string): string {
	return `IE-LOCAL:${authorityCode}`
}

/**
 * One value that a publisher declares, with its published label.
 */
export interface ZoningTermDefinition {
	/**
	 * The code exactly as the publisher spells it.
	 */
	code: string
	label: string
}

/**
 * The Department's declared generic-type domain, copied verbatim from the
 * service's `GZT Code` coded-value domain.
 *
 * The data also uses `N/A`, which no domain declares.
 * The ingest records it as observed but undeclared, so it is left out of this list.
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
 * The `PLAN_LEVEL` domain, verbatim.
 *
 * It includes `SDZ` because the Department declares it, although no current row uses it.
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
 * The `CURRENT_PLAN` domain, verbatim, keyed by the published integer.
 *
 * The value 1 means the plan is not superseded.
 * Its validity window is stored separately on `zoning_plan`.
 */
export const GZT_CURRENT_PLAN_VALUES: ReadonlyMap<number, string> = new Map([
	[1, "Current plan"],
	[2, "Expired and not replaced"],
	[0, "Expired and replaced"],
])

/**
 * The provenance grade of a zoning row.
 *
 * An `authoritative` row comes from a planning authority for the land, or from a
 * government body that republishes that authority's adopted records.
 * An `inferred` row comes from observation, community mapping or research,
 * such as OpenStreetMap `landuse` or Overture `base/land_use`.
 *
 * A caller must never present an `inferred` row as the authority's designation.
 *
 * Each artifact holds rows of one grade only.
 * An inferred land-use layer needs its own database, and ODbL sources such as
 * OpenStreetMap cannot be merged into this table without relicensing it.
 */
export const ProvenanceGrade = {
	Authoritative: "authoritative",
	Inferred: "inferred",
} as const

/**
 * One of the {@link ProvenanceGrade} values.
 */
export type ProvenanceGrade = (typeof ProvenanceGrade)[keyof typeof ProvenanceGrade]

/**
 * The grade of every row in this artifact, because the Department republishes
 * local authorities' adopted plans.
 */
export const GZT_PROVENANCE_GRADE: ProvenanceGrade = ProvenanceGrade.Authoritative

/**
 * The Department's own statements of what the product does not state.
 *
 * Every reading includes them, because a zone code alone does not show that it
 * comes from a generalised republication.
 * The layer reports what a plan assigns at a location, never what may be built there.
 */
export const GZT_PRODUCT_LIMITS: ReadonlyArray<string> = [
	"Myplan.ie data are not published here as legal definitions of the current actuality with regard to Local Authority zoning or their geographic extents.",
	"Myplan.ie uses a generalised, homogenised version of Local Authority data. Original data should be sourced directly from the relevant Local Authority.",
	"This represents a consistent zoning scheme across all local authorities, and complements (rather than replaces) the existing statutory zoning used for each individual plan.",
	"Awaiting data for some Local Authorities - please see map viewer for coverage details.",
	"The Department does not guarantee that the digital data is free of minor errors not materially affecting performance.",
]

/**
 * The explanation of why this layer's coverage supports no negative claim, for readings and reports.
 *
 * Zoning has no official definition for land without a polygon.
 * Such land may be outside every plan area, unzoned by a plan, in a jurisdiction
 * without zoning, or in one whose records are unpublished.
 */
export const GZT_COVERAGE_LIMIT =
	"The Department publishes zoning polygons and states its coverage detail only inside a map viewer, so this layer " +
	"records source presence only. A location with no zoning polygon may be outside any adopted plan area, inside one on " +
	"land the plan does not zone, in a jurisdiction that has never adopted zoning, or in a jurisdiction whose records are " +
	"not yet published — and the product cannot tell those apart, so nothing here supports a claim that no restriction applies."

/**
 * The local code with which an authority explicitly marks land as unzoned.
 *
 * Only a row with this code means unzoned.
 * A location with no row makes no statement about zoning.
 */
export const GZT_UNZONED_LOCAL_CODE = "UNZ - Unzoned"

/**
 * Throws when a build requests the `shipped` tier while the licence is unresolved.
 *
 * The check makes a tier change require an edit here, next to the explanation of the licence conflict.
 *
 * @throws {Error} When `tier` is `shipped` and `license` is {@link GZT_LICENSE}.
 */
export function assertTierMatchesLicense(tier: string, license: string): void {
	if (tier !== "shipped") return

	if (license === GZT_LICENSE) {
		throw new Error(
			`zoning build: tier "shipped" was asked for while the licence reads ${stringifyJSON(GZT_LICENSE)}. ` +
				`${GZT_LICENSE_CONTRADICTION} Resolve the grant in writing first, then change both this guard and the tier.`
		)
	}
}
