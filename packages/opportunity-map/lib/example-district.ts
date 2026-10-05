/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The synthetic Example District. Every record, position, path, rate and assumption here is invented
 *   for the example, and its coordinates lie in the open South Atlantic, where no building stands.
 *
 *   Seven fictional buildings cover the five building states at the completed stage. Example Building A
 *   has a provider's availability record, Example Building B a surveyed empty fiber reading at its check,
 *   and Example Building C a source-present empty one. Example Garage records zero completed units, and
 *   Example Building E has no completed count. Example Building F lacks a check, a provider record and a
 *   district membership. Two sources place Example Building G in two districts, and two state different
 *   positions for Example Building C.
 *
 *   The scenario plans A, B and C. A and B share a proposed trench. C reaches an existing duct that a
 *   synthetic plant record verifies. Construction costs USD 13,000.00 for A alone, USD 16,000.00 for A
 *   and B, and USD 3,000.00 for C alone.
 */

import {
	buildDossier,
	type Dossier,
	type DossierRecords,
	entityID,
	type EntityID,
	type SourceRecord,
	type UnitCount,
	UnitStage,
} from "@mailwoman/dossier"
import {
	CostCategory,
	type CostLine,
	type InputBasis,
	InputBasisKind,
	InputOrigin,
	PriceBasis,
	type Scenario,
	TaxTreatmentKind,
} from "@mailwoman/route-scenarios"

import type { SegmentPath } from "#routes"

const DISTRICT_AS_OF = "2026-09-30"

/**
 * Example Building A, in `partial_availability`: a provider's availability record covers it.
 */
export const BUILDING_A = entityID("building", "example-a")

/**
 * Example Building B, in `known_unserved`: a surveyed empty reading answers its check.
 */
export const BUILDING_B = entityID("building", "example-b")

/**
 * Example Building C, in `unknown_coverage`: a source-present empty reading answers
 * its check, and two sources state different positions for it.
 */
export const BUILDING_C = entityID("building", "example-c")

/**
 * Example Garage, in `zero_premises`: its completed unit total is 0.
 */
export const GARAGE = entityID("building", "example-garage")

/**
 * Example Building E, in `unknown_unit_count` at the completed stage: it has a planned count only.
 */
export const BUILDING_E = entityID("building", "example-e")

/**
 * Example Building F, in `unknown_coverage`: the records hold no check, provider
 * or district membership for it.
 */
export const BUILDING_F = entityID("building", "example-f")

/**
 * Example Building G, in `unknown_coverage`: two sources place it in two districts.
 */
export const BUILDING_G = entityID("building", "example-g")

/**
 * The synthetic completion inspection: the completed unit counts, available on 2026-08-03.
 */
export const INSPECTION = "synthetic-inspection-2026"

/**
 * The synthetic survey: the positions, memberships and readings, available on 2026-07-20.
 */
export const SURVEY = "synthetic-survey-2026"

/**
 * The synthetic building permit: Example Building E's planned count, available on 2026-03-02.
 */
export const PERMIT = "synthetic-permit-2026"

/**
 * The synthetic availability listing of Example Fiber Co at Example Building A, available on 2026-06-02.
 */
export const LISTING = "synthetic-listing-2026"

/**
 * The synthetic plant record that verifies the existing duct, available on 2026-05-05.
 */
export const PLANT_RECORD = "synthetic-plant-record-2026"

function syntheticSource(id: string, title: string, observedAt: string, availableAt: string): SourceRecord {
	return { id, publisher: "Synthetic example", title, observedAt, availableAt, retrievedAt: DISTRICT_AS_OF }
}

const SOURCES: SourceRecord[] = [
	syntheticSource(INSPECTION, "Synthetic completion inspection of the Example District", "2026-08-01", "2026-08-03"),
	syntheticSource(SURVEY, "Synthetic survey of the Example District", "2026-07-15", "2026-07-20"),
	syntheticSource(PERMIT, "Synthetic new building permit for Example Building E", "2026-03-01", "2026-03-02"),
	syntheticSource(LISTING, "Synthetic availability listing of Example Fiber Co", "2026-06-01", "2026-06-02"),
	syntheticSource(
		PLANT_RECORD,
		"Synthetic plant record of the existing duct on Example Street",
		"2026-05-01",
		"2026-05-05"
	),
]

const LABELS: Record<EntityID, string> = {
	[BUILDING_A]: "Example Building A",
	[BUILDING_B]: "Example Building B",
	[BUILDING_C]: "Example Building C",
	[GARAGE]: "Example Garage",
	[BUILDING_E]: "Example Building E",
	[BUILDING_F]: "Example Building F",
	[BUILDING_G]: "Example Building G",
}

