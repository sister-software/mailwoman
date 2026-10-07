/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The scenario controls. Each of the eight values is one model input, held in the unit the model takes: basis
 *   points for a percentage, minor units for a price, a date for a date. A control's text parses into that unit
 *   exactly, and the model validates the value's range, so a value the model refuses reaches the page as the
 *   model's own message.
 *
 *   A changed input with an `InputBasis` in the scenario takes {@link CONTROLS_BASIS}, so neither the
 *   inputs table nor the scenario report attributes a new value to the source of the old one. An input left at
 *   the scenario's value keeps the scenario's own record, basis included.
 */

import { buildDossier, type Dossier, type DossierRecords, type ISODate, isISODate, UnitStage } from "@mailwoman/dossier"
import {
	type CostAdjustment,
	CostCategory,
	currencyMinorDigits,
	formatBasisPoints,
	formatMoney,
	type InputBasis,
	InputBasisKind,
	type Scenario,
} from "@mailwoman/route-scenarios"

import { inputBasisText } from "#words"

/**
 * The values the controls apply, each in the unit of the model input it sets.
 */
export interface ControlValues {
	/**
	 * `Scenario.costAdjustment` over every cost category, in basis points.
	 * Zero states no adjustment.
	 */
	costAdjustmentBasisPoints: number
	/**
	 * `Scenario.operating.uptake.takeRateBasisPoints`.
	 */
	takeRateBasisPoints: number
	/**
	 * The amount of the month-0 step of `Scenario.operating.prices`, in the currency's minor units.
	 */
	monthlyPrice: number
	/**
	 * The `asOf` date of the dossier and of the scenario.
	 *
	 * `prepareScenario` refuses a scenario whose date differs from its dossier's.
	 */
	dossierDate: ISODate
	/**
	 * The stage of every building's unit denominator on the map and of every `BuildingPlan.unitStage`.
	 */
	unitStage: UnitStage
	/**
	 * `Scenario.monthZero`, the first day of the calendar month the control names.
	 */
	monthZero: ISODate
	/**
	 * `Scenario.annualDiscountRateBasisPoints`.
	 */
	discountRateBasisPoints: number
	/**
	 * `Scenario.horizonMonths`.
	 */
	horizonMonths: number
}

/**
 * The basis of an input a control changed.
 */
export const CONTROLS_BASIS: InputBasis = {
	kind: InputBasisKind.OperatorAssumption,
	statedBy: "the scenario controls",
}

/**
 * The control values that leave `scenario` as it is.
 *
 * Throws when the scenario plans its buildings at more than one unit stage or states
 * no month-0 price, because one control holds one stage and one price.
 */
export function controlDefaults(scenario: Scenario): ControlValues {
	const stages = [...new Set(scenario.buildings.map((plan) => plan.unitStage))]
	const price = scenario.operating.prices.find((step) => step.fromMonth === 0)

	if (stages.length !== 1) {
		throw new Error(
			`scenario ${scenario.id} plans its buildings at ${stages.length} unit stages, and the unit stage control holds one`
		)
	}

	if (!price) throw new Error(`scenario ${scenario.id} states no price from month 0`)

	return {
		costAdjustmentBasisPoints: scenario.costAdjustment?.basisPoints ?? 0,
		takeRateBasisPoints: scenario.operating.uptake.takeRateBasisPoints,
		monthlyPrice: price.amount,
		dossierDate: scenario.asOf,
		unitStage: stages[0]!,
		monthZero: scenario.monthZero,
		discountRateBasisPoints: scenario.annualDiscountRateBasisPoints,
		horizonMonths: scenario.horizonMonths,
	}
}

/**
 * A cost adjustment of every cost category by `basisPoints`, labeled as the
 * controls' change, or `null` at zero.
 */
function controlAdjustment(basisPoints: number): CostAdjustment | null {
	if (basisPoints === 0) return null

	return {
		label: `every construction line ${formatBasisPoints(Math.abs(basisPoints))} ${basisPoints > 0 ? "over" : "under"} the rate card, set in the scenario controls`,
		basisPoints,
		categories: Object.values(CostCategory),
	}
}

/**
 * The scenario the control values produce from `base`.
 */
