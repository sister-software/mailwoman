/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"
import { candidateSystemsForPostcode } from "./postcode-systems.js"

describe("candidateSystemsForPostcode", () => {
	it("a bare 5-digit code is eligible for every numeric-postcode system (shape can't split them)", () => {
		expect(candidateSystemsForPostcode("68161").sort()).toEqual(["de", "fr", "us"])
		expect(candidateSystemsForPostcode("75001").sort()).toEqual(["de", "fr", "us"])
	})

	it("the German D- prefix narrows to Germany alone", () => {
		expect(candidateSystemsForPostcode("D-68161")).toEqual(["de"])
	})

	it("US ZIP+4 is US-only (the -NNNN tail no other system accepts)", () => {
		expect(candidateSystemsForPostcode("94105-1234")).toEqual(["us"])
	})

	it("an alphanumeric Canadian code resolves to Canada alone", () => {
		expect(candidateSystemsForPostcode("K1A 0B1")).toEqual(["ca"])
		expect(candidateSystemsForPostcode("M5V2T6")).toEqual(["ca"])
	})

	it("a UK postcode resolves to the UK alone", () => {
		expect(candidateSystemsForPostcode("SW1A 1AA")).toEqual(["gb"])
		expect(candidateSystemsForPostcode("M1 1AE")).toEqual(["gb"])
	})

	it("a Japanese NNN-NNNN code resolves to Japan alone", () => {
		expect(candidateSystemsForPostcode("100-0001")).toEqual(["jp"])
	})

	it("a bare 4-digit code is eligible for both Australasian systems (shape can't split them)", () => {
		expect(candidateSystemsForPostcode("2000").sort()).toEqual(["au", "nz"])
		expect(candidateSystemsForPostcode("7942").sort()).toEqual(["au", "nz"])
	})

	it("returns empty for a shape no system recognizes", () => {
		expect(candidateSystemsForPostcode("27")).toEqual([])
		expect(candidateSystemsForPostcode("123456789")).toEqual([])
		expect(candidateSystemsForPostcode("")).toEqual([])
	})
})
