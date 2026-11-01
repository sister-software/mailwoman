// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Each outlet of a library system is its own record, with the system's FSCSKEY in its id.
 */

import { describe, expect, it } from "vitest"

import { recordIDOf } from "#adapters/record-id"
import { useScratchDir, writeDelimitedFixture } from "#test-kit"
import { createUSGovIMLSPLSAdapter } from "#us/adapters/usgov/imls-pls/adapter"

const scratch = useScratchDir("usgov-imls-pls")

const HEADER = "STABR,FSCSKEY,FSCS_SEQ,LIBNAME,ADDRESS,CITY,ZIP,CNTY"

const OUTLETS = [
	"WY,WY0008,002,FREMONT COUNTY LIBRARY,200 NORTH 5TH STREET,LANDER,82520,FREMONT",
	"WY,WY0008,003,DUBOIS BRANCH LIBRARY,202 NORTH 1ST STREET,DUBOIS,82513,FREMONT",
	"WY,WY0008,004,RIVERTON BRANCH LIBRARY,1330 WEST PARK AVENUE,RIVERTON,82501,FREMONT",
	"WY,WY0011,002,PARK COUNTY LIBRARY,1500 HEART MOUNTAIN STREET,CODY,82414,PARK",
]

describe("usgov-imls-pls source_id", () => {
	it("makes each outlet its own record", async () => {
		const input = await writeDelimitedFixture(scratch.path("outlets.csv"), HEADER, OUTLETS)
		const rows = await Array.fromAsync(createUSGovIMLSPLSAdapter().rows({ inputPath: input }))

		expect(rows.map((row) => row.source_id)).toEqual([
			"usgov-imls-pls-WY0008-002",
			"usgov-imls-pls-WY0008-003",
			"usgov-imls-pls-WY0008-004",
			"usgov-imls-pls-WY0011-002",
		])

		// Three branches in three towns are three addresses, so no two outlets share a record.
		const records = new Set(rows.map((row) => recordIDOf(row.source_id)))

		expect(records.size).toBe(OUTLETS.length)
	})
})
