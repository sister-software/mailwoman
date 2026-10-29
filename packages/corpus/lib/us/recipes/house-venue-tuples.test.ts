/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The US situs reader admits a database `source` value only on its register rows' decisions.
 *
 *   OpenAddresses does not relicense the county and state bodies it collects, so each body's rows reach the tuples
 *   only when that body's own decision permits transform and train.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { LicenseReviewState, OperationPermission, PermissionBasis } from "@mailwoman/core/license/decision"
import { describe, expect, it } from "vitest"

import type { RegisterDecisions } from "#source-register/corpus-inputs"
import { admittedSitusSources, listSitusDatabases, situsStateCode } from "#us/recipes/house-venue-tuples"

const PERMITTED = {
	permission: OperationPermission.Permitted,
	basis: PermissionBasis.OtherDocumented,
	because: "x",
}

const elected = (licenseID: string) => ({
	licenseID,
	state: LicenseReviewState.Elected,
	electedTerms: "terms",
	retrievedCopy: "copy",
	electedBecause: "x",
	operations: { transform: PERMITTED, train: PERMITTED },
})

const REGISTER: RegisterDecisions = {
	licenses: [
		elected("lic-nad"),
		elected("lic-overture"),
		elected("lic-open-county"),
		{ licenseID: "lic-closed-county", state: LicenseReviewState.Refused, refusedBecause: "revocable license" },
	],
	sources: [
		{ sourceID: "nad", license: "lic-nad" },
		{ sourceID: "overture", license: "lic-overture" },
		{ sourceID: "open-county", license: "lic-open-county" },
		{ sourceID: "closed-county", license: "lic-closed-county" },
	],
}

describe("admittedSitusSources", () => {
	it("admits a body only when every register row it maps to permits training", async () => {
		await using scratch = await temporaryDirectory("mailwoman-us-tuples-")
		const table = scratch.path("us-situs-sources.json")

		await writeLocalJSONFile(
			{
				sources: {
					"overture:NAD": ["nad", "overture"],
					"overture:OpenAddresses/XX/Open County": ["open-county", "overture"],
					"overture:OpenAddresses/XX/Closed County": ["closed-county", "overture"],
					"overture:OpenAddresses/XX/Unread County": ["no-such-row", "overture"],
					openaddresses: [],
				},
			},
			table
		)

		expect(await admittedSitusSources(REGISTER, table)).toEqual(
			new Set(["overture:NAD", "overture:OpenAddresses/XX/Open County"])
		)
	})

	it("admits NAD and refuses a revocable license in the committed table", async () => {
		const admitted = await admittedSitusSources()

		expect(admitted.has("overture:NAD")).toBe(true)
		expect(admitted.has("overture:OpenAddresses/MI/Kent County")).toBe(false)
		expect(admitted.has("openaddresses")).toBe(false)
	})

	it("names the path of a missing table", async () => {
		await using scratch = await temporaryDirectory("mailwoman-us-tuples-")
		const table = scratch.path("absent.json").toString()

		await expect(admittedSitusSources(REGISTER, table)).rejects.toThrow(table)
	})
})

describe("the situs databases", () => {
	it("read a county database as its state", () => {
		expect(situsStateCode("/x/address-points-us-il-cook.db")).toBe("IL")
		expect(situsStateCode("address-points-us-ca.db")).toBe("CA")
	})

	it("name the directory that holds none", async () => {
		await using scratch = await temporaryDirectory("mailwoman-us-tuples-")
		const directory = scratch.path().toString()

		await expect(listSitusDatabases(directory)).rejects.toThrow(directory)
	})
})
