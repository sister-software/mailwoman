/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The inputs of a shared-route scenario and the validation that refuses an incomplete one.
 *
 *   A scenario states its as-of date, currency, month zero, horizon, price basis, tax treatment, annual
 *   discount rate, the buildings it selects, the route segments those buildings need, the works each
 *   building needs, the monthly operating assumptions and a versioned rate card. Every rate, quantity,
 *   price and occupancy figure states its basis: an admitted source record or an operator's stated
 *   assumption.
 *
 *   The pilot route is an assumption until a source verifies the topology. A building's `route` lists the
 *   segments its connection is assumed to need, and the calculator draws no route from proximity.
 *
 *   Validation throws {@link ScenarioInputError} for the first incomplete or malformed input it finds. The
 *   error's `input` gives the kind of input, and its `path` gives the input's location in the scenario.
 */

import {
	compareISODate,
	type EntityID,
	isISODate,
	type ISODate,
	type SourceRecordID,
	UnitStage,
} from "@mailwoman/dossier"

import { BASIS_POINTS_PER_WHOLE, currencyMinorDigits, type MinorUnits } from "#money"

/**
 * The two kinds of basis an input value can have, as wire values.
 */
export const InputBasisKind = {
	SourceRecord: "source_record",
	OperatorAssumption: "operator_assumption",
} as const

export type InputBasisKind = (typeof InputBasisKind)[keyof typeof InputBasisKind]

/**
 * Where an input value came from.
 *
 * A source record must be admitted in the dossier the scenario reads.
 */
export type InputBasis =
	| { kind: typeof InputBasisKind.SourceRecord; source: SourceRecordID }
	| { kind: typeof InputBasisKind.OperatorAssumption; statedBy: string }

/**
 * Whether a scenario's inputs are invented for an example or supplied by an operator.
 */
export const InputOrigin = {
	Synthetic: "synthetic",
	OperatorSupplied: "operator_supplied",
} as const

export type InputOrigin = (typeof InputOrigin)[keyof typeof InputOrigin]

/**
 * Whether amounts are stated in money of each month (nominal) or in constant money (real).
 *
 * The discount rate must be stated on the same basis.
 * The calculator applies no inflation in either case.
 */
export const PriceBasis = {
	Nominal: "nominal",
	Real: "real",
} as const

export type PriceBasis = (typeof PriceBasis)[keyof typeof PriceBasis]

/**
 * How a scenario treats tax, as wire values.
 *
 * `pre_tax` holds the tax column at zero, and `stated_payments` takes the
 * operator's stated payments month by month.
 * The calculator computes no tax liability.
 */
export const TaxTreatmentKind = {
	PreTax: "pre_tax",
	StatedPayments: "stated_payments",
} as const

export type TaxTreatmentKind = (typeof TaxTreatmentKind)[keyof typeof TaxTreatmentKind]

/**
 * The categories of a cost line, as wire values.
 */
export const CostCategory = {
	OutsidePlant: "outside_plant",
	Connection: "connection",
	Entrance: "entrance",
	Riser: "riser",
	Capacity: "capacity",
	Permit: "permit",
	Mobilization: "mobilization",
	Engineering: "engineering",
	Replacement: "replacement",
} as const

export type CostCategory = (typeof CostCategory)[keyof typeof CostCategory]

/**
 * The unit each operating rate must be stated in, because the calculator multiplies it by that count.
 */
export const OperatingRateUnit = {
	Activation: "customer",
	Acquisition: "customer",
	Service: "subscriber-month",
	Maintenance: "month",
} as const

export interface Rate {
	id: string
	description: string
	/**
	 * The unit the amount is charged per, such as `m`, `each` or `customer`.
	 */
	unit: string
	/**
	 * Minor units per unit.
	 */
	amount: MinorUnits
	basis: InputBasis
}

export interface RateCard {
	id: string
	version: string
	/**
	 * The date the operator stated these rates.
	 * It must fall on or before the scenario's as-of date.
	 */
	statedOn: ISODate
	rates: readonly Rate[]
}

export interface Quantity {
	/**
	 * A whole count of `unit`.
	 * A fractional length is stated in a smaller unit.
	 */
	value: number
	unit: string
	basis: InputBasis
}

/**
 * One priced item: a quantity charged at a rate from the rate card, paid in one month.
 */
