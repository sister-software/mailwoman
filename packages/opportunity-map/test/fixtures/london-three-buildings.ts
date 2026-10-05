/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Three London residential buildings as one dossier dated 2026-10-05, built from public records. The
 *   record `docs/records/research/2026-10-05-uk-three-building-competition-sources.md` selects the
 *   buildings and states every value below with its source and dates. No value here is synthetic, and the
 *   fixture holds no economic input.
 *
 *   - London Development Database (Greater London Authority, London Datastore `2jxq0`): one row per
 *     building, with its planning authority, borough reference, site address, postcode, grid reference,
 *     permission, start and completion dates, and proposed residential units. A building's position is
 *     the row's grid reference converted with `osgb36ToWGS84`, so it locates the planning site's
 *     reference point. The row states the site's planning authority and postcode, and those are the
 *     building's two memberships. The row's planning authority and borough reference are the building's
 *     identifier, and the row is its evidence.
 *   - Referred planning applications since 2011 (Greater London Authority, London Datastore `2w1xz`):
 *     the Stage 2 total units of 28-30 Addiscombe Grove and of 130-154, 154a Pentonville Road. The file
 *     holds no row for 112-132 Cricklewood Lane.
 *   - ONS Postcode Directory, February 2026, and National Statistics UPRN Lookup, June 2026: the
 *     postcodes and output areas that the record infers. Each enters as an inferred claim. No source
 *     states a building's output area, so the fixture holds no output-area membership.
 *   - Ofcom Connected Nations fixed coverage, January 2026: each output area's premises and gigabit
 *     counts and each postcode's gigabit percentage, for all premises and for residential premises. A
 *     figure describes every premises in an area, so it enters as an inferred claim on the network axis
 *     and never as a layer reading, an availability record or a check.
 *   - Environment Agency Flood Map for Planning, as built into the host's `flood.db`: the reading and
 *     claim that `floodLayerReading` returned at each position. The source record's dates are the
 *     database manifest's, and `london-three-buildings.full.test.ts` recomputes the records from the
 *     database.
 *
 *   A unit count stays at the stage its source states. The LDD row's proposed units and the referral
 *   row's total units count the residential units of one permission. The referral row names that
 *   permission by its borough reference. The two counts therefore share a membership key and the
 *   permission date, and a difference between them stays a conflict. The fixture holds zero completed or
 *   occupied counts, zero availability checks and zero provider records.
 *
 *   A source that dates its observation to a month carries the month in its title and the month's last
 *   day as `observedAt`. The ONS Postcode Directory became available on 2026-02-27, before the last day
 *   of its month, so its record states no observation date and the claims that cite it print as undated.
 */

import {
	type Alias,
	type BuildingPosition,
	buildDossier,
	type Claim,
	ClaimAxis,
	type ConstructionWindow,
	type Dossier,
	type DossierRecords,
	type Entity,
	entityID,
	type EntityID,
	type ExtentMembership,
	type ISODate,
	type LayerReading,
	type SourceRecord,
	type SourceRecordID,
	type UnitCount,
	UnitStage,
} from "@mailwoman/dossier"
import { type NationalGridPoint, osgb36ToWGS84 } from "@mailwoman/spatial/osgb36"

export const LONDON_AS_OF = "2026-10-05"

export const ADDISCOMBE_GROVE = entityID("building", "croydon-17-02680-ful")
export const CRICKLEWOOD_LANE = entityID("building", "barnet-16-0601-ful")
export const PENTONVILLE_ROAD = entityID("building", "islington-p2014-1017-ful")

export const ONSPD = "onspd-2026-02"
export const NSUL = "nsul-2026-06"
export const OFCOM_POSTCODES_ALL = "ofcom-2026-01-postcode-all-r2"
export const OFCOM_POSTCODES_RESIDENTIAL = "ofcom-2026-01-postcode-residential-r1"
export const OFCOM_OUTPUT_AREAS_ALL = "ofcom-2026-01-output-area-all-r1"
export const OFCOM_OUTPUT_AREAS_RESIDENTIAL = "ofcom-2026-01-output-area-residential-r1"
export const FLOOD_MAP = "ea-flood-map-2026-05-20"

