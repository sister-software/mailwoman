/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { computeQueryShape } from "./compute.js"

describe("computeQueryShape — end-to-end", () => {
	it("classifies a US ZIP correctly", () => {
		const shape = computeQueryShape("10118")
		expect(shape.characterClass).toBe("numeric")
		expect(shape.tokenClasses.length).toBe(1)
		expect(shape.tokenClasses[0].class).toBe("digit")
		expect(shape.knownFormats.some((f) => f.format === "us_zip")).toBe(true)
		expect(shape.segments.length).toBe(1)
	})

	it("classifies a single-word locality", () => {
		const shape = computeQueryShape("Paris")
		expect(shape.characterClass).toBe("alpha")
		expect(shape.tokenClasses.length).toBe(1)
		expect(shape.tokenClasses[0].class).toBe("alpha")
		expect(shape.knownFormats.length).toBe(0)
	})

	it("classifies a structured US address", () => {
		const text = "350 5th Ave, New York, NY 10118"
		const shape = computeQueryShape(text)
		expect(shape.characterClass).toBe("alphanumeric")
		expect(shape.segments.length).toBe(3)
		expect(shape.segments[0].body).toBe("350 5th Ave")
		expect(shape.segments[1].body).toBe("New York")
		expect(shape.segments[2].body).toBe("NY 10118")
		expect(shape.knownFormats.some((f) => f.format === "us_zip")).toBe(true)
		expect(shape.totalLength).toBe(text.length)
	})

	it("classifies a CJK input", () => {
		const shape = computeQueryShape("東京駅")
		expect(shape.characterClass).toBe("cjk")
		expect(shape.tokenClasses[0].class).toBe("cjk")
	})

	it("classifies a short locality-only query", () => {
		const shape = computeQueryShape("NYC NY")
		expect(shape.characterClass).toBe("alpha")
		expect(shape.tokenClasses.length).toBe(2)
	})

	it("classifies a PO Box input", () => {
		const shape = computeQueryShape("PO Box 1234")
		expect(shape.knownFormats.some((f) => f.format === "po_box")).toBe(true)
	})

	it("accepts NormalizedInputLite shape", () => {
		const shape = computeQueryShape({ normalized: "10118", appliedLocale: "en-US" })
		expect(shape.characterClass).toBe("numeric")
	})

	it("returns a frozen QueryShape", () => {
		const shape = computeQueryShape("10118")
		expect(Object.isFrozen(shape)).toBe(true)
	})

	it("totalLength matches input length", () => {
		const text = "350 5th Ave, New York, NY 10118"
		const shape = computeQueryShape(text)
		expect(shape.totalLength).toBe(text.length)
	})

	it("detects whitespace pattern: single", () => {
		expect(computeQueryShape("a b c").whitespacePattern).toBe("single")
	})

	it("detects whitespace pattern: double", () => {
		expect(computeQueryShape("a  b").whitespacePattern).toBe("double")
	})

	it("detects whitespace pattern: tab", () => {
		expect(computeQueryShape("a\tb").whitespacePattern).toBe("tab")
	})

	it("detects whitespace pattern: none", () => {
		expect(computeQueryShape("10118").whitespacePattern).toBe("none")
	})

	it("handles empty input gracefully", () => {
		const shape = computeQueryShape("")
		expect(shape.tokenClasses).toEqual([])
		expect(shape.segments).toEqual([])
		expect(shape.knownFormats).toEqual([])
		expect(shape.totalLength).toBe(0)
	})
})