export interface CostLine {
	id: string
	description: string
	category: CostCategory
	quantity: Quantity
	/**
	 * The identifier of a rate in the scenario's rate card.
	 */
	rate: string
	/**
	 * The month the line is paid, counted from month zero.
	 */
	month: number
}

/**
 * A stretch of route with a stable identifier.
 * A selection pays for each distinct segment once.
 */
export interface RouteSegment {
	id: string
	description: string
	lines: readonly CostLine[]
}

/**
 * The number of occupied eligible units from a month on, until the next step.
 */
export interface OccupancyStep {
	fromMonth: number
	units: number
	basis: InputBasis
}

/**
 * Subscribers the operator already serves in a building, joining the scenario's network in a month.
 * They take no activation, acquisition or promotion cost.
 */
export interface ExistingSubscribers {
	month: number
	count: number
	basis: InputBasis
}

export interface BuildingPlan {
	/**
	 * A building identifier in the dossier the scenario reads.
	 */
	building: EntityID
	/**
	 * The dossier unit total that bounds the building's eligible units.
	 */
	unitStage: UnitStage
	/**
	 * The route segments this building's connection is assumed to need.
	 */
	route: readonly string[]
	/**
	 * The building's own connection, entrance, riser, capacity and permit lines.
	 */
	works: readonly CostLine[]
	/**
	 * The first month in which a customer in the building can be activated.
	 */
	serviceFromMonth: number
	occupancy: readonly OccupancyStep[]
	existingSubscribers: readonly ExistingSubscribers[]
}

/**
 * An amount that applies from a month on, until the next step.
 */
export interface AmountStep {
	fromMonth: number
	amount: MinorUnits
	basis: InputBasis
}

export interface StatedPercentage {
	basisPoints: number
	basis: InputBasis
}

/**
 * How activations reach the take rate.
 *
 * From a building's first service month, its target of active subscribers rises in equal
 * steps over `rampMonths` months to the take rate of its occupied units.
 * The target then stays at that rate, and new activations replace churned subscribers.
 */
export interface Uptake {
	takeRateBasisPoints: number
	rampMonths: number
	basis: InputBasis
}

export interface OperatingAssumptions {
	/**
	 * The monthly price per subscriber, with the first step at month 0.
	 */
	prices: readonly AmountStep[]
	/**
	 * The share of the activation month's price credited to each new subscriber in that month.
	 * 10,000 basis points make the first month free, and the credit follows any change of price.
	 */
	promotion: StatedPercentage
	/**
	 * Rate identifiers, each charged per new activation in its month.
	 */
	activationRate: string
	acquisitionRate: string
	/**
	 * A rate identifier charged per active subscriber per month.
	 */
	serviceRate: string
	/**
	 * A rate identifier charged per month from `fromMonth` on.
	 */
	maintenance: { rate: string; fromMonth: number }
	uptake: Uptake
	monthlyChurn: StatedPercentage
}

/**
 * An amount paid or received in each month from `fromMonth` through `toMonth`.
 */
export interface ScheduledAmount {
	id: string
	description: string
	fromMonth: number
	toMonth: number
	amount: MinorUnits
	basis: InputBasis
}

export type TaxTreatment =
	| { kind: typeof TaxTreatmentKind.PreTax }
	| { kind: typeof TaxTreatmentKind.StatedPayments; payments: readonly ScheduledAmount[] }

/**
 * The working capital the project holds from a month on, until the next step.
 * An increase is a cash outflow.
 */
export interface WorkingCapitalStep {
	fromMonth: number
	balance: MinorUnits
	basis: InputBasis
}

/**
 * A labeled change to the cost lines of the listed categories, in basis points.
 * A 25 percent overrun is 2,500.
 */
export interface CostAdjustment {
	label: string
	basisPoints: number
	categories: readonly CostCategory[]
}

