/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The synthetic shared route of #2288's handoff. Every record and every rate here is invented for the
 *   example. The dossier describes two fictional buildings on one fictional parcel, and the scenario
 *   supplies a synthetic USD rate card and operating assumptions.
 *
 *   The construction figures are the handoff's: a USD 10,000.00 shared segment (400 m at USD 25.00), USD 1,000.00
 *   of mobilization, and branches of USD 2,000.00 for Building A (80 m) and USD 3,000.00 for Building B (120 m).
 *   Example Building A costs USD 13,000.00 on its own and Example Building B USD 14,000.00. The two together
 *   cost USD 16,000.00, and adding B to A costs USD 3,000.00.
 *
 *   The comparison cases, the financing flows and the transaction cases below are the synthetic example's
 *   options, shared by the module tests and the README example.
 */

import {
	buildDossier,
	ContainmentRelation,
	type Dossier,
	type DossierRecords,
	entityID,
	type UnitCount,
	UnitStage,
} from "@mailwoman/dossier"

import {
	type ComparisonCase,
	costOverrunCase,
	delayedAccessCase,
	lowerPriceCase,
	noBuildCase,
	slowerUptakeCase,
	timingCase,
} from "#comparison"
import { type FinancingFlow, FinancingKind } from "#financing"
import type { ScenarioReportOptions } from "#report"
import {
	CostCategory,
	type CostLine,
	type InputBasis,
	InputBasisKind,
	InputOrigin,
	PriceBasis,
	type Scenario,
	type ScheduledAmount,
	TaxTreatmentKind,
} from "#scenario"
import { type TransactionCase, TransactionKind } from "#transactions"

const AS_OF = "2026-09-30"

export const PARCEL = entityID("parcel", "example-route-parcel")
export const BUILDING_A = entityID("building", "example-a")
export const BUILDING_B = entityID("building", "example-b")

export const INSPECTION_SOURCE = "synthetic-inspection-2026"

/**
 * Two completed-unit counts with distinct memberships at one date, so the parcel's 40 units are 24 + 16.
 */
export const UNIT_COUNTS: UnitCount[] = [
	{
		id: "a-completed",
		subject: BUILDING_A,
		stage: UnitStage.Completed,
		count: 24,
		at: "2026-08-01",
		membership: "example-a:all",
		evidence: { source: INSPECTION_SOURCE, observedAt: "2026-08-01", validFrom: null, validTo: null },
	},
	{
		id: "b-completed",
		subject: BUILDING_B,
		stage: UnitStage.Completed,
		count: 16,
		at: "2026-08-01",
		membership: "example-b:all",
		evidence: { source: INSPECTION_SOURCE, observedAt: "2026-08-01", validFrom: null, validTo: null },
	},
]

export const DOSSIER_RECORDS: DossierRecords = {
	sources: [
		{
			id: INSPECTION_SOURCE,
			publisher: "Synthetic example",
			title: "Synthetic completion inspection of Example Building A and Example Building B",
			observedAt: "2026-08-01",
			availableAt: "2026-08-03",
			retrievedAt: AS_OF,
			url: null,
		},
	],
	entities: [
		{
			id: PARCEL,
			kind: "parcel",
			externalIDs: [{ namespace: "example:lot", value: "56-78", evidence: null }],
			label: "Example Route Parcel",
		},
		{
			id: BUILDING_A,
			kind: "building",
			externalIDs: [{ namespace: "example:bin", value: "2001", evidence: null }],
			label: "Example Building A",
		},
		{
			id: BUILDING_B,
			kind: "building",
			externalIDs: [{ namespace: "example:bin", value: "2002", evidence: null }],
			label: "Example Building B",
		},
	],
	aliases: [],
	containment: [
		{
			child: BUILDING_A,
			parent: PARCEL,
			relation: ContainmentRelation.BuildingOn,
			evidence: { source: INSPECTION_SOURCE, observedAt: "2026-08-01", validFrom: null, validTo: null },
		},
		{
			child: BUILDING_B,
			parent: PARCEL,
			relation: ContainmentRelation.BuildingOn,
			evidence: { source: INSPECTION_SOURCE, observedAt: "2026-08-01", validFrom: null, validTo: null },
		},
	],
	claims: [],
	counts: UNIT_COUNTS,
	events: [],
	relations: [],
	windows: [],
	availability: [],
	readings: [],
	filings: [],
}

export function syntheticDossier(records: DossierRecords = DOSSIER_RECORDS): Dossier {
	return buildDossier(records, { asOf: AS_OF })
}

export const SYNTHETIC: InputBasis = {
	kind: InputBasisKind.OperatorAssumption,
	statedBy: "synthetic example for #2288",
}

