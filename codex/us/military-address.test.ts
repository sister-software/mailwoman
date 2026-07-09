/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import {
	isMilitaryCityLine,
	isMilitaryUnitLine,
	matchMilitaryCityLine,
	matchMilitaryUnitLine,
	US_ARMED_FORCES_REGIONS,
	US_MILITARY_POST_OFFICE_CODES,
	US_MILITARY_UNIT_DESIGNATORS,
} from "./military-address.ts"

describe("US_MILITARY_POST_OFFICE_CODES", () => {
	it("carries the three USPS Pub 28 location codes", () => {
		const codes = US_MILITARY_POST_OFFICE_CODES.map((r) => r.code).sort()
		expect(codes).toEqual(["APO", "DPO", "FPO"].sort())
	})

	it("marks APO and FPO as armed-forces codes; DPO as diplomatic", () => {
		const armedForces = US_MILITARY_POST_OFFICE_CODES.filter((r) => r.armedForces)
			.map((r) => r.code)
			.sort()
		expect(armedForces).toEqual(["APO", "FPO"].sort())
		const diplomatic = US_MILITARY_POST_OFFICE_CODES.filter((r) => !r.armedForces).map((r) => r.code)
		expect(diplomatic).toEqual(["DPO"])
	})
})

describe("US_ARMED_FORCES_REGIONS", () => {
	it("carries the three USPS armed-forces region codes", () => {
		const codes = US_ARMED_FORCES_REGIONS.map((r) => r.code).sort()
		expect(codes).toEqual(["AA", "AE", "AP"].sort())
	})
})

describe("US_MILITARY_UNIT_DESIGNATORS", () => {
	it("carries PSC, CMR, and UNIT", () => {
		const codes = US_MILITARY_UNIT_DESIGNATORS.map((r) => r.code).sort()
		expect(codes).toEqual(["CMR", "PSC", "UNIT"].sort())
	})

	it("marks PSC and CMR as requiring a BOX; UNIT does not require one", () => {
		const requiresBox = US_MILITARY_UNIT_DESIGNATORS.filter((r) => r.requiresBox)
			.map((r) => r.code)
			.sort()
		expect(requiresBox).toEqual(["CMR", "PSC"].sort())
		const noBox = US_MILITARY_UNIT_DESIGNATORS.filter((r) => !r.requiresBox).map((r) => r.code)
		expect(noBox).toEqual(["UNIT"])
	})
})

describe("matchMilitaryUnitLine", () => {
	it("matches PSC lines with required BOX", () => {
		expect(matchMilitaryUnitLine("PSC 1520 BOX 4620")).toMatchObject({ code: "PSC", id: "1520", box: "4620" })
		expect(matchMilitaryUnitLine("psc 453 box 100")).toMatchObject({ code: "PSC", id: "453", box: "100" })
	})

	it("matches CMR lines with required BOX", () => {
		expect(matchMilitaryUnitLine("CMR 453 BOX 4620")).toMatchObject({ code: "CMR", id: "453", box: "4620" })
	})

	it("matches UNIT lines with and without BOX", () => {
		expect(matchMilitaryUnitLine("UNIT 7 BOX 234A")).toMatchObject({ code: "UNIT", id: "7", box: "234A" })
		expect(matchMilitaryUnitLine("UNIT 7")).toMatchObject({ code: "UNIT", id: "7" })
		expect(matchMilitaryUnitLine("UNIT 7")?.box).toBeUndefined()
	})

	it("throws on PSC/CMR without BOX — structurally malformed per Appendix B", () => {
		expect(() => matchMilitaryUnitLine("PSC 1520")).toThrow(/BOX component/)
		expect(() => matchMilitaryUnitLine("CMR 453")).toThrow(/BOX component/)
	})

	it("returns null for non-unit-line strings", () => {
		expect(matchMilitaryUnitLine("APO AE 09165")).toBeNull()
		expect(matchMilitaryUnitLine("123 Main St")).toBeNull()
		expect(matchMilitaryUnitLine(42)).toBeNull()
		expect(matchMilitaryUnitLine("")).toBeNull()
	})

	it("isMilitaryUnitLine: returns false for malformed PSC/CMR (no BOX) rather than throwing", () => {
		expect(isMilitaryUnitLine("PSC 1520")).toBe(false) // malformed — requiresBox, no box
		expect(isMilitaryUnitLine("PSC 1520 BOX 4620")).toBe(true)
		expect(isMilitaryUnitLine("UNIT 7")).toBe(true)
	})
})

describe("matchMilitaryCityLine", () => {
	it("matches APO, FPO, DPO city lines per USPS Pub 28 Chapter 7", () => {
		// AE (Europe/ME/Africa/Canada): 09xxx ZIPs
		expect(matchMilitaryCityLine("APO AE 09165")).toMatchObject({ code: "APO", region: "AE", zip: "09165" })
		expect(matchMilitaryCityLine("DPO AE 09498")).toMatchObject({ code: "DPO", region: "AE", zip: "09498" })
		// AP (Pacific): 96xxx ZIPs
		expect(matchMilitaryCityLine("FPO AP 96602-1254")).toMatchObject({ code: "FPO", region: "AP", zip: "96602-1254" })
		expect(matchMilitaryCityLine("APO AP 96525")).toMatchObject({ code: "APO", region: "AP", zip: "96525" })
		// AA (Americas): 34xxx ZIPs
		expect(matchMilitaryCityLine("APO AA 34022")).toMatchObject({ code: "APO", region: "AA", zip: "34022" })
	})

	it("is case-insensitive", () => {
		expect(matchMilitaryCityLine("apo ae 09165")).toMatchObject({ code: "APO", region: "AE" })
		expect(matchMilitaryCityLine("Fpo Ap 96602")).toMatchObject({ code: "FPO", region: "AP" })
	})

	it("rejects invalid structural forms (non-5-digit ZIPs, bad region codes)", () => {
		// ZIP must be 5 digits (or 5+4 with hyphen); region code must be one of AA/AE/AP.
		expect(matchMilitaryCityLine("APO AE 0916")).toBeNull() // only 4 digits
		expect(matchMilitaryCityLine("APO AB 09165")).toBeNull() // AB is not a valid region
	})

	it("rejects invalid region codes", () => {
		expect(matchMilitaryCityLine("APO AB 09165")).toBeNull() // AB is not a valid region
		expect(matchMilitaryCityLine("APO CA 09165")).toBeNull() // CA is a state code, not armed forces
	})

	it("rejects non-military strings", () => {
		expect(matchMilitaryCityLine("New York, NY 10001")).toBeNull()
		expect(matchMilitaryCityLine("PSC 1520 BOX 4620")).toBeNull()
		expect(matchMilitaryCityLine(42)).toBeNull()
	})

	it("isMilitaryCityLine predicate", () => {
		expect(isMilitaryCityLine("APO AE 09165")).toBe(true)
		expect(isMilitaryCityLine("FPO AP 96602")).toBe(true)
		expect(isMilitaryCityLine("New York, NY 10001")).toBe(false)
	})
})