export interface Scenario {
	id: string
	label: string
	origin: InputOrigin
	asOf: ISODate
	/**
	 * An ISO 4217 code.
	 * Every amount is in this currency's minor unit.
	 */
	currency: string
	/**
	 * The calendar month of this date is month 0.
	 */
	monthZero: ISODate
	/**
	 * The last month of the table.
	 * Rows run from month 0 through this month.
	 */
	horizonMonths: number
	priceBasis: PriceBasis
	taxTreatment: TaxTreatment
	/**
	 * The effective annual discount rate.
	 */
	annualDiscountRateBasisPoints: number
	/**
	 * The NPV the decision outputs measure against.
	 */
	npvTarget: MinorUnits
	rateCard: RateCard
	segments: readonly RouteSegment[]
	/**
	 * Mobilization and shared engineering, charged once when any building is selected.
	 */
	projectCosts: readonly CostLine[]
	/**
	 * Plans for the selected buildings and for any building the report adds to the selection.
	 */
	buildings: readonly BuildingPlan[]
	selected: readonly EntityID[]
	replacements: readonly CostLine[]
	workingCapital: readonly WorkingCapitalStep[]
	operating: OperatingAssumptions
	costAdjustment: CostAdjustment | null
	/**
	 * The month in which the affordable extra construction spend is paid.
	 */
	extraSpendMonth: number
	/**
	 * The month at which the take rate is measured.
	 */
	takeRateMonth: number
}

/**
 * The kinds of input a {@link ScenarioInputError} can name, as wire values.
 */
export const ScenarioInput = {
	Rate: "rate",
	Unit: "unit",
	Date: "date",
	Building: "building",
	Quantity: "quantity",
	Amount: "amount",
	Month: "month",
	Percentage: "percentage",
	Identifier: "identifier",
	Category: "category",
	Currency: "currency",
	Basis: "basis",
	Segment: "segment",
	Occupancy: "occupancy",
	Subscribers: "subscribers",
	Convention: "convention",
	Field: "field",
} as const

export type ScenarioInput = (typeof ScenarioInput)[keyof typeof ScenarioInput]

/**
 * An input the calculator cannot use.
 *
 * `input` gives its kind, and `path` gives its location in the scenario.
 */
export class ScenarioInputError extends Error {
	readonly input: ScenarioInput
	readonly path: string

	constructor(input: ScenarioInput, path: string, message: string) {
		super(`${path}: ${message}`)
		this.name = "ScenarioInputError"
		this.input = input
		this.path = path
	}
}

/**
 * Throws a {@link ScenarioInputError} for the input of kind `input` at `path`, with `message`.
 */
export function fail(input: ScenarioInput, path: string, message: string): never {
	throw new ScenarioInputError(input, path, message)
}

/**
 * Returns the last step whose `fromMonth` is at or before `month`.
 *
 * A schedule validated here starts at month 0, so every month in the horizon has a step.
 */
export function stepAt<T extends { fromMonth: number }>(steps: readonly T[], month: number): T {
	let found: T | undefined

	for (const step of steps)
		if (step.fromMonth <= month) {
			found = step
		}

	if (found === undefined) throw new RangeError(`stepAt: no step covers month ${month}`)

	return found
}

/**
 * Returns the sum of the scheduled amounts whose month range includes `month`.
 */
export function amountInMonth(entries: readonly ScheduledAmount[], month: number): MinorUnits {
	let total = 0

	for (const entry of entries)
		if (entry.fromMonth <= month && month <= entry.toMonth) {
			total += entry.amount
		}

	return total
}

/**
 * Returns the plan for `building`, or throws when the scenario has none.
 */
export function buildingPlan(scenario: Scenario, building: EntityID): BuildingPlan {
	const plan = scenario.buildings.find((entry) => entry.building === building)

	if (!plan)
		throw new ScenarioInputError(
			ScenarioInput.Building,
			building,
			`scenario ${scenario.id} has no plan for ${building}`
		)

	return plan
}

/**
 * Returns the rate with `id` from the scenario's rate card.
 * Validation guarantees that every referenced rate exists.
 */
export function rateFor(scenario: Scenario, id: string): Rate {
	const rate = scenario.rateCard.rates.find((entry) => entry.id === id)

	if (!rate)
		throw new ScenarioInputError(ScenarioInput.Rate, id, `rate card ${scenario.rateCard.id} has no rate "${id}"`)

	return rate
}

/**
 * The object and list fields a scenario must supply before any of their contents can be checked.
 */
const REQUIRED_OBJECTS = [
	"rateCard",
	"segments",
	"projectCosts",
	"buildings",
	"selected",
	"replacements",
	"workingCapital",
	"operating",
	"taxTreatment",
] as const satisfies readonly (keyof Scenario)[]

