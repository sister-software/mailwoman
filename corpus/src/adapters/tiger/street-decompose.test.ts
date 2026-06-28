/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { decomposeStreet } from "./street-decompose.js"

describe("decomposeStreet", () => {
	it("leading directional + street type", () => {
		expect(decomposeStreet("N Main St")).toEqual({ prefix: "N", street: "Main", suffix: "St" })
		expect(decomposeStreet("SE Hawthorne Blvd")).toEqual({ prefix: "SE", street: "Hawthorne", suffix: "Blvd" })
		expect(decomposeStreet("N. Main Street")).toEqual({ prefix: "N.", street: "Main", suffix: "Street" })
	})

	it("trailing directional after street type", () => {
		expect(decomposeStreet("Pennsylvania Ave NW")).toEqual({
			prefix: null,
			street: "Pennsylvania",
			suffix: "Ave NW",
		})
	})

	it("just street + type", () => {
		expect(decomposeStreet("Salmon St")).toEqual({ prefix: null, street: "Salmon", suffix: "St" })
		expect(decomposeStreet("5th Ave")).toEqual({ prefix: null, street: "5th", suffix: "Ave" })
	})

	it("multi-word street name", () => {
		expect(decomposeStreet("Martin Luther King Jr Blvd")).toEqual({
			prefix: null,
			street: "Martin Luther King Jr",
			suffix: "Blvd",
		})
	})

	it("no decomposition — single token", () => {
		expect(decomposeStreet("Broadway")).toEqual({ prefix: null, street: "Broadway", suffix: null })
	})

	it("no decomposition — no known type or directional", () => {
		expect(decomposeStreet("Some Unknown Way")).toEqual({
			prefix: null,
			street: "Some Unknown",
			suffix: "Way",
		})
	})

	it("empty input", () => {
		expect(decomposeStreet("")).toEqual({ prefix: null, street: "", suffix: null })
		expect(decomposeStreet("   ")).toEqual({ prefix: null, street: "", suffix: null })
	})

	it("preserves original casing", () => {
		expect(decomposeStreet("ne main st").prefix).toBe("ne")
		expect(decomposeStreet("NE MAIN ST").prefix).toBe("NE")
	})
})
