/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { isPostleitzahl, leitzoneOf, normalizePLZ, PLZ_LEITZONEN } from "./postleitzahl.ts"

describe("normalizePLZ", () => {
	it("strips the D- / DE- country prefix to the bare five digits", () => {
		expect(normalizePLZ("D-68161")).toBe("68161")
		expect(normalizePLZ("DE-12623")).toBe("12623")
		expect(normalizePLZ(" 80331 ")).toBe("80331")
	})

	it("returns null for non-PLZ input", () => {
		expect(normalizePLZ("8033")).toBeNull()
		expect(normalizePLZ("SW1A 1AA")).toBeNull()
		expect(normalizePLZ(68161)).toBeNull()
	})
})

describe("isPostleitzahl", () => {
	it("accepts five digits only", () => {
		expect(isPostleitzahl("12623")).toBe(true)
		expect(isPostleitzahl("1262")).toBe(false)
		expect(isPostleitzahl("D-12623")).toBe(false) // normalize first
	})
})

describe("leitzoneOf", () => {
	it("maps the first digit to its Leitzone (postal region, not a Bundesland)", () => {
		expect(leitzoneOf("12623")?.region).toContain("Berlin") // Leitzone 1
		expect(leitzoneOf("80331")?.cities).toContain("München") // Leitzone 8
		expect(leitzoneOf("D-60311")?.cities).toContain("Frankfurt am Main") // Leitzone 6, prefix stripped
	})

	it("Leitzone 6 deliberately spans three Bundesländer (Hessen / RP / Saarland)", () => {
		// The informative contrast with US ZIP first-digit→state: a Leitzone crosses state borders.
		const region = PLZ_LEITZONEN[6].region
		expect(region).toMatch(/hessen/i)
		expect(region).toContain("Rheinland-Pfalz")
		expect(region).toContain("Saarland")
	})

	it("returns null for non-PLZ input", () => {
		expect(leitzoneOf("nope")).toBeNull()
	})
})