const KNOWN_CATEGORIES: ReadonlySet<string> = new Set(Object.values(CostCategory))
const KNOWN_STAGES: ReadonlySet<string> = new Set(Object.values(UnitStage))

function requireText(value: unknown, input: ScenarioInput, path: string, what: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		fail(input, path, `${what} is missing`)
	}

	return value
}

function requireDate(value: unknown, path: string): ISODate {
	const text = requireText(value, ScenarioInput.Date, path, "the date")

	if (text.length !== 10 || !isISODate(text)) {
		fail(ScenarioInput.Date, path, `${text} is not a YYYY-MM-DD date`)
	}

	// `isISODate` refuses month 00, month 13 and day 00 but admits a day past
	// the month's end, such as 2026-02-30.
	// Day 0 of the following month is the last day of this one.
	const [year, month, day] = text.split("-").map(Number)
	const daysInMonth = new Date(Date.UTC(year!, month!, 0)).getUTCDate()

	if (day! > daysInMonth) {
		fail(ScenarioInput.Date, path, `${text} is not a calendar date`)
	}

	return text
}

function requireWholeNumber(
	value: unknown,
	input: ScenarioInput,
	path: string,
	minimum: number,
	maximum?: number
): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value)) {
		fail(input, path, `${String(value)} is not a whole number`)
	}

	if (value < minimum) {
		fail(input, path, `${value} is below ${minimum}`)
	}

	if (maximum !== undefined && value > maximum) {
		fail(input, path, `${value} is above ${maximum}`)
	}

	return value
}

function requireMonth(value: unknown, path: string, horizon: number): number {
	return requireWholeNumber(value, ScenarioInput.Month, path, 0, horizon)
}

/**
 * Checks one basis: its kind, and the source record or the party that stated the assumption.
 */
export function checkBasis(basis: unknown, path: string): void {
	if (typeof basis !== "object" || basis === null) {
		fail(ScenarioInput.Basis, path, "the basis is missing")
	}

	const candidate = basis as { kind?: unknown; source?: unknown; statedBy?: unknown }

	if (candidate.kind === InputBasisKind.SourceRecord) {
		requireText(candidate.source, ScenarioInput.Basis, `${path}.source`, "the source record")

		return
	}

	if (candidate.kind === InputBasisKind.OperatorAssumption) {
		requireText(candidate.statedBy, ScenarioInput.Basis, `${path}.statedBy`, "the party that stated the assumption")

		return
	}

	fail(
		ScenarioInput.Basis,
		`${path}.kind`,
		`${String(candidate.kind)} is neither a source record nor an operator assumption`
	)
}

/**
 * Every basis in a scenario with its path, for checks that read the dossier.
 */
export function scenarioBases(scenario: Scenario): readonly { path: string; basis: InputBasis }[] {
	const found: { path: string; basis: InputBasis }[] = []

	const line = (path: string, entry: CostLine) =>
		found.push({ path: `${path}.quantity.basis`, basis: entry.quantity.basis })

	for (const rate of scenario.rateCard.rates) {
		found.push({ path: `rateCard.rates[${rate.id}].basis`, basis: rate.basis })
	}

	for (const segment of scenario.segments) {
		for (const entry of segment.lines) {
			line(`segments[${segment.id}].lines[${entry.id}]`, entry)
		}
	}

	for (const entry of scenario.projectCosts) {
		line(`projectCosts[${entry.id}]`, entry)
	}

	for (const entry of scenario.replacements) {
		line(`replacements[${entry.id}]`, entry)
	}

	for (const plan of scenario.buildings) {
		for (const entry of plan.works) {
			line(`buildings[${plan.building}].works[${entry.id}]`, entry)
		}

		plan.occupancy.forEach((step, index) =>
			found.push({ path: `buildings[${plan.building}].occupancy[${index}].basis`, basis: step.basis })
		)

		plan.existingSubscribers.forEach((entry, index) =>
			found.push({ path: `buildings[${plan.building}].existingSubscribers[${index}].basis`, basis: entry.basis })
		)
	}

	scenario.workingCapital.forEach((step, index) =>
		found.push({ path: `workingCapital[${index}].basis`, basis: step.basis })
	)

	scenario.operating.prices.forEach((step, index) =>
		found.push({ path: `operating.prices[${index}].basis`, basis: step.basis })
	)

	found.push(
		{ path: "operating.promotion.basis", basis: scenario.operating.promotion.basis },
		{ path: "operating.uptake.basis", basis: scenario.operating.uptake.basis },
		{ path: "operating.monthlyChurn.basis", basis: scenario.operating.monthlyChurn.basis }
	)

	if (scenario.taxTreatment.kind === TaxTreatmentKind.StatedPayments) {
		for (const payment of scenario.taxTreatment.payments) {
			found.push({ path: `taxTreatment.payments[${payment.id}].basis`, basis: payment.basis })
		}
	}

	return found
}