const SHARED_TRENCH: CostLine = {
	id: "shared-route-trench",
	description: "Underground route from the existing splice point to Example Route Parcel",
	category: CostCategory.OutsidePlant,
	quantity: { value: 400, unit: "m", basis: SYNTHETIC },
	rate: "trench-m",
	month: 1,
}

export const SHARED_ROUTE: Scenario = {
	id: "synthetic-shared-route",
	label: "Synthetic shared route to Example Route Parcel",
	origin: InputOrigin.Synthetic,
	asOf: AS_OF,
	currency: "USD",
	monthZero: "2026-10-01",
	horizonMonths: 48,
	priceBasis: PriceBasis.Nominal,
	taxTreatment: { kind: TaxTreatmentKind.PreTax },
	annualDiscountRateBasisPoints: 1000,
	npvTarget: 0,
	rateCard: {
		id: "synthetic-rates",
		version: "1",
		statedOn: "2026-09-01",
		rates: [
			{ id: "trench-m", description: "Underground route, per meter", unit: "m", amount: 2500, basis: SYNTHETIC },
			{ id: "mobilization", description: "Crew mobilization", unit: "visit", amount: 100_000, basis: SYNTHETIC },
			{ id: "riser-floor", description: "Riser work, per floor", unit: "floor", amount: 30_000, basis: SYNTHETIC },
			{
				id: "electronics-refresh",
				description: "Building electronics refresh",
				unit: "refresh",
				amount: 60_000,
				basis: SYNTHETIC,
			},
			{
				id: "activation",
				description: "Customer activation: drop, terminal and installation",
				unit: "customer",
				amount: 25_000,
				basis: SYNTHETIC,
			},
			{
				id: "acquisition",
				description: "Customer acquisition: sales and marketing",
				unit: "customer",
				amount: 5000,
				basis: SYNTHETIC,
			},
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
			id: "shared-route",
			description: "Shared route from the existing splice point to Example Route Parcel",
			lines: [SHARED_TRENCH],
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
		{
			building: BUILDING_A,
			unitStage: UnitStage.Completed,
			route: ["shared-route"],
			works: [
				{
					id: "a-branch",
					description: "Branch from the shared route to Example Building A",
					category: CostCategory.Connection,
					quantity: { value: 80, unit: "m", basis: SYNTHETIC },
					rate: "trench-m",
					month: 2,
				},
			],
			serviceFromMonth: 3,
			occupancy: [{ fromMonth: 0, units: 24, basis: SYNTHETIC }],
			existingSubscribers: [],
		},
		{
			building: BUILDING_B,
			unitStage: UnitStage.Completed,
			route: ["shared-route"],
			works: [
				{
					id: "b-branch",
					description: "Branch from the shared route to Example Building B",
					category: CostCategory.Connection,
					quantity: { value: 120, unit: "m", basis: SYNTHETIC },
					rate: "trench-m",
					month: 2,
				},
			],
			serviceFromMonth: 3,
			occupancy: [
				{ fromMonth: 0, units: 0, basis: SYNTHETIC },
				{ fromMonth: 4, units: 8, basis: SYNTHETIC },
				{ fromMonth: 8, units: 16, basis: SYNTHETIC },
			],
			existingSubscribers: [],
		},
	],
	selected: [BUILDING_A, BUILDING_B],
	replacements: [
		{
			id: "electronics-refresh",
			description: "Building electronics refresh",
			category: CostCategory.Replacement,
			quantity: { value: 1, unit: "refresh", basis: SYNTHETIC },
			rate: "electronics-refresh",
			month: 36,
		},
	],
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
 * Returns a deep copy of `scenario` after `change` edits it, so a test can remove or alter one input.
 */
export function withChange(scenario: Scenario, change: (draft: Scenario) => void): Scenario {
	const draft = structuredClone(scenario) as Scenario

	change(draft)

	return draft
}

export const CAPEX_RANGE: ScenarioReportOptions["capexRange"] = {
	low: {
		label: "every construction line 10% under the rate card",
		basisPoints: -1000,
		categories: [CostCategory.OutsidePlant, CostCategory.Mobilization, CostCategory.Connection],
	},
	high: { label: "outside plant 25% over the rate card", basisPoints: 2500, categories: [CostCategory.OutsidePlant] },
}

/**
 * The retrofit case connects Example Building B after occupancy: its branch and 4 floors
 * of riser work are paid in month 10, and its service starts in month 11.
 */
const RETROFIT_B: ComparisonCase = timingCase(SHARED_ROUTE, {
	id: "retrofit-b",
	label: "Retrofit timing for Building B",
	assumption:
		"Building B is connected after occupancy: its branch and 4 floors of riser work are paid in month 10, and service starts in month 11",
	plans: [
		{
			building: BUILDING_B,
			serviceFromMonth: 11,
			works: [
				{ ...SHARED_ROUTE.buildings[1]!.works[0]!, month: 10 },
				{
					id: "b-riser",
					description: "Riser work in an occupied building",
					category: CostCategory.Riser,
					quantity: { value: 4, unit: "floor", basis: SYNTHETIC },
					rate: "riser-floor",
					month: 10,
				},
			],
		},
	],
})

export const COMPARISON_CASES: ComparisonCase[] = [
	noBuildCase(),
	delayedAccessCase(SHARED_ROUTE, 6),
	slowerUptakeCase(SHARED_ROUTE, { takeRateBasisPoints: 3000, rampMonths: 8, basis: SYNTHETIC }),
	lowerPriceCase(SHARED_ROUTE, { fromMonth: 12, amount: 4500, basis: SYNTHETIC }),
	costOverrunCase(SHARED_ROUTE, {
		label: "every construction line 30% over the rate card",
		basisPoints: 3000,
		categories: [CostCategory.OutsidePlant, CostCategory.Mobilization, CostCategory.Connection],
	}),
	RETROFIT_B,
]

export function scheduled(
	id: string,
	fromMonth: number,
	toMonth: number,
	amount: number,
	description: string = id
): ScheduledAmount {
	return { id, description, fromMonth, toMonth, amount, basis: SYNTHETIC }
}

export function financingFlow(
	id: string,
	kind: FinancingKind,
	fromMonth: number,
	toMonth: number,
	amount: number,
	description: string = id
): FinancingFlow {
	return { ...scheduled(id, fromMonth, toMonth, amount, description), kind }
}

/**
 * Equity of USD 8,000.00 in month 0, a USD 10,000.00 draw in month 1, a USD 3,000.00 grant in
 * month 2, USD 50.00 of interest in each of months 2 to 48, and four USD 2,500.00 repayments.
 */
export const FINANCING_FLOWS: FinancingFlow[] = [
	financingFlow("equity", FinancingKind.Equity, 0, 0, 800_000, "Synthetic equity contribution"),
	financingFlow("draw", FinancingKind.DebtDraw, 1, 1, 1_000_000, "Synthetic construction loan draw"),
	financingFlow("grant", FinancingKind.Grant, 2, 2, 300_000, "Synthetic build grant"),
	financingFlow("interest", FinancingKind.Interest, 2, 48, 5000, "Synthetic loan interest"),
	financingFlow("repay-1", FinancingKind.DebtRepayment, 12, 12, 250_000, "Synthetic loan repayment"),
	financingFlow("repay-2", FinancingKind.DebtRepayment, 24, 24, 250_000, "Synthetic loan repayment"),
	financingFlow("repay-3", FinancingKind.DebtRepayment, 36, 36, 250_000, "Synthetic loan repayment"),
	financingFlow("repay-4", FinancingKind.DebtRepayment, 48, 48, 250_000, "Synthetic loan repayment"),
]

export function transaction(change: Partial<TransactionCase> & Pick<TransactionCase, "id" | "kind">): TransactionCase {
	return {
		label: change.id,
		integrationMonth: 0,
		obligations: [],
		proceeds: [],
		leasedSegments: [],
		acquiredSubscribers: [],
		basis: SYNTHETIC,
		...change,
	}
}

export const SALVAGE = transaction({
	id: "salvage",
	kind: TransactionKind.Salvage,
	label: "Resale of the building electronics at the end of the horizon",
	integrationMonth: 48,
	proceeds: [scheduled("electronics-resale", 48, 48, 400_000, "Resale value of the building electronics")],
})

export const LEASE = transaction({
	id: "lease-shared-route",
	kind: TransactionKind.Lease,
	label: "Lease of the shared route instead of construction",
	integrationMonth: 1,
	leasedSegments: ["shared-route"],
	obligations: [scheduled("route-lease", 1, 48, 15_000, "Lease payment for the shared route")],
})

export const ACQUISITION = transaction({
	id: "acquire-a",
	kind: TransactionKind.Acquisition,
	label: "Acquisition of 4 subscribers in Building A",
	integrationMonth: 6,
	acquiredSubscribers: [{ building: BUILDING_A, count: 4 }],
	obligations: [scheduled("purchase-price", 6, 6, 160_000, "Purchase price of the acquired subscribers")],
})

export const WHOLESALE = transaction({
	id: "wholesale",
	kind: TransactionKind.Wholesale,
	label: "Wholesale access sold to another provider",
	integrationMonth: 12,
	proceeds: [scheduled("wholesale-fee", 12, 48, 20_000, "Wholesale access fee")],
	obligations: [scheduled("wholesale-port", 12, 48, 2000, "Port cost of the wholesale access")],
})

export const REPORT_OPTIONS: ScenarioReportOptions = {
	capexRange: CAPEX_RANGE,
	cases: COMPARISON_CASES,
	financing: FINANCING_FLOWS,
	transactions: [SALVAGE, LEASE, ACQUISITION, WHOLESALE],
}
