/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { postcodeEvidence } from "#evidence"

describe("postcodeEvidence", () => {
	it.each([
		["M11 3AA", "GB"],
		["m113aa", "GB"],
		["T2P 1J9", "CA"],
		["D02 AF30", "IE"],
	])("reads %s in %s as a whole code", (value, country) => {
		expect(postcodeEvidence(value, country)).toEqual({ kind: "whole", value, partialForm: null })
	})

	it.each([
		["M11", "GB", "outward code"],
		["sw1a", "GB", "outward code"],
		["EC1Y", "GB", "outward code"],
		["T2P", "CA", "forward sortation area"],
		["D02", "IE", "routing key"],
		["D6W", "IE", "routing key"],
	])("reads %s in %s as a partial code, the %s", (value, country, partialForm) => {
		expect(postcodeEvidence(value, country)).toEqual({ kind: "partial", value, partialForm })
	})

	it("gives no evidence for a value in neither form", () => {
		expect(postcodeEvidence("Manchester", "GB")).toBeNull()
		expect(postcodeEvidence("M11 3", "GB")).toBeNull()
		expect(postcodeEvidence("D1A", "IE")).toBeNull()
	})

	it("gives no partial reading for a country with no partial form", () => {
		expect(postcodeEvidence("751", "FR")).toBeNull()
		expect(postcodeEvidence("75008", "FR")?.kind).toBe("whole")
	})
})