/**
 * The layer name and source vintage in the host `flood.db` manifest.
 */
export const FLOOD_LAYER = "flood-zones-ea-england"
export const FLOOD_VINTAGE = "2026-05-20"

/**
 * The premises an Ofcom file counts.
 */
type PremisesSet = "all" | "residential"

/**
 * An output area's premises count and its count of premises with gigabit availability,
 * as Ofcom publishes them.
 */
interface AreaCounts {
	premises: number
	gigabitPremises: number
}

/**
 * One building as its LDD row, its referral row and the record state it.
 */
export interface LondonSite {
	building: EntityID
	/**
	 * The building's key in claim, count and membership identifiers.
	 */
	key: string
	label: string
	/**
	 * The LDD row's `Planning Authority`.
	 */
	authority: string
	/**
	 * The LDD row's `Borough Reference`.
	 */
	reference: string
	/**
	 * The site address as the LDD records it, with the row's postcode.
	 */
	address: string
	/**
	 * The LDD row's `Post Code`.
	 */
	postcode: string
	/**
	 * The LDD row's `Easting` and `Northing`.
	 */
	grid: NationalGridPoint
	permitted: ISODate
	started: ISODate
	completed: ISODate
	/**
	 * The LDD row's `Proposed Total Residential Units`.
	 */
	plannedUnits: number
	/**
	 * The LDD row's `Existing Total Residential Units`, absent when the row leaves the field empty.
	 */
	existingUnits?: number
	ldd: SourceRecordID
	/**
	 * The referral row's case, Stage 2 date and total units, absent when the referral file holds no row.
	 */
	referral?: { source: SourceRecordID; case: string; stage2: ISODate; totalUnits: number }
	/**
	 * Each postcode the record infers, with ONSPD's introduction month, NSUL's count of UPRNs
	 * with the postcode, and how many of those UPRNs lie within 50 m of the grid reference.
	 */
	inferredPostcodes: readonly { postcode: string; introduced: string; uprns: number; within50m: number }[]
	/**
	 * Each output area that ONSPD assigns to the building's postcodes.
	 */
	outputAreas: readonly { outputArea: string; postcodes: readonly string[] }[]
	/**
	 * Ofcom's gigabit percentage for each postcode.
	 *
	 * `residential` is absent when the residential file has no row for the postcode.
	 */
	postcodeFigures: readonly { postcode: string; all: number; residential?: number }[]
	/**
	 * Ofcom's premises and gigabit counts for each output area.
	 */
	outputAreaFigures: readonly { outputArea: string; all: AreaCounts; residential: AreaCounts }[]
	/**
	 * The flood reading's basis and record count and the claim's zone code,
	 * as `floodLayerReading` returned them.
	 */
	flood: { basis: LayerReading["basis"]; records: number; zone: string }
}