export function scenarioFor(base: Scenario, values: ControlValues): Scenario {
	const defaults = controlDefaults(base)
	const { operating } = base

	return {
		...base,
		asOf: values.dossierDate,
		monthZero: values.monthZero,
		horizonMonths: values.horizonMonths,
		annualDiscountRateBasisPoints: values.discountRateBasisPoints,
		costAdjustment:
			values.costAdjustmentBasisPoints === defaults.costAdjustmentBasisPoints
				? base.costAdjustment
				: controlAdjustment(values.costAdjustmentBasisPoints),
		buildings:
			values.unitStage === defaults.unitStage
				? base.buildings
				: base.buildings.map((plan) => ({ ...plan, unitStage: values.unitStage })),
		operating: {
			...operating,
			prices:
				values.monthlyPrice === defaults.monthlyPrice
					? operating.prices
					: operating.prices.map((step) =>
							step.fromMonth === 0 ? { ...step, amount: values.monthlyPrice, basis: CONTROLS_BASIS } : step
						),
			uptake:
				values.takeRateBasisPoints === defaults.takeRateBasisPoints
					? operating.uptake
					: { ...operating.uptake, takeRateBasisPoints: values.takeRateBasisPoints, basis: CONTROLS_BASIS },
		},
	}
}

/**
 * The dossier the control values produce from the records: the records admitted
 * by their availability dates on the dossier date.
 */
export function dossierFor(records: DossierRecords, values: ControlValues): Dossier {
	return buildDossier(records, { asOf: values.dossierDate })
}

/**
 * The text each control holds.
 */
export interface ControlText {
	costAdjustment: string
	takeRate: string
	monthlyPrice: string
	dossierDate: string
	unitStage: string
	monthZero: string
	discountRate: string
	horizon: string
}

export type ControlField = keyof ControlText

/**
 * Writes a whole count of `10^-digits` units as decimal text, with `padded` writing every fractional digit.
 */
function decimalText(value: number, digits: number, padded = false): string {
	const scale = 10 ** digits
	const magnitude = Math.abs(value)
	const whole = Math.trunc(magnitude / scale)
	const fraction = String(magnitude % scale).padStart(digits, "0")
	const shown = padded ? fraction : fraction.replace(/0+$/u, "")

	return `${value < 0 ? "-" : ""}${whole}${digits && shown ? `.${shown}` : ""}`
}

const DECIMAL = /^(?<sign>[+-])?(?<whole>\d+)(?:\.(?<fraction>\d+))?$/u
const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/u
const WHOLE = /^\d+$/u
const DATE = /^\d{4}-\d{2}-\d{2}$/u

/**
 * Reads decimal text as a whole count of `10^-digits` units, or `null` when the text
 * is not a decimal or has more fractional digits than `digits`.
 * The conversion is exact: `12.34` with two digits is 1234.
 */
function parseDecimal(text: string, digits: number): number | null {
	const match = DECIMAL.exec(text.trim())

	if (!match?.groups) return null

	const fraction = match.groups["fraction"] ?? ""

	if (fraction.length > digits) return null

	const value = Number(`${match.groups["whole"]}${fraction.padEnd(digits, "0")}`)

	if (!Number.isSafeInteger(value)) return null

	return match.groups["sign"] === "-" ? -value : value
}

/**
 * The text each control shows for `values`.
 */
export function controlText(values: ControlValues, currency: string): ControlText {
	return {
		costAdjustment: decimalText(values.costAdjustmentBasisPoints, 2),
		takeRate: decimalText(values.takeRateBasisPoints, 2),
		monthlyPrice: decimalText(values.monthlyPrice, currencyMinorDigits(currency), true),
		dossierDate: values.dossierDate,
		unitStage: values.unitStage,
		monthZero: values.monthZero.slice(0, 7),
		discountRate: decimalText(values.discountRateBasisPoints, 2),
		horizon: String(values.horizonMonths),
	}
}

export type ParsedControls =
	| { ok: true; values: ControlValues }
	| { ok: false; errors: Partial<Record<ControlField, string>> }

/**
 * Reads the controls' text as values.
 *
 * Each field that does not hold its unit's format gets a message, and no value
 * is returned until every field reads.
 */