/**
 * Checks a list of scheduled amounts: identifiers unique within `seen`,
 * a month range inside the horizon, a whole amount and a basis.
 */
export function checkScheduledAmounts(
	entries: readonly ScheduledAmount[],
	path: string,
	horizon: number,
	seen: Set<string>,
	options: { minimum: number } = { minimum: 0 }
): void {
	for (const [index, entry] of entries.entries()) {
		const id = requireText(entry.id, ScenarioInput.Identifier, `${path}[${index}].id`, "the identifier")
		const at = `${path}[${id}]`

		if (seen.has(id)) {
			fail(ScenarioInput.Identifier, at, `the identifier ${id} appears twice`)
		}

		seen.add(id)
		requireText(entry.description, ScenarioInput.Field, `${at}.description`, "the description")
		const from = requireMonth(entry.fromMonth, `${at}.fromMonth`, horizon)
		requireWholeNumber(entry.toMonth, ScenarioInput.Month, `${at}.toMonth`, from, horizon)
		requireWholeNumber(entry.amount, ScenarioInput.Amount, `${at}.amount`, options.minimum)
		checkBasis(entry.basis, `${at}.basis`)
	}
}

function checkLine(
	entry: CostLine,
	path: string,
	scenario: Scenario,
	rates: ReadonlyMap<string, Rate>,
	seen: Set<string>
): void {
	const id = requireText(entry.id, ScenarioInput.Identifier, path, "the cost line identifier")

	if (seen.has(id)) {
		fail(ScenarioInput.Identifier, path, `the cost line identifier ${id} appears twice`)
	}

	seen.add(id)
	requireText(entry.description, ScenarioInput.Field, `${path}.description`, "the description")

	if (!KNOWN_CATEGORIES.has(entry.category)) {
		fail(ScenarioInput.Category, `${path}.category`, `${String(entry.category)} is not a cost category`)
	}

	if (typeof entry.quantity !== "object" || entry.quantity === null) {
		fail(ScenarioInput.Quantity, `${path}.quantity`, "the quantity is missing")
	}

	requireWholeNumber(entry.quantity.value, ScenarioInput.Quantity, `${path}.quantity.value`, 0)
	const unit = requireText(entry.quantity.unit, ScenarioInput.Unit, `${path}.quantity.unit`, "the unit")
	checkBasis(entry.quantity.basis, `${path}.quantity.basis`)
	const rateID = requireText(entry.rate, ScenarioInput.Rate, `${path}.rate`, "the rate")
	const rate = rates.get(rateID)

	if (!rate) {
		fail(
			ScenarioInput.Rate,
			`${path}.rate`,
			`rate card ${scenario.rateCard.id} version ${scenario.rateCard.version} has no rate "${rateID}"`
		)
	}

	if (rate.unit !== unit) {
		fail(
			ScenarioInput.Unit,
			`${path}.quantity.unit`,
			`the quantity is in "${unit}" and rate ${rate.id} is per "${rate.unit}"`
		)
	}

	requireMonth(entry.month, `${path}.month`, scenario.horizonMonths)
}

function checkSteps(
	steps: readonly { fromMonth: number; basis: InputBasis }[],
	path: string,
	input: ScenarioInput,
	horizon: number,
	options: { startsAtZero: boolean }
): void {
	let previous = -1

	for (const [index, step] of steps.entries()) {
		const at = `${path}[${index}]`
		const from = requireWholeNumber(step.fromMonth, ScenarioInput.Month, `${at}.fromMonth`, 0, horizon)

		if (index === 0 && options.startsAtZero && from !== 0) {
			fail(
				input,
				`${at}.fromMonth`,
				`the first step starts at month ${from}, which leaves months 0 to ${from - 1} unstated`
			)
		}

		if (from <= previous) {
			fail(input, `${at}.fromMonth`, `month ${from} does not follow month ${previous}`)
		}

		previous = from
		checkBasis(step.basis, `${at}.basis`)
	}
}