export const LONDON_SITES: readonly LondonSite[] = [
	{
		building: ADDISCOMBE_GROVE,
		key: "croydon-17-02680-ful",
		label: "28-30 Addiscombe Grove",
		authority: "Croydon",
		reference: "17/02680/FUL",
		address: "28-30 Addiscombe Grove, CR0 5LP",
		postcode: "CR0 5LP",
		grid: { easting: 533_018, northing: 165_662 },
		permitted: "2018-02-20",
		started: "2018-02-20",
		completed: "2020-02-24",
		plannedUnits: 153,
		ldd: "ldd-17-02680-ful",
		referral: { source: "gla-referral-3831a", case: "3831a", stage2: "2018-02-12", totalUnits: 153 },
		inferredPostcodes: [
			{ postcode: "CR0 5BX", introduced: "2021-09", uprns: 75, within50m: 75 },
			{ postcode: "CR0 5BY", introduced: "2021-09", uprns: 81, within50m: 81 },
		],
		outputAreas: [{ outputArea: "E00005233", postcodes: ["CR0 5LP", "CR0 5BX", "CR0 5BY"] }],
		postcodeFigures: [
			{ postcode: "CR0 5BX", all: 100, residential: 100 },
			{ postcode: "CR0 5BY", all: 100, residential: 100 },
			{ postcode: "CR0 5LP", all: 0 },
		],
		outputAreaFigures: [
			{
				outputArea: "E00005233",
				all: { premises: 509, gigabitPremises: 371 },
				residential: { premises: 447, gigabitPremises: 363 },
			},
		],
		flood: { basis: "designated", records: 0, zone: "FZ1" },
	},
	{
		building: CRICKLEWOOD_LANE,
		key: "barnet-16-0601-ful",
		label: "112-132 Cricklewood Lane",
		authority: "Barnet",
		reference: "16/0601/FUL",
		address: "112-132 Cricklewood Lane, NW2 2DP",
		postcode: "NW2 2DP",
		grid: { easting: 524_237, northing: 186_057 },
		permitted: "2016-08-30",
		started: "2017-08-31",
		completed: "2019-09-04",
		plannedUnits: 122,
		ldd: "ldd-16-0601-ful",
		inferredPostcodes: [
			{ postcode: "NW2 2DL", introduced: "2018-08", uprns: 78, within50m: 78 },
			{ postcode: "NW2 2DW", introduced: "2019-09", uprns: 40, within50m: 40 },
		],
		outputAreas: [{ outputArea: "E00178816", postcodes: ["NW2 2DP", "NW2 2DL", "NW2 2DW"] }],
		postcodeFigures: [
			{ postcode: "NW2 2DL", all: 100, residential: 100 },
			{ postcode: "NW2 2DW", all: 100, residential: 100 },
			{ postcode: "NW2 2DP", all: 96.4, residential: 95.8 },
		],
		outputAreaFigures: [
			{
				outputArea: "E00178816",
				all: { premises: 127, gigabitPremises: 126 },
				residential: { premises: 122, gigabitPremises: 121 },
			},
		],
		flood: { basis: "designated", records: 0, zone: "FZ1" },
	},
	{
		building: PENTONVILLE_ROAD,
		key: "islington-p2014-1017-ful",
		label: "130-154, 154a Pentonville Road",
		authority: "Islington",
		reference: "P2014/1017/FUL",
		address: "130-154, 154a Pentonville Road, N1 9JE",
		postcode: "N1 9JE",
		grid: { easting: 530_963, northing: 183_109 },
		permitted: "2014-12-12",
		started: "2016-03-14",
		completed: "2018-05-31",
		plannedUnits: 119,
		existingUnits: 1,
		ldd: "ldd-p2014-1017-ful",
		referral: { source: "gla-referral-2924b", case: "2924b", stage2: "2014-12-02", totalUnits: 118 },
		inferredPostcodes: [
			{ postcode: "N1 9FS", introduced: "2018-06", uprns: 37, within50m: 37 },
			{ postcode: "N1 9FW", introduced: "2018-06", uprns: 6, within50m: 4 },
			{ postcode: "N1 9FT", introduced: "2018-10", uprns: 29, within50m: 29 },
			{ postcode: "N1 9FU", introduced: "2018-10", uprns: 33, within50m: 33 },
		],
		outputAreas: [
			{ outputArea: "E00174805", postcodes: ["N1 9FS", "N1 9FW", "N1 9FT", "N1 9FU"] },
			{ outputArea: "E00174843", postcodes: ["N1 9JE"] },
		],
		postcodeFigures: [
			{ postcode: "N1 9FS", all: 100, residential: 100 },
			{ postcode: "N1 9FT", all: 100, residential: 100 },
			{ postcode: "N1 9FU", all: 100, residential: 100 },
			{ postcode: "N1 9FW", all: 100 },
			{ postcode: "N1 9JE", all: 100 },
		],
		outputAreaFigures: [
			{
				outputArea: "E00174805",
				all: { premises: 163, gigabitPremises: 160 },
				residential: { premises: 150, gigabitPremises: 150 },
			},
			{
				outputArea: "E00174843",
				all: { premises: 88, gigabitPremises: 82 },
				residential: { premises: 74, gigabitPremises: 70 },
			},
		],
		flood: { basis: "designated", records: 0, zone: "FZ1" },
	},
]

/**
 * One set of Ofcom's January 2026 fixed-coverage files, with the date on
 * which its revision became available.
 */
