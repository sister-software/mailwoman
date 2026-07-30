/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import {
	BDCFileCategory,
	BDCStateSubCategory,
	compareProviderIDAsc,
	compareRevisionAsc,
	compareStateCodeAsc,
	parseRawBDCFile,
	type BDCFile,
	type ProviderID,
	type RawBDCFile,
} from "./common.ts"

const rawFixture: RawBDCFile = {
	file_id: 84_213,
	category: BDCFileCategory.State,
	subcategory: BDCStateSubCategory.FixedBroadband,
	technology_code: "10,11,50",
	technology_code_desc: "Asymmetric xDSL, ADSL2/ADSL2+, Optical Carrier Fiber",
	state_fips: "06",
	state_name: "California",
	provider_id: "130077",
	provider_name: "Example Broadband LLC",
	file_type: "csv",
	file_name: "bdc_06_Cable_D23_09aug2024",
	record_count: "128",
}

test("parseRawBDCFile: parses timestamps into Dates and preserves category/subcategory", () => {
	const parsed = parseRawBDCFile(rawFixture)

	expect(parsed.revision).toBeInstanceOf(Date)
	expect(parsed.vintage).toBeInstanceOf(Date)
	expect(parsed.revision.getFullYear()).toBe(2024)
	expect(parsed.revision.getMonth()).toBe(7)
	expect(parsed.revision.getDate()).toBe(9)
	expect(parsed.vintage.getFullYear()).toBe(2023)
	expect(parsed.vintage.getMonth()).toBe(11)

	expect(parsed.category).toBe(BDCFileCategory.State)
	expect(parsed.subcategory).toBe(BDCStateSubCategory.FixedBroadband)
	expect(parsed.fileID).toBe(84_213)
	expect(parsed.stateCode).toBe("06")
	expect(parsed.providerID).toBe(130_077)
	expect(parsed.recordCount).toBe(128)
	expect(parsed.technologyCodes).toEqual(new Set([10, 11, 50]))
})

function buildFile(overrides: Partial<BDCFile>): BDCFile {
	return {
		...parseRawBDCFile(rawFixture),
		...overrides,
	}
}

test("compareRevisionAsc: sorts a 3-element array ascending by revision date", () => {
	const files = [
		buildFile({ revision: new Date(2024, 7, 9) }),
		buildFile({ revision: new Date(2023, 0, 1) }),
		buildFile({ revision: new Date(2024, 11, 31) }),
	]

	const sorted = files.toSorted(compareRevisionAsc)

	expect(sorted.map((file) => file.revision.getFullYear())).toEqual([2023, 2024, 2024])
})

test("compareProviderIDAsc: sorts a 3-element array ascending by provider ID", () => {
	const files = [
		buildFile({ providerID: 300 as ProviderID }),
		buildFile({ providerID: 100 as ProviderID }),
		buildFile({ providerID: 200 as ProviderID }),
	]

	const sorted = files.toSorted(compareProviderIDAsc)

	expect(sorted.map((file) => file.providerID)).toEqual([100, 200, 300])
})

test("compareStateCodeAsc: sorts a 3-element array ascending by state FIPS code", () => {
	const files = [buildFile({ stateCode: "36" }), buildFile({ stateCode: "06" }), buildFile({ stateCode: "48" })]

	const sorted = files.toSorted(compareStateCodeAsc)

	expect(sorted.map((file) => file.stateCode)).toEqual(["06", "36", "48"])
})
