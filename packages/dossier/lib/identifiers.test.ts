/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { entityID, sameExternalID } from "#identifiers"

describe("entityID", () => {
	test("joins the kind and the key with a colon", () => {
		expect(entityID("building", "example-house")).toBe("building:example-house")
	})

	test("refuses an empty key", () => {
		expect(() => entityID("unit", "")).toThrow(/empty key/)
	})
})

describe("sameExternalID", () => {
	test("compares namespace and value exactly", () => {
		expect(sameExternalID({ namespace: "nyc:bin", value: "3000001" }, { namespace: "nyc:bin", value: "3000001" })).toBe(
			true
		)

		expect(sameExternalID({ namespace: "nyc:bin", value: "3000001" }, { namespace: "nyc:bbl", value: "3000001" })).toBe(
			false
		)
	})
})