function ofcomSource(id: SourceRecordID, files: string, availableAt: ISODate): SourceRecord {
	return {
		id,
		publisher: "Ofcom",
		title: `Connected Nations fixed coverage, January 2026: ${files}`,
		observedAt: "2026-01-31",
		availableAt,
		retrievedAt: "2026-10-05",
	}
}

const OFCOM_SOURCES: SourceRecord[] = [
	ofcomSource(
		OFCOM_POSTCODES_ALL,
		"all premises by postcode, revision 2 (202601_fixed_pc_coverage_r2_<area>.csv)",
		"2026-07-07"
	),
	ofcomSource(
		OFCOM_POSTCODES_RESIDENTIAL,
		"residential premises by postcode, revision 1 (202601_fixed_pc_coverage_res_r1_<area>.csv)",
		"2026-05-13"
	),
	ofcomSource(
		OFCOM_OUTPUT_AREAS_ALL,
		"all premises by 2021 output area, revision 1 (202601_fixed_oa_coverage_r1.csv)",
		"2026-05-13"
	),
	ofcomSource(
		OFCOM_OUTPUT_AREAS_RESIDENTIAL,
		"residential premises by 2021 output area, revision 1 (202601_fixed_oa_res_coverage_r1.csv)",
		"2026-05-13"
	),
]

function siteSources(site: LondonSite): SourceRecord[] {
	const ldd: SourceRecord = {
		id: site.ldd,
		publisher: "Greater London Authority",
		title: `London Development Database (London Datastore 2jxq0), permission ${site.reference} (${site.authority}). Its grid reference locates the planning site.`,
		observedAt: site.completed,
		availableAt: "2021-01-13",
		retrievedAt: "2026-10-05",
	}

	if (!site.referral) return [ldd]

	return [
		ldd,
		{
			id: site.referral.source,
			publisher: "Greater London Authority",
			title: `Referred planning applications since 2011 (London Datastore 2w1xz), GLA case ${site.referral.case} for ${site.reference}`,
			observedAt: site.referral.stage2,
			availableAt: "2026-01-21",
			retrievedAt: "2026-10-05",
		},
	]
}

const SOURCES: SourceRecord[] = [
	...LONDON_SITES.flatMap(siteSources),
	{
		id: ONSPD,
		publisher: "Office for National Statistics",
		title: "ONS Postcode Directory, February 2026",
		availableAt: "2026-02-27",
		retrievedAt: "2026-07-22",
	},
	{
		id: NSUL,
		publisher: "Office for National Statistics",
		title: "National Statistics UPRN Lookup, June 2026 (Epoch 127)",
		observedAt: "2026-06-30",
		availableAt: "2026-07-31",
		retrievedAt: "2026-09-03",
	},
	...OFCOM_SOURCES,
	{
		id: FLOOD_MAP,
		publisher: "Environment Agency",
		title: `Flood Map for Planning (England), revision ${FLOOD_VINTAGE}, as built into flood.db layer ${FLOOD_LAYER}`,
		url: "https://environment.data.gov.uk/dataset/04532375-a198-476e-985e-0579a0a11b47",
		observedAt: FLOOD_VINTAGE,
		availableAt: FLOOD_VINTAGE,
		retrievedAt: "2026-08-28T01:46:44.206Z",
	},
]

/**
 * Joins words as English prose without a serial comma: `a, b and c`.
 */
const PROSE_LIST = new Intl.ListFormat("en-GB", { style: "long", type: "conjunction" })

/**
 * The building's position: the LDD row's grid reference converted to WGS 84.
 */
export function sitePosition(site: LondonSite): BuildingPosition {
	const { latitude, longitude } = osgb36ToWGS84(site.grid)

	return { subject: site.building, latitude, longitude, synthetic: false, evidence: { source: site.ldd } }
}

/**
 * The flood reading and claim that `floodLayerReading` returned at the building's position.
 */
export function siteFloodRecords(site: LondonSite): { reading: LayerReading; claim: Claim<string> } {
	const { latitude, longitude } = sitePosition(site)
	const evidence = { source: FLOOD_MAP }

	return {
		reading: {
			layer: FLOOD_LAYER,
			extent: `point:${latitude},${longitude}`,
			subject: site.building,
			basis: site.flood.basis,
			surveyedAt: FLOOD_VINTAGE,
			records: site.flood.records,
			evidence,
		},
		claim: {
			id: `${FLOOD_LAYER}:${site.building}:${FLOOD_VINTAGE}`,
			subject: site.building,
			axis: ClaimAxis.Premises,
			predicate: "flood_zone",
			value: site.flood.zone,
			status: "designated",
			evidence,
		},
	}
}

