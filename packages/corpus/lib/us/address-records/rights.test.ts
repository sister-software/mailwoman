// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The US address layer reads a source only when its register decisions permit serving the rows.
 *
 *   A refused decision, an unread one and a source with no register row are each excluded, whatever terms
 *   OpenAddresses records, and the committed register keeps every refused publisher out.
 */

import { LicenseReviewState, OperationPermission, PermissionBasis } from "@mailwoman/license/decision"
import { describe, expect, it } from "vitest"

import type { RegisterDecisions } from "#source-register/corpus-inputs"
import { admitUSStateSources, readUSAddressSourceAdmission } from "#us/address-records/rights"

const permitted = { permission: OperationPermission.Permitted, basis: PermissionBasis.OtherDocumented, because: "x" }

const elected = (licenseID: string, operations: Record<string, typeof permitted>) => ({
	licenseID,
	state: LicenseReviewState.Elected,
	electedTerms: "terms",
	retrievedCopy: "copy",
	electedBecause: "x",
	operations,
})

const serving = { fetch: permitted, extract: permitted, "redistribute-data": permitted }

const REGISTER: RegisterDecisions = {
	licenses: [
		elected("lic-nad", serving),
		elected("lic-overture", serving),
		elected("lic-open", serving),
		elected("lic-training-only", { fetch: permitted, extract: permitted, transform: permitted, train: permitted }),
		{ licenseID: "lic-closed", state: LicenseReviewState.Refused, refusedBecause: "Withholds redistribution. More." },
	],
	sources: [
		{ sourceID: "nad", license: "lic-nad" },
		{ sourceID: "overture", license: "lic-overture" },
		{ sourceID: "open", license: "lic-open" },
		{ sourceID: "training-only", license: "lic-training-only" },
		{ sourceID: "closed", license: "lic-closed" },
	],
}

const TABLE = {
	"usgov-nad": ["nad"],
	"openaddresses:us/tx/open": ["open"],
	"openaddresses:us/tx/closed": ["closed"],
	"openaddresses:us/tx/training_only": ["training-only"],
	"overture:OpenAddresses/TX/Open": ["open", "overture"],
	"overture:OpenAddresses/TX/Closed": ["closed", "overture"],
}

describe("admitUSStateSources", () => {
	const admitTexas = async (excludeUnread?: boolean) =>
		admitUSStateSources(
			"TX",
			{
				hasNAD: true,
				datasets: ["OpenAddresses/TX/Open", "OpenAddresses/TX/Closed"],
				plan: [
					{ member: "us/tx/open" },
					{ member: "us/tx/closed" },
					{ member: "us/tx/training_only" },
					{ member: "us/tx/unmapped" },
					{ member: "us/ok/open" },
				],
			},
			await readUSAddressSourceAdmission(REGISTER, TABLE),
			excludeUnread
		)

	it("reads only the sources whose every register row permits serving the rows", async () => {
		const sources = await admitTexas()

		expect(sources.hasNAD).toBe(true)
		expect(sources.datasets).toEqual(["OpenAddresses/TX/Open"])
		expect(sources.runs.map(({ member }) => member)).toEqual(["us/tx/open"])
	})

	it("excludes a refused decision, an unread operation and an unmapped run, each with its reason", async () => {
		const sources = await admitTexas()

		expect(sources.excluded.map(({ source, reason }) => [source, reason])).toEqual([
			["overture:OpenAddresses/TX/Closed", "refused"],
			["openaddresses:us/tx/closed", "refused"],
			["openaddresses:us/tx/training_only", "unread"],
			["openaddresses:us/tx/unmapped", "no-register-row"],
		])

		expect(sources.excluded[0]?.because).toBe("Withholds redistribution.")
		expect(sources.admittedUnread).toEqual([])
	})

	it("still excludes a refused source when told to admit unread and unmapped ones, and lists those it admits", async () => {
		const sources = await admitTexas(false)

		expect(sources.datasets).toEqual(["OpenAddresses/TX/Open"])

		expect(sources.runs.map(({ member }) => member)).toEqual(["us/tx/open", "us/tx/training_only", "us/tx/unmapped"])

		expect(sources.excluded.map(({ source }) => source)).toEqual([
			"overture:OpenAddresses/TX/Closed",
			"openaddresses:us/tx/closed",
		])

		expect(sources.admittedUnread.map(({ source, reason }) => [source, reason])).toEqual([
			["openaddresses:us/tx/training_only", "unread"],
			["openaddresses:us/tx/unmapped", "no-register-row"],
		])
	})
})

describe("readUSAddressSourceAdmission", () => {
	it("refuses each publisher whose register decision refuses its terms, through its run and its Overture copy", async () => {
		const admission = await readUSAddressSourceAdmission()

		const refused = [
			"openaddresses:us/il/cook",
			"openaddresses:us/ca/san_luis_obispo",
			"openaddresses:us/ca/el_dorado",
			"openaddresses:us/fl/brevard",
			"openaddresses:us/id/ada",
			"openaddresses:us/mi/kent",
			"overture:OpenAddresses/CA/Mono County",
			"overture:OpenAddresses/MI/Kent County",
		]

		expect(refused.map((source) => admission(source)?.reason)).toEqual(refused.map(() => "refused"))
	})

	it("decides the 2026-11-21 terms reading's runs through their publishers' rows", async () => {
		const admission = await readUSAddressSourceAdmission()

		const reasons = Object.fromEntries(
			[
				// WVDHSEM's SAMS data, refused on its redistribution clause across the statewide run and the county copies.
				"openaddresses:us/wv/statewide",
				"openaddresses:us/wv/lewis",
				// Buncombe's no-sale clause refuses redistribute-data and permits training.
				"openaddresses:us/nc/buncombe",
				// Contractor-hosted with only the contractor's metadata.
				"openaddresses:us/ia/cass",
				// Elected on metadata that states no terms, and on CC0 1.0.
				"openaddresses:us/ri/city_of_cranston",
				"openaddresses:us/tx/anderson",
			].map((source) => [source, admission(source)?.reason ?? "admitted"])
		)

		expect(reasons).toEqual({
			"openaddresses:us/wv/statewide": "refused",
			"openaddresses:us/wv/lewis": "refused",
			"openaddresses:us/nc/buncombe": "refused",
			"openaddresses:us/ia/cass": "unread",
			"openaddresses:us/ri/city_of_cranston": "admitted",
			"openaddresses:us/tx/anderson": "admitted",
		})
	})

	it("admits NAD and excludes a run no register row names", async () => {
		const admission = await readUSAddressSourceAdmission()

		// NAD's disclaimer requires an indemnity.
		// The decision records it as an obligation, and it restricts no use.
		expect(admission("usgov-nad")).toBeNull()
		expect(admission("openaddresses:us/xx/nowhere")?.reason).toBe("no-register-row")
	})
})
