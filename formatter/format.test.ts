/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { ClassificationMap } from "@mailwoman/core/classification"
import { describe, expect, it } from "vitest"

import {
	type ComponentDict,
	formatAddress,
	formatFromClassificationMap,
	reconcileComponents,
	toOpenCageComponents,
} from "./format.ts"

const US_ADDRESS: ComponentDict = {
	house_number: "123",
	street: "Main",
	street_suffix: "St",
	locality: "Portland",
	region: "OR",
	postcode: "97201",
}

describe("toOpenCageComponents", () => {
	it("maps the ComponentTag schema onto the OpenCage vocabulary", () => {
		expect(toOpenCageComponents(US_ADDRESS, "US")).toEqual({
			road: "Main St",
			house_number: "123",
			city: "Portland",
			state: "OR",
			postcode: "97201",
			country_code: "us",
		})
	})

	it("joins an intersection into the road field", () => {
		const oc = toOpenCageComponents({ intersection_a: "5th Ave", intersection_b: "Main St" }, "US")
		expect(oc.road).toBe("5th Ave & Main St")
	})

	it("folds FR cedex into the postcode slot", () => {
		const oc = toOpenCageComponents({ postcode: "75008", cedex: "CEDEX 08", locality: "Paris" }, "FR")
		expect(oc.postcode).toBe("75008 CEDEX 08")
	})

	it("rides the unit on the road line (no dedicated OpenCage slot)", () => {
		const oc = toOpenCageComponents({ street: "Pennsylvania", street_suffix: "Ave", unit: "Apt 4B" }, "US")
		expect(oc.road).toBe("Pennsylvania Ave Apt 4B")
	})

	it("never emits a bare country_code as the only component", () => {
		expect(toOpenCageComponents({}, "US")).toEqual({})
	})
})

describe("formatAddress", () => {
	it("renders an idiomatic single-line US address", () => {
		const formatted = formatAddress(US_ADDRESS, "US", { separator: ", " })

		expect(formatted).not.toContain("\n")

		for (const token of ["123", "Main", "Portland", "97201"]) {
			expect(formatted).toContain(token)
		}
	})

	it("returns an empty string for an empty dict", () => {
		expect(formatAddress({}, "US")).toBe("")
	})
})

describe("formatFromClassificationMap", () => {
	it("bridges the legacy rule-classifier vocabulary through the same formatter", () => {
		const map: ClassificationMap = new Map([
			["house_number", ["123"]],
			["street", ["Main St"]],
			["locality", ["Portland"]],
			["region", ["OR"]],
			["postcode", ["97201"]],
		])

		const formatted = formatFromClassificationMap(map, "US", { separator: ", " })

		for (const token of ["123", "Main", "Portland", "97201"]) {
			expect(formatted).toContain(token)
		}
	})

	it("merges unit and level labels onto the road line", () => {
		const map: ClassificationMap = new Map([
			["house_number", ["1"]],
			["street", ["Elm"]],
			["unit", ["Apt 4"]],
			["level", ["Floor 2"]],
			["locality", ["Ames"]],
		])

		const formatted = formatFromClassificationMap(map, "US", { separator: ", " })
		expect(formatted).toContain("Apt 4")
		expect(formatted).toContain("Floor 2")
	})
})

describe("reconcileComponents", () => {
	it("keeps only components whose value survives into the formatted string", () => {
		const components: ComponentDict = { locality: "Paris", region: "Île-de-France", postcode: "75008" }
		const raw = "75008 Paris"

		expect(reconcileComponents(components, raw)).toEqual({ locality: "Paris", postcode: "75008" })
	})

	it("is case- and whitespace-insensitive", () => {
		expect(reconcileComponents({ locality: "San  Francisco" }, "san francisco ca")).toEqual({
			locality: "San  Francisco",
		})
	})
})