function checkOperatingRate(path: string, rateID: unknown, rates: ReadonlyMap<string, Rate>, unit: string): void {
	const id = requireText(rateID, ScenarioInput.Rate, path, "the rate")
	const rate = rates.get(id)

	if (!rate) {
		fail(ScenarioInput.Rate, path, `the rate card has no rate "${id}"`)
	}

	if (rate.unit !== unit) {
		fail(ScenarioInput.Unit, path, `rate ${id} is per "${rate.unit}" and this assumption is charged per "${unit}"`)
	}
}

/**
 * Checks the rate card's identity and date, and each rate's unit, amount and basis.
 * Returns the rates by identifier.
 */
function checkRateCard(card: RateCard, asOf: ISODate): ReadonlyMap<string, Rate> {
	requireText(card.id, ScenarioInput.Identifier, "rateCard.id", "the rate card identifier")
	requireText(card.version, ScenarioInput.Identifier, "rateCard.version", "the rate card version")
	const statedOn = requireDate(card.statedOn, "rateCard.statedOn")

	if (compareISODate(statedOn, asOf) > 0) {
		fail(
			ScenarioInput.Date,
			"rateCard.statedOn",
			`the rate card is stated on ${statedOn}, after the as-of date ${asOf}`
		)
	}

	const rates = new Map<string, Rate>()

	for (const [index, rate] of card.rates.entries()) {
		const id = requireText(rate.id, ScenarioInput.Identifier, `rateCard.rates[${index}].id`, "the rate identifier")

		if (rates.has(id)) {
			fail(ScenarioInput.Identifier, `rateCard.rates[${id}]`, `the rate identifier ${id} appears twice`)
		}

		requireText(rate.unit, ScenarioInput.Unit, `rateCard.rates[${id}].unit`, "the unit")
		requireWholeNumber(rate.amount, ScenarioInput.Rate, `rateCard.rates[${id}].amount`, 0)
		checkBasis(rate.basis, `rateCard.rates[${id}].basis`)
		rates.set(id, rate)
	}

	return rates
}

/**
 * Checks one building plan: its unit stage, route, works, first service month,
 * occupancy and existing subscribers.
 */
function checkPlan(
	plan: BuildingPlan,
	context: {
		scenario: Scenario
		rates: ReadonlyMap<string, Rate>
		lines: Set<string>
		segments: ReadonlySet<string>
	}
): void {
	const { scenario, rates, lines, segments } = context
	const horizon = scenario.horizonMonths
	const at = `buildings[${plan.building}]`

	if (!KNOWN_STAGES.has(plan.unitStage)) {
		fail(ScenarioInput.Field, `${at}.unitStage`, `${String(plan.unitStage)} is not a unit stage`)
	}

	const route = new Set<string>()

	for (const [position, segment] of plan.route.entries()) {
		if (!segments.has(segment)) {
			fail(ScenarioInput.Segment, `${at}.route[${position}]`, `the segment ${segment} is not defined`)
		}

		if (route.has(segment)) {
			fail(ScenarioInput.Segment, `${at}.route[${position}]`, `the segment ${segment} is listed twice`)
		}

		route.add(segment)
	}

	for (const entry of plan.works) {
		checkLine(entry, `${at}.works[${entry.id}]`, scenario, rates, lines)
	}

	requireWholeNumber(plan.serviceFromMonth, ScenarioInput.Month, `${at}.serviceFromMonth`, 0)

	if (!plan.occupancy.length) {
		fail(ScenarioInput.Occupancy, `${at}.occupancy`, "the occupancy schedule is missing")
	}

	checkSteps(plan.occupancy, `${at}.occupancy`, ScenarioInput.Occupancy, horizon, { startsAtZero: true })
	let occupied = 0

	for (const [position, step] of plan.occupancy.entries()) {
		const units = requireWholeNumber(step.units, ScenarioInput.Occupancy, `${at}.occupancy[${position}].units`, 0)

		if (units < occupied) {
			fail(
				ScenarioInput.Occupancy,
				`${at}.occupancy[${position}].units`,
				`occupancy falls from ${occupied} to ${units} units`
			)
		}

		occupied = units
	}

	for (const [position, entry] of plan.existingSubscribers.entries()) {
		requireMonth(entry.month, `${at}.existingSubscribers[${position}].month`, horizon)
		requireWholeNumber(entry.count, ScenarioInput.Subscribers, `${at}.existingSubscribers[${position}].count`, 1)
		checkBasis(entry.basis, `${at}.existingSubscribers[${position}].basis`)
	}
}