/**
 * The claims about one building: the LDD row's observed values, the postcodes
 * and output areas the record infers, Ofcom's figures for each area, and the flood zone.
 */
function siteClaims(site: LondonSite): Claim[] {
	const id = (...parts: string[]) => [site.key, ...parts].join(":")
	const subject = site.building
	const ldd = { source: site.ldd }

	const claims: Claim[] = [
		{
			id: id("site-grid-reference"),
			subject,
			axis: ClaimAxis.Identity,
			predicate: "site_grid_reference",
			value: { easting: site.grid.easting, northing: site.grid.northing },
			status: "observed",
			evidence: ldd,
		},
		{
			id: id("site-postcode"),
			subject,
			axis: ClaimAxis.Identity,
			predicate: "site_postcode",
			value: site.postcode,
			status: "observed",
			evidence: ldd,
		},
		{
			id: id("permission-date"),
			subject,
			axis: ClaimAxis.Premises,
			predicate: "permission_date",
			value: site.permitted,
			status: "observed",
			evidence: ldd,
		},
	]

	if (site.existingUnits !== undefined) {
		claims.push({
			id: id("existing-residential-units"),
			subject,
			axis: ClaimAxis.Premises,
			predicate: "existing_residential_units",
			value: site.existingUnits,
			status: "observed",
			evidence: ldd,
		})
	}

	for (const entry of site.inferredPostcodes) {
		const placed = entry.within50m === entry.uprns ? `all ${entry.uprns}` : `${entry.within50m} of the ${entry.uprns}`

		claims.push({
			id: id("postcode", entry.postcode),
			subject,
			axis: ClaimAxis.Identity,
			predicate: "postcode",
			value: entry.postcode,
			status: "inferred",
			derivedFrom: [id("site-grid-reference"), id("permission-date")],
			explanation: `ONSPD dates the introduction of ${entry.postcode} to ${entry.introduced}, after the permission date, and NSUL places ${placed} UPRNs with that postcode within 50 m of the planning grid reference. The link rests on proximity and introduction date, and no published record links the planning record to the postcode.`,
			evidence: { source: NSUL },
		})
	}

	// The planning row states its own postcode.
	// Every other postcode of the building is inferred.
	const postcodeClaim = (postcode: string) =>
		postcode === site.postcode ? id("site-postcode") : id("postcode", postcode)

	const postcodeLink = (postcode: string) =>
		postcode === site.postcode
			? `The planning row states ${postcode} as the site's postcode, and the building's link to the premises Ofcom counts there is inferred.`
			: `The building's link to ${postcode} is inferred from proximity and introduction date.`

	for (const area of site.outputAreas) {
		claims.push({
			id: id("output-area", area.outputArea),
			subject,
			axis: ClaimAxis.Identity,
			predicate: "output_area",
			value: area.outputArea,
			status: "inferred",
			derivedFrom: area.postcodes.map(postcodeClaim),
			explanation: `ONSPD assigns ${PROSE_LIST.format(area.postcodes)} to output area ${area.outputArea}. No source states the building's output area, so the link rests on the building's postcodes.`,
			evidence: { source: ONSPD },
		})
	}

	const premisesWords = (set: PremisesSet) => (set === "all" ? "all premises" : "the residential premises")

	for (const figure of site.postcodeFigures) {
		const percents: [PremisesSet, number | undefined][] = [
			["all", figure.all],
			["residential", figure.residential],
		]

		for (const [premisesSet, gigabitPercent] of percents) {
			if (gigabitPercent === undefined) continue

			const extent = `postcode:${figure.postcode}`

			claims.push({
				id: id("gigabit", premisesSet, extent),
				subject,
				axis: ClaimAxis.Network,
				predicate: "area_gigabit_availability",
				value: { extent, premisesSet, premises: "unpublished", gigabitPercent },
				status: "inferred",
				derivedFrom: [postcodeClaim(figure.postcode)],
				explanation: `Ofcom states this percentage for ${premisesWords(premisesSet)} it assigns to postcode ${figure.postcode} and publishes no premises count for a postcode. ${postcodeLink(figure.postcode)}`,
				evidence: { source: premisesSet === "all" ? OFCOM_POSTCODES_ALL : OFCOM_POSTCODES_RESIDENTIAL },
			})
		}
	}

	for (const figure of site.outputAreaFigures) {
		const counts: [PremisesSet, AreaCounts][] = [
			["all", figure.all],
			["residential", figure.residential],
		]

		for (const [premisesSet, { premises, gigabitPremises }] of counts) {
			const extent = `output-area:${figure.outputArea}`

			claims.push({
				id: id("gigabit", premisesSet, extent),
				subject,
				axis: ClaimAxis.Network,
				predicate: "area_gigabit_availability",
				value: { extent, premisesSet, premises, gigabitPremises },
				status: "inferred",
				derivedFrom: [id("output-area", figure.outputArea)],
				explanation: `Ofcom states these counts for ${premisesWords(premisesSet)} it assigns to output area ${figure.outputArea}. The building's link to ${figure.outputArea} is inferred through its postcodes.`,
				evidence: { source: premisesSet === "all" ? OFCOM_OUTPUT_AREAS_ALL : OFCOM_OUTPUT_AREAS_RESIDENTIAL },
			})
		}
	}

	claims.push(siteFloodRecords(site).claim)

	return claims
}