export function parseControls(text: ControlText, currency: string): ParsedControls {
	const errors: Partial<Record<ControlField, string>> = {}
	const digits = currencyMinorDigits(currency)
	const percent = "Enter a percentage with at most two decimal places, such as 12.5."

	const decimal = (field: ControlField, scale: number, message: string): number => {
		const value = parseDecimal(text[field], scale)

		if (value === null) {
			errors[field] = message
		}

		return value ?? 0
	}

	const costAdjustmentBasisPoints = decimal("costAdjustment", 2, percent)
	const takeRateBasisPoints = decimal("takeRate", 2, percent)

	const monthlyPrice = decimal(
		"monthlyPrice",
		digits,
		`Enter an amount in ${currency} with at most ${digits} decimal places.`
	)

	const discountRateBasisPoints = decimal("discountRate", 2, percent)

	if (!DATE.test(text.dossierDate) || !isISODate(text.dossierDate)) {
		errors.dossierDate = "Enter a date as YYYY-MM-DD."
	}

	if (!MONTH.test(text.monthZero)) {
		errors.monthZero = "Enter a month as YYYY-MM."
	}

	if (!WHOLE.test(text.horizon.trim())) {
		errors.horizon = "Enter a whole number of months."
	}

	const stages: readonly string[] = Object.values(UnitStage)

	if (!stages.includes(text.unitStage)) {
		errors.unitStage = `Choose one of the stages ${stages.join(", ")}.`
	}

	if (Object.keys(errors).length) return { ok: false, errors }

	return {
		ok: true,
		values: {
			costAdjustmentBasisPoints,
			takeRateBasisPoints,
			monthlyPrice,
			dossierDate: text.dossierDate,
			unitStage: text.unitStage as UnitStage,
			monthZero: `${text.monthZero}-01`,
			discountRateBasisPoints,
			horizonMonths: Number(text.horizon.trim()),
		},
	}
}

/**
 * One row of the inputs table: an input the controls set, its value in the scenario and its basis.
 */
export interface InputRow {
	input: string
	value: string
	basis: string
}

/**
 * The inputs the controls set, each with its value in `scenario` and its basis.
 *
 * `Scenario` gives month zero, the horizon, the discount rate and the cost adjustment no
 * `InputBasis` field, so their rows state whether the scenario or the controls set them.
 */
export function inputRows(
	base: Scenario,
	scenario: Scenario,
	dossier: Dossier,
	records: DossierRecords
): readonly InputRow[] {
	const convention = (changed: boolean) =>
		changed ? "convention set in the scenario controls" : "convention stated by the scenario"

	const price = scenario.operating.prices.find((step) => step.fromMonth === 0)!
	const { uptake } = scenario.operating
	const adjustment = scenario.costAdjustment
	const stage = scenario.buildings[0]?.unitStage ?? "none planned"

	return [
		{
			input: "Cost adjustment",
			value: adjustment
				? `${adjustment.basisPoints > 0 ? "+" : "-"}${formatBasisPoints(Math.abs(adjustment.basisPoints))} on ${
						adjustment.categories.length === Object.values(CostCategory).length
							? "every construction line"
							: adjustment.categories.join(", ")
					}`
				: "none: the rate card as stated",
			basis: adjustment === base.costAdjustment ? "stated by the scenario" : "set in the scenario controls",
		},
		{
			input: "Take rate",
			value: `${formatBasisPoints(uptake.takeRateBasisPoints)} of occupied units over ${uptake.rampMonths} months`,
			basis: inputBasisText(uptake.basis),
		},
		{
			input: "Monthly price",
			value: `${formatMoney(price.amount, scenario.currency)} per subscriber from month 0`,
			basis: inputBasisText(price.basis),
		},
		{
			input: "Dossier date",
			value: dossier.asOf,
			basis: `the dossier admits ${dossier.admitted.length} of ${records.sources.length} source records by their availability dates`,
		},
		{
			input: "Unit stage",
			value: stage,
			basis:
				scenario.buildings === base.buildings
					? "stated by the scenario's building plans"
					: "set in the scenario controls",
		},
		{
			input: "Month zero",
			value: scenario.monthZero.slice(0, 7),
			basis: convention(scenario.monthZero !== base.monthZero),
		},
		{
			input: "Discount rate",
			value: `${formatBasisPoints(scenario.annualDiscountRateBasisPoints)} effective annual`,
			basis: convention(scenario.annualDiscountRateBasisPoints !== base.annualDiscountRateBasisPoints),
		},
		{
			input: "Horizon",
			value: `${scenario.horizonMonths} months`,
			basis: convention(scenario.horizonMonths !== base.horizonMonths),
		},
	]
}