function completed(subject: EntityID, count: number): UnitCount {
	return {
		id: `${subject}:completed`,
		subject,
		stage: UnitStage.Completed,
		count,
		at: "2026-08-01",
		membership: `${subject}:all`,
		evidence: { source: INSPECTION, observedAt: "2026-08-01" },
	}
}

function position(subject: EntityID, latitude: number, longitude: number, source = SURVEY) {
	return { subject, latitude, longitude, synthetic: true, evidence: { source } }
}

function membership(subject: EntityID, extent: string, source = SURVEY) {
	return { subject, extent, evidence: { source } }
}

/**
 * The dossier records of the Example District's seven buildings.
 */
export const DISTRICT_RECORDS: DossierRecords = {
	sources: SOURCES,
	entities: Object.entries(LABELS).map(([id, label]) => ({ id, kind: "building" as const, externalIDs: [], label })),
	aliases: [],
	containment: [],
	claims: [],
	counts: [
		completed(BUILDING_A, 24),
		completed(BUILDING_B, 16),
		completed(BUILDING_C, 30),
		completed(GARAGE, 0),
		{
			id: "e-planned",
			subject: BUILDING_E,
			stage: UnitStage.Planned,
			count: 40,
			at: "2026-03-01",
			membership: `${BUILDING_E}:all`,
			evidence: { source: PERMIT },
		},
		completed(BUILDING_F, 12),
		completed(BUILDING_G, 8),
	],
	events: [],
	relations: [],
	windows: [],
	availability: [
		{
			provider: "Example Fiber Co",
			subject: BUILDING_A,
			product: "fiber 1 Gbps",
			from: "2026-06-01",
			evidence: { source: LISTING },
		},
	],
	readings: [
		{
			layer: "example-fiber",
			extent: "example-cell:b",
			basis: "surveyed",
			surveyedAt: "2026-07-15",
			records: 0,
			evidence: { source: SURVEY },
		},
		{
			layer: "example-fiber",
			extent: "example-cell:c",
			basis: "source_present",
			surveyedAt: "2026-07-15",
			records: 0,
			evidence: { source: SURVEY },
		},
	],
	filings: [],
	checks: [
		{ id: "b-fiber", subject: BUILDING_B, layer: "example-fiber", extent: "example-cell:b" },
		{ id: "c-fiber", subject: BUILDING_C, layer: "example-fiber", extent: "example-cell:c" },
	],
	memberships: [
		membership(BUILDING_A, "example-district:north"),
		membership(BUILDING_B, "example-district:north"),
		membership(BUILDING_B, "example-cell:b"),
		membership(BUILDING_C, "example-district:south"),
		membership(BUILDING_C, "example-cell:c"),
		membership(GARAGE, "example-district:south"),
		membership(BUILDING_E, "example-district:north"),
		membership(BUILDING_G, "example-district:north"),
		membership(BUILDING_G, "example-district:south", INSPECTION),
	],
	positions: [
		position(BUILDING_A, -30.01, -20.01),
		position(BUILDING_B, -30.0102, -20.0104),
		position(BUILDING_C, -30.012, -20.011),
		position(BUILDING_C, -30.0121, -20.0113, INSPECTION),
		position(GARAGE, -30.0123, -20.0101),
		position(BUILDING_E, -30.0098, -20.0107),
		position(BUILDING_F, -30.014, -20.014),
		position(BUILDING_G, -30.011, -20.0105),
	],
}

export function districtDossier(records: DossierRecords = DISTRICT_RECORDS): Dossier {
	return buildDossier(records, { asOf: DISTRICT_AS_OF })
}

/**
 * The basis of every invented rate, quantity and assumption of the scenario.
 */
export const SYNTHETIC: InputBasis = {
	kind: InputBasisKind.OperatorAssumption,
	statedBy: "synthetic example for #2289",
}

const PLANT: InputBasis = { kind: InputBasisKind.SourceRecord, source: PLANT_RECORD }

function branch(id: string, building: EntityID, meters: number): CostLine {
	return {
		id,
		description: `Branch to ${LABELS[building]}`,
		category: CostCategory.Connection,
		quantity: { value: meters, unit: "m", basis: SYNTHETIC },
		rate: "trench-m",
		month: 2,
	}
}

function plan(building: EntityID, route: readonly string[], works: CostLine, units: number) {
	return {
		building,
		unitStage: UnitStage.Completed,
		route,
		works: [works],
		serviceFromMonth: 3,
		occupancy: [{ fromMonth: 0, units, basis: SYNTHETIC }],
		existingSubscribers: [],
	}
}

