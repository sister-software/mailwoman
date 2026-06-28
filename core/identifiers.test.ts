/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import { isUniformlyCased, smartCamelCase, smartCapitalCase, smartSnakeCase } from "./identifiers.js"

test("smartSnakeCase: snake-cases mixed-case names", () => {
	expect(smartSnakeCase("streetName")).toBe("street_name")
	expect(smartSnakeCase("Street Name")).toBe("street_name")
	expect(smartSnakeCase("street-name")).toBe("street_name")
	expect(smartSnakeCase("HouseNumber")).toBe("house_number")
})

test("smartSnakeCase: an already-snake_case name is unchanged", () => {
	expect(smartSnakeCase("house_number")).toBe("house_number")
})

test("smartSnakeCase: an all-caps name is preserved, not lowercased", () => {
	// The whole point of "smart": don't destroy an acronym/all-caps token.
	expect(smartSnakeCase("USA")).toBe("USA")
})

test("smartSnakeCase: all-caps with spaces collapses non-word runs to single underscores", () => {
	expect(smartSnakeCase("PO BOX")).toBe("PO_BOX")
	expect(smartSnakeCase("HELLO WORLD")).toBe("HELLO_WORLD")
})

test("smartSnakeCase: dotted all-caps acronym normalizes periods away (U.S.A. -> USA)", () => {
	// Regression: the all-caps branch used to operate on the original `name`, not the period-stripped
	// `normalizedName`, so "U.S.A." yielded "U_S_A_" instead of the documented "USA". Fixed in this PR.
	expect(smartSnakeCase("U.S.A.")).toBe("USA")
})

test("smartCamelCase: camel-cases mixed-case names", () => {
	expect(smartCamelCase("street_name")).toBe("streetName")
	expect(smartCamelCase("Street Name")).toBe("streetName")
	expect(smartCamelCase("HouseNumber")).toBe("houseNumber")
})

test("smartCamelCase: an already-camelCase name is unchanged", () => {
	expect(smartCamelCase("streetName")).toBe("streetName")
})

test("smartCamelCase: an all-caps name is preserved verbatim (incl. spaces)", () => {
	expect(smartCamelCase("USA")).toBe("USA")
	expect(smartCamelCase("PO BOX")).toBe("PO BOX")
})

test("isUniformlyCased: true for all-upper or all-lower input", () => {
	expect(isUniformlyCased("HELLO")).toBe(true)
	expect(isUniformlyCased("hello")).toBe(true)
	expect(isUniformlyCased("hello world")).toBe(true)
	// Digits/punctuation equal their own upper- and lower-cased form.
	expect(isUniformlyCased("123 main")).toBe(true)
})

test("isUniformlyCased: false for mixed-case input", () => {
	expect(isUniformlyCased("Hello")).toBe(false)
	expect(isUniformlyCased("streetName")).toBe(false)
	expect(isUniformlyCased("MixedCase")).toBe(false)
})

test("isUniformlyCased: false for null and empty string", () => {
	expect(isUniformlyCased(null)).toBe(false)
	expect(isUniformlyCased("")).toBe(false)
})

test("smartCapitalCase: capital-cases genuinely mixed-case input", () => {
	expect(smartCapitalCase("streetName")).toBe("Street Name")
	expect(smartCapitalCase("MixedCase")).toBe("Mixed Case")
	expect(smartCapitalCase("Hello world")).toBe("Hello World")
})

test("smartCapitalCase: passes through email addresses unchanged", () => {
	expect(smartCapitalCase("test@example.com")).toBe("test@example.com")
})

test("smartCapitalCase: passes through uniformly-cased input unchanged", () => {
	// Per the docstring: uniformly-cased input is left alone, so an all-lower phrase is NOT title-cased.
	expect(smartCapitalCase("hello world")).toBe("hello world")
	expect(smartCapitalCase("HELLO WORLD")).toBe("HELLO WORLD")
	expect(smartCapitalCase("street-name")).toBe("street-name")
})
