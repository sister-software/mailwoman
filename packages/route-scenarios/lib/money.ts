/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Amounts, percentages and discounting for the scenario calculator.
 *
 *   Every undiscounted amount is an integer count of the currency's minor unit, such as cents for USD, held
 *   in a number that must be a safe integer. Sums, differences and products of a whole quantity and a rate
 *   are therefore exact, and the shared-route example reproduces to the cent.
 *
 *   A percentage is an integer count of basis points, so 10,000 basis points are 100 percent. A percentage of
 *   an amount can be a fraction of a minor unit. That value is rounded once, where it is produced, to the
 *   nearest minor unit with halves rounded away from zero.
 *
 *   One rule governs discounting. An effective annual rate r gives the monthly rate (1 + r)^(1/12) - 1.
 *   Month m's discount factor is (1 + monthly rate)^m rounded to eight decimal places. The month's present
 *   value is its cash flow divided by that printed factor, computed exactly and rounded half away from zero
 *   to the minor unit. NPV is the sum of the monthly present values. The present-value column of a cash-flow
 *   table therefore adds up to the reported NPV, and a reader can reproduce each present value from the
 *   factor printed beside it.
 */

import { formatPercent } from "@mailwoman/core/stats"

/**
 * An amount as an integer count of a currency's minor unit.
 */
export type MinorUnits = number

/**
 * The number of basis points in a whole, so 10,000 basis points are 100 percent.
 */
export const BASIS_POINTS_PER_WHOLE = 10_000

/**
 * A discount factor is stored as an integer count of one hundred-millionths: eight decimal places.
 */
const FACTOR_SCALE = 100_000_000

/**
 * Returns the integer quotient of two integers, rounded half away from zero, computed exactly.
 */
function divideRounded(numerator: bigint, denominator: bigint): bigint {
	if (denominator === 0n) throw new RangeError("divideRounded: division by zero")

	const quotient = numerator / denominator
	const remainder = numerator % denominator
	const magnitude = remainder < 0n ? -remainder : remainder
	const divisor = denominator < 0n ? -denominator : denominator

	if (2n * magnitude < divisor) return quotient

	return numerator < 0n === denominator < 0n ? quotient + 1n : quotient - 1n
}

function requireWhole(value: number, what: string): bigint {
	if (!Number.isSafeInteger(value)) throw new RangeError(`${what} must be a safe integer, got ${value}`)

	return BigInt(value)
}

function toSafeNumber(value: bigint, what: string): number {
	const result = Number(value)

	if (!Number.isSafeInteger(result)) throw new RangeError(`${what} exceeds the safe integer range`)

	return result
}

/**
 * Returns `amount` scaled by `basisPoints / 10,000`, rounded half away from zero to the minor unit.
 *
 * A 25 percent overrun is `applyBasisPoints(amount, 12_500)`, and a 10 percent
 * reduction is `applyBasisPoints(amount, 9_000)`.
 */
export function applyBasisPoints(amount: MinorUnits, basisPoints: number): MinorUnits {
	const product =
		requireWhole(amount, "applyBasisPoints amount") * requireWhole(basisPoints, "applyBasisPoints basis points")

	return toSafeNumber(divideRounded(product, BigInt(BASIS_POINTS_PER_WHOLE)), "applyBasisPoints result")
}

/**
 * Returns the monthly rate `(1 + r)^(1/12) - 1` for an effective annual rate `r` given in basis points.
 */
export function monthlyDiscountRate(annualBasisPoints: number): number {
	if (!Number.isSafeInteger(annualBasisPoints) || annualBasisPoints < 0) {
		throw new RangeError(
			`monthlyDiscountRate: the annual rate must be a non-negative whole number of basis points, got ${annualBasisPoints}`
		)
	}

	return Math.pow(1 + annualBasisPoints / BASIS_POINTS_PER_WHOLE, 1 / 12) - 1
}

/**
 * Returns month `month`'s discount factor `(1 + monthlyRate)^month` as an integer count
 * of one hundred-millionths: the factor rounded to eight decimal places.
 */
export function discountFactorE8(monthlyRate: number, month: number): number {
	if (!Number.isSafeInteger(month) || month < 0) {
		throw new RangeError(`discountFactorE8: the month must be a non-negative integer, got ${month}`)
	}

	const scaled = Math.round(Math.pow(1 + monthlyRate, month) * FACTOR_SCALE)

	if (!Number.isSafeInteger(scaled))
		throw new RangeError(`discountFactorE8: the factor for month ${month} is too large`)

	return scaled
}

/**
 * Returns `amount` divided by the factor `factorE8 / 100,000,000`,
 * rounded half away from zero to the minor unit.
 */
export function presentValue(amount: MinorUnits, factorE8: number): MinorUnits {
	const numerator = requireWhole(amount, "presentValue amount") * BigInt(FACTOR_SCALE)

	return toSafeNumber(divideRounded(numerator, requireWhole(factorE8, "presentValue factor")), "presentValue result")
}

/**
 * Returns a factor stored by {@link discountFactorE8} with its eight decimal places, such as `1.00797414`.
 */
export function formatDiscountFactor(factorE8: number): string {
	const digits = String(requireWhole(factorE8, "formatDiscountFactor factor")).padStart(9, "0")

	return `${digits.slice(0, -8)}.${digits.slice(-8)}`
}

/**
 * Returns the number of minor-unit digits of an ISO 4217 currency code, such as 2 for USD and 0 for JPY.
 *
 * A code the runtime's currency list lacks throws, so an amount is never printed in a guessed unit.
 */
export function currencyMinorDigits(currency: string): number {
	if (!/^[A-Z]{3}$/.test(currency) || !Intl.supportedValuesOf("currency").includes(currency)) {
		throw new RangeError(`"${currency}" is not an ISO 4217 currency code this runtime lists`)
	}

	const digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits

	if (digits === undefined) throw new RangeError(`the runtime reports no minor-unit digits for ${currency}`)

	return digits
}

/**
 * Returns an amount of minor units in major units with grouped thousands, such as `13,000.00`.
 */
export function formatMinorUnits(amount: MinorUnits, currency: string): string {
	const digits = currencyMinorDigits(currency)
	const magnitude = requireWhole(amount, "formatMinorUnits amount")
	const absolute = magnitude < 0n ? -magnitude : magnitude
	const scale = 10n ** BigInt(digits)
	const major = String(absolute / scale).replaceAll(/\B(?=(\d{3})+(?!\d))/g, ",")
	const minor = digits ? `.${String(absolute % scale).padStart(digits, "0")}` : ""

	return `${magnitude < 0n ? "-" : ""}${major}${minor}`
}

/**
 * Returns an amount with its currency code, such as `USD 13,000.00`.
 */
export function formatMoney(amount: MinorUnits, currency: string): string {
	return `${currency} ${formatMinorUnits(amount, currency)}`
}

/**
 * Returns basis points as a percentage with two decimals, such as `50.00%` for 5,000.
 */
export function formatBasisPoints(basisPoints: number): string {
	return formatPercent(basisPoints, BASIS_POINTS_PER_WHOLE, 2)
}
