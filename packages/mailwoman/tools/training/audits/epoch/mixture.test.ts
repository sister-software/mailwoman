// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, test } from "vitest"

import {
	componentSequence,
	containsContiguous,
	countReceiptPopulations,
	expectReceiptDraws,
	matchesReceipt,
	receiptFloor,
	requestedShares,
} from "./mixture.ts"

const receipt = (fields: {
	name?: string
	min_draws?: number
	min_fraction_of_expected?: number | null
	source?: string | null
	country?: string | null
	component_sequence?: string[]
}) => ({
	name: fields.name ?? "r",
	min_draws: fields.min_draws ?? 1,
	min_fraction_of_expected: fields.min_fraction_of_expected ?? null,
	source: fields.source ?? null,
	country: fields.country ?? null,
	component_sequence: fields.component_sequence ?? [],
})

describe("componentSequence", () => {
	test("collapses BIO labels to their span sequence", () => {
		expect(componentSequence(["B-street", "I-street", "O", "B-locality", "B-postcode"])).toEqual([
			"street",
			"locality",
			"postcode",
		])
	})

	test.each([["street"], ["X-street"], ["B-"]])("refuses the malformed label %s", (label) => {
		expect(() => componentSequence([label])).toThrow("malformed BIO label")
	})

	test("refuses an orphan I- label", () => {
		expect(() => componentSequence(["B-street", "I-locality"])).toThrow("orphan BIO label 'I-locality'")
	})
})

test("a receipt matches its source, country and contiguous tail", () => {
	const row = { source: "gnaf", country: "AU", labels: ["B-street", "B-locality", "B-region", "B-postcode"] }

	expect(
		matchesReceipt(row, receipt({ source: "gnaf", country: "AU", component_sequence: ["region", "postcode"] }))
	).toBe(true)

	expect(matchesReceipt(row, receipt({ source: "oa" }))).toBe(false)
	expect(matchesReceipt(row, receipt({ country: "NZ" }))).toBe(false)
	expect(matchesReceipt(row, receipt({ component_sequence: ["postcode", "region"] }))).toBe(false)
	expect(containsContiguous(["a"], [])).toBe(true)
})

describe("receipt expectations (#2391)", () => {
	// #2390's case: weight 0.05 requested a share of 0.00024440, so 1,000,000 draws expect 244.4.
	const requested = new Map([["reviewed-postcode-tail", 0.0002444]])

	test("a receipt over its whole source expects the source's share of the draws", () => {
		const expectation = expectReceiptDraws(
			receipt({ source: "reviewed-postcode-tail" }),
			requested,
			1_000_000,
			undefined
		)

		expect(expectation.expected_draws).toBeCloseTo(244.4, 6)
	})

	test("a receipt narrowing its source takes the fraction of the source's rows it matches", () => {
		const narrowed = receipt({ name: "fr", source: "s", country: "FR", component_sequence: ["postcode", "locality"] })

		const populations = countReceiptPopulations(
			[
				{ source: "s", country: "FR", labels: ["B-postcode", "B-locality"] },
				{ source: "s", country: "FR", labels: ["B-locality", "B-postcode"] },
				{ source: "s", country: "BE", labels: ["B-postcode", "B-locality"] },
				// Never drawn: no country, and a country weighted at zero.
				{ source: "s", country: null, labels: ["B-postcode", "B-locality"] },
				{ source: "s", country: "XX", labels: ["B-postcode", "B-locality"] },
				{ source: "other", country: "FR", labels: ["B-postcode", "B-locality"] },
			],
			[narrowed],
			{ FR: 1, BE: 1, XX: 0 }
		)

		expect(populations.get("fr")).toEqual({ rows: 3, matching: 1 })

		const expectation = expectReceiptDraws(narrowed, new Map([["s", 0.3]]), 1000, populations.get("fr"))

		expect(expectation.matching_fraction).toBeCloseTo(1 / 3, 12)
		expect(expectation.expected_draws).toBeCloseTo(100, 9)
	})

	test("a row counts at its country's admission probability", () => {
		const narrowed = receipt({ name: "de", source: "s", country: "DE" })

		const populations = countReceiptPopulations(
			[
				{ source: "s", country: "DE", labels: ["B-street"] },
				{ source: "s", country: "AT", labels: ["B-street"] },
			],
			[narrowed],
			{ DE: 0.5, AT: 2 }
		)

		expect(populations.get("de")).toEqual({ rows: 1.25, matching: 0.25 })
	})

	test("a narrowing receipt without a counted population throws rather than expecting zero", () => {
		expect(() => expectReceiptDraws(receipt({ source: "s", country: "FR" }), requested, 10, undefined)).toThrow(
			"population was not counted"
		)
	})

	test("a receipt pooled over sources has no expectation", () => {
		expect(expectReceiptDraws(receipt({ country: "US" }), requested, 10, undefined).expected_draws).toBeNull()
	})

	test("the floor is the larger of min_draws and the stated fraction of the expectation", () => {
		expect(receiptFloor(receipt({ min_draws: 200 }), 244.4)).toBe(200)
		expect(receiptFloor(receipt({ min_draws: 200, min_fraction_of_expected: 0.9 }), 244.4)).toBe(219)
		expect(receiptFloor(receipt({ min_draws: 230, min_fraction_of_expected: 0.9 }), 244.4)).toBe(230)
		expect(() => receiptFloor(receipt({ min_fraction_of_expected: 0.9 }), null)).toThrow("has no expected draws")
	})
})

test("requested shares drop non-positive weights and sort by source", () => {
	expect([
		...requestedShares([
			["b", 3],
			["a", 1],
			["z", 0],
		]),
	]).toEqual([
		["a", 0.25],
		["b", 0.75],
	])
})