/**
 * The synthetic scenario that plans Example Buildings A, B and C over the
 * shared trench and the existing duct.
 */
export const DISTRICT_SCENARIO: Scenario = {
	id: "synthetic-example-district",
	label: "Synthetic routes in the Example District",
	origin: InputOrigin.Synthetic,
	asOf: DISTRICT_AS_OF,
	currency: "USD",
	monthZero: "2026-10-01",
	horizonMonths: 48,
	priceBasis: PriceBasis.Nominal,
	taxTreatment: { kind: TaxTreatmentKind.PreTax },
	annualDiscountRateBasisPoints: 1000,
	npvTarget: 0,
	rateCard: {
		id: "synthetic-district-rates",
		version: "1",
		statedOn: "2026-09-01",
		rates: [
			{ id: "trench-m", description: "Underground route, per meter", unit: "m", amount: 2500, basis: SYNTHETIC },
			{ id: "pull-m", description: "Cable pulled through a duct, per meter", unit: "m", amount: 500, basis: SYNTHETIC },
			{ id: "mobilization", description: "Crew mobilization", unit: "visit", amount: 100_000, basis: SYNTHETIC },
			{ id: "activation", description: "Customer activation", unit: "customer", amount: 25_000, basis: SYNTHETIC },
			{ id: "acquisition", description: "Customer acquisition", unit: "customer", amount: 5000, basis: SYNTHETIC },
			{
				id: "service",
				description: "Service cost per active subscriber",
				unit: "subscriber-month",
				amount: 1000,
				basis: SYNTHETIC,
			},
			{ id: "maintenance", description: "Network maintenance", unit: "month", amount: 4000, basis: SYNTHETIC },
		],
	},
	segments: [
		{
			id: "shared-trench",
			description: "Proposed trench from the splice point to Example Buildings A and B",
			lines: [
				{
					id: "shared-trench-line",
					description: "Underground route from the splice point",
					category: CostCategory.OutsidePlant,
					quantity: { value: 400, unit: "m", basis: SYNTHETIC },
					rate: "trench-m",
					month: 1,
				},
			],
		},
		{
			id: "existing-duct",
			description: "Cable through the existing duct on Example Street to Example Building C",
			lines: [
				{
					id: "existing-duct-pull",
					description: "Cable pulled through the existing duct",
					category: CostCategory.OutsidePlant,
					quantity: { value: 200, unit: "m", basis: PLANT },
					rate: "pull-m",
					month: 1,
				},
			],
		},
	],
	projectCosts: [
		{
			id: "mobilization",
			description: "Crew mobilization",
			category: CostCategory.Mobilization,
			quantity: { value: 1, unit: "visit", basis: SYNTHETIC },
			rate: "mobilization",
			month: 1,
		},
	],
	buildings: [
		plan(BUILDING_A, ["shared-trench"], branch("a-branch", BUILDING_A, 80), 24),
		plan(BUILDING_B, ["shared-trench"], branch("b-branch", BUILDING_B, 120), 16),
		plan(BUILDING_C, ["existing-duct"], branch("c-branch", BUILDING_C, 40), 30),
	],
	selected: [BUILDING_A, BUILDING_B, BUILDING_C],
	replacements: [],
	workingCapital: [{ fromMonth: 3, balance: 20_000, basis: SYNTHETIC }],
	operating: {
		prices: [{ fromMonth: 0, amount: 5500, basis: SYNTHETIC }],
		promotion: { basisPoints: 10_000, basis: SYNTHETIC },
		activationRate: "activation",
		acquisitionRate: "acquisition",
		serviceRate: "service",
		maintenance: { rate: "maintenance", fromMonth: 3 },
		uptake: { takeRateBasisPoints: 5000, rampMonths: 4, basis: SYNTHETIC },
		monthlyChurn: { basisPoints: 200, basis: SYNTHETIC },
	},
	costAdjustment: null,
	extraSpendMonth: 1,
	takeRateMonth: 24,
}

/**
 * Synthetic paths for the scenario's two segments.
 *
 * The plant record verifies the existing duct, and the trench is the operator's proposal.
 */
export const SEGMENT_PATHS: SegmentPath[] = [
	{
		segment: "shared-trench",
		coordinates: [
			[-20.009, -30.0095],
			[-20.01, -30.0099],
			[-20.0103, -30.0101],
		],
		basis: SYNTHETIC,
		synthetic: true,
	},
	{
		segment: "existing-duct",
		coordinates: [
			[-20.009, -30.0095],
			[-20.0105, -30.0118],
			[-20.011, -30.012],
		],
		basis: PLANT,
		synthetic: true,
	},
]
