/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import {
	applyBasisPoints,
	currencyMinorDigits,
	discountFactorE8,
	formatBasisPoints,
	formatDiscountFactor,
	formatMinorUnits,
	formatMoney,
	monthlyDiscountRate,
	presentValue,
} from "#money"

describe("rounding", () => {
	test("scales an amount by basis points exactly and rounds the fraction once", () => {
		// 1,000,000 × 12,500 / 10,000 = 1,250,000 exactly.
		expect(applyBasisPoints(1_000_000, 12_500)).toBe(1_250_000)
		// 333 × 15,000 / 10,000 = 499.5 rounds away from zero to 500.
		expect(applyBasisPoints(333, 15_000)).toBe(500)
		expect(applyBasisPoints(-333, 15_000)).toBe(-500)
		// 1,000,000 × 9,000 / 10,000 = 900,000.
		expect(applyBasisPoints(1_000_000, 9000)).toBe(900_000)
	})

	test("refuses an amount or a percentage that is not a whole number", () => {
		expect(() => applyBasisPoints(10.5, 10_000)).toThrow(RangeError)
		expect(() => applyBasisPoints(10, 0.5)).toThrow(RangeError)
	})
})

describe("discounting", () => {
	test("derives the monthly rate from an effective annual rate", () => {
		// (1 + 0.10)^(1/12) − 1
		expect(monthlyDiscountRate(1000)).toBeCloseTo(0.00797414042890376, 15)
		expect(monthlyDiscountRate(0)).toBe(0)
	})

	test("prints month m's factor as (1 + monthly rate)^m to eight decimal places", () => {
		const monthly = monthlyDiscountRate(1000)

		expect(discountFactorE8(monthly, 0)).toBe(100_000_000)
		// Twelve months at an effective 10% compound to exactly 1.1.
		expect(discountFactorE8(monthly, 12)).toBe(110_000_000)
		// 1.1^(1/12) = 1.0079741404… rounds to 1.00797414.
		expect(discountFactorE8(monthly, 1)).toBe(100_797_414)
		expect(formatDiscountFactor(100_797_414)).toBe("1.00797414")
		expect(formatDiscountFactor(100_000_000)).toBe("1.00000000")
	})

	test("divides by the printed factor and rounds the present value half away from zero", () => {
		// 110,000 / 1.1 = 100,000.
		expect(presentValue(110_000, 110_000_000)).toBe(100_000)
		// 5 / 3 = 1.67 rounds to 2.
		expect(presentValue(5, 300_000_000)).toBe(2)
		// −15 / 10 = −1.5 rounds away from zero to −2.
		expect(presentValue(-15, 1_000_000_000)).toBe(-2)
		// 100,000 / 1.00797414 = 99,208.894… rounds to 99,209.
		expect(presentValue(100_000, 100_797_414)).toBe(99_209)
	})
})

describe("formatting", () => {
	test("reads the minor-unit digits from the currency code", () => {
		expect(currencyMinorDigits("USD")).toBe(2)
		expect(currencyMinorDigits("GBP")).toBe(2)
		expect(currencyMinorDigits("JPY")).toBe(0)
		expect(() => currencyMinorDigits("usd")).toThrow(RangeError)
		expect(() => currencyMinorDigits("ZZZ")).toThrow(RangeError)
	})

	test("prints an amount of minor units with grouped major units", () => {
		expect(formatMinorUnits(1_300_000, "USD")).toBe("13,000.00")
		expect(formatMinorUnits(-5, "USD")).toBe("-0.05")
		expect(formatMinorUnits(0, "USD")).toBe("0.00")
		expect(formatMinorUnits(1_234_567, "JPY")).toBe("1,234,567")
		expect(formatMoney(1_300_000, "USD")).toBe("USD 13,000.00")
		expect(formatMoney(-250_050, "USD")).toBe("USD -2,500.50")
	})

	test("prints basis points as a percentage with two decimals", () => {
		expect(formatBasisPoints(5000)).toBe("50.00%")
		expect(formatBasisPoints(1268)).toBe("12.68%")
	})
})
