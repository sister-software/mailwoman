// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { describe, expect, it } from "vitest"

import { writeDelimitedFixture } from "#test-kit"
import { createStateNyNotariesAdapter } from "#us/adapters/state/ny-notaries/adapter"

// The publisher's header, including the space before ` Business City`.
const HEADER =
	"Commission Holder Name,Commission Number (UID),Business Name (if available),Business Address 1 (if available)," +
	"Business Address 2 (if available), Business City (if available),Business State (if available)," +
	"Business Zip (if available),Commissioned County,Commission Type (Traditional or Electronic),Term Issue Date," +
	"Term Expiration Date,Georeference"

describe("state-ny-notaries adapter", () => {
	it("labels a POB line po_box with its number, on either address line", async () => {
		// Commissions 02AL6233905, 02BI5007182 and 02CA4769442 in the 2026-05 file.
		// The holder and business names are blanked here.
		await using scratch = await temporaryDirectory("mailwoman-ny-notaries-")

		const path = await writeDelimitedFixture(scratch.path("test.csv"), HEADER, [
			",02AL6233905,,POB 353,,ITHACA,NY,14851,Tompkins,Traditional,01/18/2023,01/18/2027,",
			",02BI5007182,,BIONDO & HAMMER LLP,POB 1026,MONTAUK,NY,11954,Suffolk,Traditional,04/25/2023,04/25/2027,",
			",02CA4769442,,ONE PLEASANT AVE,POB 1424,PORT WASHINGTON,NY,11050,Nassau,Traditional,10/31/2022,10/31/2026,",
		])

		const rows = []

		for await (const row of createStateNyNotariesAdapter().rows({ inputPath: path })) {
			rows.push(row)
		}

		expect(rows.map((row) => [row.components.po_box, row.components.street, row.components.locality])).toEqual([
			["POB 353", undefined, "ITHACA"],
			["POB 1026", undefined, "MONTAUK"],
			["POB 1424", undefined, "PORT WASHINGTON"],
		])
	})
})
