/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import {
	AddressConfidenceCode,
	BroadbandTechnologyCategory,
	BroadbandTechnologyCode,
	BSLFlag,
	BuildingTypeCode,
	BusinessResidentialCode,
	isBroadbandServicableLocationID,
	LandUseCode,
	pluckBroadbandTechnologyCategoryFromCode,
} from "./index.ts"

test("pluckBroadbandTechnologyCategoryFromCode: optical carrier fiber (50) plucks the Fiber category", () => {
	expect(pluckBroadbandTechnologyCategoryFromCode(BroadbandTechnologyCode.OpticalCarrierFiber)).toBe(
		BroadbandTechnologyCategory.Fiber
	)

	// The brief's literal case — 50 is BroadbandTechnologyCode.OpticalCarrierFiber.
	expect(pluckBroadbandTechnologyCategoryFromCode(50)).toBe("FIBER")
})

test("isBroadbandServicableLocationID: accepts a 10-digit string, preserving a leading zero", () => {
	expect(isBroadbandServicableLocationID("0012345678")).toBe(true)
})

test("isBroadbandServicableLocationID: rejects a number, even with matching digits", () => {
	expect(isBroadbandServicableLocationID(12_345_678)).toBe(false)
	expect(isBroadbandServicableLocationID(12_345_678 as unknown)).toBe(false)
})

test("isBroadbandServicableLocationID: rejects strings that aren't exactly 10 digits", () => {
	expect(isBroadbandServicableLocationID("123456789")).toBe(false)
	expect(isBroadbandServicableLocationID("12345678901")).toBe(false)
	expect(isBroadbandServicableLocationID("abcdefghij")).toBe(false)
})

test("BroadbandTechnologyCode: const-object shape includes the known optical fiber code", () => {
	expect(BroadbandTechnologyCode.OpticalCarrierFiber).toBe(50)
})

test("BroadbandTechnologyCategory: const-object shape includes the known Fiber category", () => {
	expect(BroadbandTechnologyCategory.Fiber).toBe("FIBER")
})

test("BusinessResidentialCode: const-object shape includes the known Residential code", () => {
	expect(BusinessResidentialCode.Residential).toBe(BuildingTypeCode.Residential)
})

test("AddressConfidenceCode: const-object shape includes the known High-confidence code", () => {
	expect(AddressConfidenceCode.High).toBe("1")
})

test("LandUseCode: const-object shape includes the known Residential code", () => {
	expect(LandUseCode.Residential).toBe(1)
})

test("BSLFlag: const-object shape includes the known Serviceable flag", () => {
	expect(BSLFlag.Serviceable).toBe(1)
})

test("BuildingTypeCode: const-object shape includes the known Residential code", () => {
	expect(BuildingTypeCode.Residential).toBe("R")
})