/**
 * Checks the operating assumptions: the price schedule, the promotion, the four operating rates
 * and their units, the maintenance start, the uptake and the churn.
 */
function checkOperating(operating: OperatingAssumptions, rates: ReadonlyMap<string, Rate>, horizon: number): void {
	if (!operating.prices.length) {
		fail(ScenarioInput.Amount, "operating.prices", "the price schedule is missing")
	}

	checkSteps(operating.prices, "operating.prices", ScenarioInput.Amount, horizon, { startsAtZero: true })

	for (const [index, step] of operating.prices.entries()) {
		requireWholeNumber(step.amount, ScenarioInput.Amount, `operating.prices[${index}].amount`, 0)
	}

	const percentage = (value: number, path: string) =>
		requireWholeNumber(value, ScenarioInput.Percentage, path, 0, BASIS_POINTS_PER_WHOLE)

	percentage(operating.promotion.basisPoints, "operating.promotion.basisPoints")
	checkBasis(operating.promotion.basis, "operating.promotion.basis")
	checkOperatingRate("operating.activationRate", operating.activationRate, rates, OperatingRateUnit.Activation)
	checkOperatingRate("operating.acquisitionRate", operating.acquisitionRate, rates, OperatingRateUnit.Acquisition)
	checkOperatingRate("operating.serviceRate", operating.serviceRate, rates, OperatingRateUnit.Service)
	checkOperatingRate("operating.maintenance.rate", operating.maintenance.rate, rates, OperatingRateUnit.Maintenance)
	requireMonth(operating.maintenance.fromMonth, "operating.maintenance.fromMonth", horizon)
	percentage(operating.uptake.takeRateBasisPoints, "operating.uptake.takeRateBasisPoints")
	requireWholeNumber(operating.uptake.rampMonths, ScenarioInput.Month, "operating.uptake.rampMonths", 1)
	checkBasis(operating.uptake.basis, "operating.uptake.basis")
	percentage(operating.monthlyChurn.basisPoints, "operating.monthlyChurn.basisPoints")
	checkBasis(operating.monthlyChurn.basis, "operating.monthlyChurn.basis")
}

/**
 * Throws a {@link ScenarioInputError} for the first missing or malformed input in `scenario`.
 *
 * The checks that need the dossier (the as-of date, building identity, admitted sources and unit totals)
 * run in `prepareScenario`.
 */