/**
 * The planned counts of one building's residential units: the LDD row's, then the referral row's.
 */
function siteCounts(site: LondonSite): UnitCount[] {
	const membership = `${site.key}:residential-units`

	const counts: UnitCount[] = [
		{
			id: `${site.key}:planned:ldd`,
			subject: site.building,
			stage: UnitStage.Planned,
			count: site.plannedUnits,
			at: site.permitted,
			membership,
			evidence: { source: site.ldd },
		},
	]

	if (site.referral) {
		counts.push({
			id: `${site.key}:planned:referral`,
			subject: site.building,
			stage: UnitStage.Planned,
			count: site.referral.totalUnits,
			at: site.permitted,
			membership,
			evidence: { source: site.referral.source },
		})
	}

	return counts
}

function siteEntity(site: LondonSite): Entity {
	return {
		id: site.building,
		kind: "building",
		externalIDs: [
			{
				namespace: `${site.authority.toLowerCase()}:planning-application`,
				value: site.reference,
				evidence: { source: site.ldd },
			},
		],
		label: site.label,
	}
}

function siteAlias(site: LondonSite): Alias {
	return { text: site.address, candidates: [{ entity: site.building, evidence: { source: site.ldd } }] }
}

function siteMemberships(site: LondonSite): ExtentMembership[] {
	return [
		{ subject: site.building, extent: `planning-authority:${site.authority}`, evidence: { source: site.ldd } },
		{ subject: site.building, extent: `postcode:${site.postcode}`, evidence: { source: site.ldd } },
	]
}

function siteWindow(site: LondonSite): ConstructionWindow {
	return {
		subject: site.building,
		start: site.started,
		end: site.completed,
		stage: "construction",
		evidence: { source: site.ldd },
	}
}

export const LONDON_RECORDS: DossierRecords = {
	sources: SOURCES,
	entities: LONDON_SITES.map(siteEntity),
	aliases: LONDON_SITES.map(siteAlias),
	containment: [],
	claims: LONDON_SITES.flatMap(siteClaims),
	counts: LONDON_SITES.flatMap(siteCounts),
	events: [],
	relations: [],
	windows: LONDON_SITES.map(siteWindow),
	availability: [],
	readings: LONDON_SITES.map((site) => siteFloodRecords(site).reading),
	filings: [],
	checks: [],
	memberships: LONDON_SITES.flatMap(siteMemberships),
	positions: LONDON_SITES.map(sitePosition),
}

export function londonDossier(records: DossierRecords = LONDON_RECORDS): Dossier {
	return buildDossier(records, { asOf: LONDON_AS_OF })
}
