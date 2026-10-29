/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { componentSequence, containsContiguous, matchesReceipt, requestedShares } from "./epoch-mixture.ts"

const receipt = (fields: { source?: string | null; country?: string | null; component_sequence?: string[] }) => ({
	name: "r",
	min_draws: 1,
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
