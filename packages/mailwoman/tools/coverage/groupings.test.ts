// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, test } from "vitest"

import { ADDRESS_FORM_TAG, type CountryCoverage, type CoverageReport } from "#tools/coverage/census"
import { groupingCoverage, readGroupingRequirements } from "#tools/coverage/groupings"
import type { RoleCollections } from "#tools/eval-harness/heldout/dataset/coverage/collections"

const AT = "2026-11-24"

function coverage(country: string, overrides: Partial<CountryCoverage> = {}): CountryCoverage {
	return {
		country,
		corpusRows: 10,
		corpusStreetRows: 0,
		addressFormRows: 10,
		admitted: true,
		weightsPackage: null,
		gazetteerPlaces: 1,
		geocodeTier: "locality",
		boardRows: 1,
		boardPassedRows: 1,
		...overrides,
	}
}

function inputs(countries: CountryCoverage[]) {
	return {
		report: { countries } as CoverageReport,
		heldOut: { specVersion: "0", collections: [] } satisfies RoleCollections,
		at: AT,
	}
}

describe("ADDRESS_FORM_TAG", () => {
	test("counts the block-address tags a Japanese row writes in place of a street", () => {
		for (const tag of ["street", "street_suffix", "house_number", "block", "sub_block", "building_number"]) {
			expect(ADDRESS_FORM_TAG.test(tag)).toBe(true)
		}

		for (const tag of ["district", "postcode", "locality", "venue", "building_name"]) {
			expect(ADDRESS_FORM_TAG.test(tag)).toBe(false)
		}
	})
})

describe("groupingCoverage", () => {
	test("reads the World Bank's JG through GG and JE, holding a column only when both do", async () => {
		const requirements = await readGroupingRequirements()

		const groupings = groupingCoverage({
			...inputs([coverage("GG"), coverage("JE", { addressFormRows: 0 })]),
			requirements,
		})

		const jg = groupings.find((grouping) => grouping.id === "wb-high-income")!.members.find((m) => m.code === "JG")!

		expect(jg.readAs).toEqual(["GG", "JE"])
		expect(jg.cells?.board).toBe(true)
		expect(jg.cells?.addressFormRows).toBe(false)
	})

	test("holds the held-out column from a collection of either role, kept per role", async () => {
		const requirements = await readGroupingRequirements()

		const groupings = groupingCoverage({
			...inputs([coverage("US"), coverage("CA")]),
			heldOut: {
				specVersion: "0",
				collections: [
					{ role: "confirmation", id: "c@1", path: "c.json", addressRows: { US: 1000 } },
					{ role: "development", id: "d@1", path: "d.json", addressRows: { US: 5, CA: 500 } },
				],
			},
			requirements,
		})

		const members = groupings.find((grouping) => grouping.id === "g7")!.members
		const us = members.find((member) => member.code === "US")!
		const ca = members.find((member) => member.code === "CA")!

		expect(us.holdings[0]!.heldOutAddresses).toEqual({ confirmation: 1000, development: 5 })
		expect(ca.cells?.heldOut).toBe(true)
		expect(members.find((member) => member.code === "JP")!.cells?.heldOut).toBe(false)
	})

	test("counts every required cell of an unreadable member as a gap", async () => {
		const requirements = await readGroupingRequirements()

		const groupings = groupingCoverage({
			...inputs([]),
			requirements: {
				...requirements,
				tiers: [{ grouping: "wb-high-income", requires: ["board"], debt: 0 }],
				memberJurisdictions: {},
			},
		})

		const grouping = groupings.find((entry) => entry.id === "wb-high-income")!

		expect(grouping.unreadable).toContain("JG")
		expect(grouping.gaps).toContainEqual({ code: "JG", column: "board" })
	})
})