export function validateScenario(scenario: Scenario): void {
	for (const field of REQUIRED_OBJECTS) {
		if (scenario[field] === undefined || scenario[field] === null) {
			fail(ScenarioInput.Field, field, `the ${field} field is missing`)
		}
	}

	if (scenario.costAdjustment === undefined) {
		fail(ScenarioInput.Field, "costAdjustment", "the cost adjustment is missing. State null for no adjustment")
	}

	requireText(scenario.id, ScenarioInput.Identifier, "id", "the scenario identifier")
	requireText(scenario.label, ScenarioInput.Field, "label", "the label")

	if (!Object.values(InputOrigin).includes(scenario.origin)) {
		fail(ScenarioInput.Field, "origin", `${String(scenario.origin)} is neither synthetic nor operator supplied`)
	}

	const asOf = requireDate(scenario.asOf, "asOf")
	requireDate(scenario.monthZero, "monthZero")

	try {
		currencyMinorDigits(scenario.currency)
	} catch (error) {
		fail(ScenarioInput.Currency, "currency", (error as Error).message)
	}

	const horizon = requireWholeNumber(scenario.horizonMonths, ScenarioInput.Month, "horizonMonths", 1)

	if (!Object.values(PriceBasis).includes(scenario.priceBasis)) {
		fail(ScenarioInput.Field, "priceBasis", `${String(scenario.priceBasis)} is neither nominal nor real`)
	}

	requireWholeNumber(
		scenario.annualDiscountRateBasisPoints,
		ScenarioInput.Percentage,
		"annualDiscountRateBasisPoints",
		0
	)

	requireWholeNumber(scenario.npvTarget, ScenarioInput.Amount, "npvTarget", Number.MIN_SAFE_INTEGER)

	const rates = checkRateCard(scenario.rateCard, asOf)
	const lines = new Set<string>()
	const segments = new Set<string>()

	for (const [index, segment] of scenario.segments.entries()) {
		const id = requireText(segment.id, ScenarioInput.Identifier, `segments[${index}].id`, "the segment identifier")

		if (segments.has(id)) {
			fail(ScenarioInput.Identifier, `segments[${id}]`, `the segment identifier ${id} appears twice`)
		}

		segments.add(id)

		if (!segment.lines.length) {
			fail(ScenarioInput.Rate, `segments[${id}].lines`, "the segment has no priced line")
		}

		for (const entry of segment.lines) {
			checkLine(entry, `segments[${id}].lines[${entry.id}]`, scenario, rates, lines)
		}
	}

	for (const entry of scenario.projectCosts) {
		checkLine(entry, `projectCosts[${entry.id}]`, scenario, rates, lines)
	}

	for (const entry of scenario.replacements) {
		checkLine(entry, `replacements[${entry.id}]`, scenario, rates, lines)
	}

	const plans = new Set<EntityID>()

	for (const [index, plan] of scenario.buildings.entries()) {
		const id = requireText(
			plan.building,
			ScenarioInput.Building,
			`buildings[${index}].building`,
			"the building identifier"
		)

		if (plans.has(id)) {
			fail(ScenarioInput.Building, `buildings[${id}]`, `the building ${id} has two plans`)
		}

		plans.add(id)
		checkPlan(plan, { scenario, rates, lines, segments })
	}

	if (!scenario.selected.length) {
		fail(ScenarioInput.Building, "selected", "the scenario selects no building")
	}

	const selected = new Set<EntityID>()

	for (const [index, building] of scenario.selected.entries()) {
		const id = requireText(building, ScenarioInput.Building, `selected[${index}]`, "the selected building identifier")

		if (selected.has(id)) {
			fail(ScenarioInput.Building, `selected[${index}]`, `the building ${id} is selected twice`)
		}

		if (!plans.has(id)) {
			fail(ScenarioInput.Building, `selected[${index}]`, `the selected building ${id} has no plan`)
		}

		selected.add(id)
	}

	checkSteps(scenario.workingCapital, "workingCapital", ScenarioInput.Amount, horizon, { startsAtZero: false })

	for (const [index, step] of scenario.workingCapital.entries()) {
		requireWholeNumber(step.balance, ScenarioInput.Amount, `workingCapital[${index}].balance`, 0)
	}

	checkOperating(scenario.operating, rates, horizon)

	const tax = scenario.taxTreatment

	if (tax.kind === TaxTreatmentKind.StatedPayments) {
		checkScheduledAmounts(tax.payments, "taxTreatment.payments", horizon, new Set(), {
			minimum: Number.MIN_SAFE_INTEGER,
		})
	} else if (tax.kind !== TaxTreatmentKind.PreTax) {
		fail(ScenarioInput.Field, "taxTreatment.kind", `${String((tax as { kind: unknown }).kind)} is not a tax treatment`)
	}

	if (scenario.costAdjustment !== null) {
		checkCostAdjustment(scenario.costAdjustment, "costAdjustment")
	}

	requireMonth(scenario.extraSpendMonth, "extraSpendMonth", horizon)
	requireMonth(scenario.takeRateMonth, "takeRateMonth", horizon)
}

/**
 * Checks a cost adjustment: its label, a whole number of basis points above
 * -100 percent, and known categories.
 */
export function checkCostAdjustment(adjustment: CostAdjustment, path: string): void {
	requireText(adjustment.label, ScenarioInput.Field, `${path}.label`, "the label")

	requireWholeNumber(
		adjustment.basisPoints,
		ScenarioInput.Percentage,
		`${path}.basisPoints`,
		-BASIS_POINTS_PER_WHOLE + 1
	)

	if (!adjustment.categories.length) {
		fail(ScenarioInput.Category, `${path}.categories`, "the adjustment names no category")
	}

	for (const [index, category] of adjustment.categories.entries()) {
		if (!KNOWN_CATEGORIES.has(category)) {
			fail(ScenarioInput.Category, `${path}.categories[${index}]`, `${String(category)} is not a cost category`)
		}
	}
}
