/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { admitsAsOf, appliesAt, compareISODate, isISODate } from "#time"

describe("isISODate", () => {
	test.each(["2022-03-01", "2022-03-01T10:00:00Z", "2022-03-01T10:00:00+01:00"])("accepts %s", (text) => {
		expect(isISODate(text)).toBe(true)
	})

	test.each(["03/01/2022", "2022-3-1", "yesterday", ""])("refuses %s", (text) => {
		expect(isISODate(text)).toBe(false)
	})
})

describe("compareISODate", () => {
	test("orders a date before a later timestamp on the same day", () => {
		expect(compareISODate("2022-03-01", "2022-03-01T10:00:00Z")).toBe(-1)
		expect(compareISODate("2022-03-02", "2022-03-01T10:00:00Z")).toBe(1)
		expect(compareISODate("2022-03-01", "2022-03-01")).toBe(0)
	})
})

describe("admitsAsOf", () => {
	test("admits a record available on or before the cutoff", () => {
		expect(admitsAsOf({ availableAt: "2022-01-15", observedAt: null, retrievedAt: null }, "2022-06-30")).toBe(
			"admitted"
		)

		expect(admitsAsOf({ availableAt: "2022-06-30", observedAt: null, retrievedAt: null }, "2022-06-30")).toBe(
			"admitted"
		)
	})

	test("excludes a record available after the cutoff even when observed before it", () => {
		expect(admitsAsOf({ observedAt: "2021-12-01", availableAt: "2023-01-01", retrievedAt: null }, "2022-06-30")).toBe(
			"excluded"
		)
	})

	test("reports a record with no availability date as undated", () => {
		expect(admitsAsOf({ observedAt: "2021-12-01", availableAt: null, retrievedAt: null }, "2022-06-30")).toBe("undated")
	})
})

describe("appliesAt", () => {
	test("is true inside the interval and false outside it", () => {
		expect(appliesAt({ validFrom: "2022-01-01", validTo: "2022-12-31" }, "2022-06-30")).toBe(true)
		expect(appliesAt({ validFrom: "2022-01-01", validTo: "2022-12-31" }, "2023-01-01")).toBe(false)
	})

	test("is unknown when the interval has neither bound", () => {
		expect(appliesAt({ validFrom: null, validTo: null }, "2022-06-30")).toBe("unknown")
	})

	test("treats an open end as applying from the start onward", () => {
		expect(appliesAt({ validFrom: "2022-01-01", validTo: null }, "2030-01-01")).toBe(true)
	})
})
