/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Unit tests for the address parser.
 */

import { describe, expect, it } from "vitest"
import { isTokenKind, parsePostalAddress } from "./postal.js"

describe("Address Parser", () => {
	// Basic functionality tests
	it("should handle commas as separate tokens", () => {
		const input = "123 Main St, New York, NY 10001"
		const result = parsePostalAddress(input)

		const commas = result.filter((item) => isTokenKind(item, "comma"))
		expect(commas).toHaveLength(2)

		// Check that the word tokens don't include commas
		const words = result.filter((item) => !isTokenKind(item, "comma"))
		words.forEach((word) => {
			expect(word.value).not.toContain(",")
		})

		console.debug(result)

		// Verify specific tokens
		expect(result[0]?.value).toBe("123")
		expect(result[1]?.value).toBe("Main")
		expect(result[2]?.value).toBe("St")
		expect(result[3]?.kind).toBe("comma")
		expect(result[4]?.value).toBe("New")
		expect(result[5]?.value).toBe("York")
		expect(result[6]?.kind).toBe("comma")
	})

	it("should handle quoted text as single components", () => {
		const input = '123 Main St, "Apartment 4B", New York, NY 10001'
		const result = parsePostalAddress(input)

		console.debug(result.map(({ value, kind }) => ({ value, kind })))

		const quotedComponent = result.find((item) => isTokenKind(item, "quoted_text"))
		expect(quotedComponent).toBeDefined()
		expect(quotedComponent?.value).toBe("Apartment 4B")
		expect(quotedComponent?.original).toBe('"Apartment 4B"')
	})

	it("should handle parenthesized text as single components", () => {
		const input = "42 Wallaby Way, Sydney, NSW 2000 (Australia)"
		const result = parsePostalAddress(input)

		const parenthesizedComponent = result.find((item) => item.type === "ParenthesizedText")
		expect(parenthesizedComponent).toBeDefined()
		expect(parenthesizedComponent?.value).toBe("Australia")
		expect(parenthesizedComponent?.original).toBe("(Australia)")
	})

	it("should handle bracketed text as single components", () => {
		const input = "221B Baker Street [Sherlock Holmes' Address], London, UK"
		const result = parsePostalAddress(input)

		const bracketedComponent = result.find((item) => item.type === "BracketedText")
		expect(bracketedComponent).toBeDefined()
		expect(bracketedComponent?.value).toBe("Sherlock Holmes' Address")
		expect(bracketedComponent?.original).toBe("[Sherlock Holmes' Address]")
	})

	// Complex address tests
	it("should handle complex addresses with multiple special formats", () => {
		const input = 'John Smith (CEO), "Big Company HQ", 100 Business Ave [Building A], Suite 500, Los Angeles, CA 90001'
		const result = parsePostalAddress(input)

		// Check that we have one of each special type
		expect(result.filter((item) => item.type === "ParenthesizedText")).toHaveLength(1)
		expect(result.filter((item) => item.type === "QuotedText")).toHaveLength(1)
		expect(result.filter((item) => item.type === "BracketedText")).toHaveLength(1)

		// Check specific components
		const ceoComponent = result.find((item) => item.value === "CEO")
		expect(ceoComponent).toBeDefined()

		const companyComponent = result.find((item) => item.value === "Big Company HQ")
		expect(companyComponent).toBeDefined()

		const buildingComponent = result.find((item) => item.value === "Building A")
		expect(buildingComponent).toBeDefined()
	})

	it("should handle multiline addresses", () => {
		const input = ["Jessie Lorem", "123 Main St", "Suite 100", "New York, NY 10001", "USA"]

		const result = parsePostalAddress(input.join("\n"))
		console.debug(result)
		expect(result).toHaveLength(5)
	})

	it("should handle addresses with special characters", () => {
		const input = '123-456 Special Char. St. (Unit 7B) [East Wing], "Historic District", City-Name'
		const result = parsePostalAddress(input)

		const streetNumber = result.find((item) => item.value === "123-456")
		expect(streetNumber).toBeDefined()

		const unitComponent = result.find((item) => item.value === "Unit 7B")
		expect(unitComponent).toBeDefined()

		const wingComponent = result.find((item) => item.value === "East Wing")
		expect(wingComponent).toBeDefined()

		const districtComponent = result.find((item) => item.value === "Historic District")
		expect(districtComponent).toBeDefined()

		const cityComponent = result.find((item) => item.value === "City-Name")
		expect(cityComponent).toBeDefined()
	})

	// Edge cases
	it("should handle empty addresses", () => {
		const input = ""
		const result = parsePostalAddress(input)

		expect(result).toHaveLength(0)
	})

	it("should handle addresses with only special characters", () => {
		const input = '(Parenthesized) [Bracketed] "Quoted"'
		const result = parsePostalAddress(input)

		expect(result).toHaveLength(3)
		expect(result[0]?.type).toBe("ParenthesizedText")
		expect(result[1]?.type).toBe("BracketedText")
		expect(result[2]?.type).toBe("QuotedText")
	})

	it("should handle nested special characters correctly", () => {
		// Note: The parser treats the outermost delimiters as the grouping
		const input = '"Quoted with (parentheses)" and [Bracketed with "quotes"]'
		const result = parsePostalAddress(input)

		const quotedComponent = result.find((item) => item.type === "QuotedText")
		expect(quotedComponent).toBeDefined()
		expect(quotedComponent?.value).toBe("Quoted with (parentheses)")

		const bracketedComponent = result.find((item) => item.type === "BracketedText")
		expect(bracketedComponent).toBeDefined()
		expect(bracketedComponent?.value).toBe('Bracketed with "quotes"')
	})

	// International address test
	it("should handle international address formats", () => {
		const input = "Piazza del Colosseo, 1, 00184 Roma RM, Italy"
		const result = parsePostalAddress(input)

		expect(result.find((item) => item.value === "Piazza")).toBeDefined()
		expect(result.find((item) => item.value === "del")).toBeDefined()
		expect(result.find((item) => item.value === "Colosseo")).toBeDefined()
		expect(result.find((item) => item.value === "Italy")).toBeDefined()
	})
})
