// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { parseTxNotaryAddress } from "#us/adapters/state/tx-notaries/adapter"

describe("parseTxNotaryAddress", () => {
	// Each input is a registry `Address` field.
	// The city a notary typed repeats the state, country or ZIP Code before the
	// registry's own `, TX ZIP` (#2895).
	it.each([
		["1054 Indian Paint Dr\nBELLVILLE, TX, TX 77418", "1054 Indian Paint Dr", "BELLVILLE"],
		["418 Eucharis St\nSan Antonio TX, TX 78245", "418 Eucharis St", "San Antonio"],
		["1428 Wiltshire Ave\nSan Antonio, Tx, TX 78209", "1428 Wiltshire Ave", "San Antonio"],
		["304 W Links Dr\nGodley, Texas 76044, TX 76044", "304 W Links Dr", "Godley"],
		["9430 White Chapel Lane\nHouston, TX. 77074, TX 77074", "9430 White Chapel Lane", "Houston"],
		["12712 Joplin Drive\nFrisco, Texas, USA, TX 75036", "12712 Joplin Drive", "Frisco"],
		["2304 TALL PALM DR\nTexas City, TX, US, TX 77568", "2304 TALL PALM DR", "Texas City"],
	])("reads the city of %j once its repetitions are removed", (field, street, city) => {
		expect(parseTxNotaryAddress(field)).toMatchObject({ street, city, state: { abbreviation: "TX" } })
	})

	it("keeps a city whose name begins with the state's name", () => {
		expect(parseTxNotaryAddress("2304 TALL PALM DR\nTexas City, TX 77568")).toEqual({
			street: "2304 TALL PALM DR",
			city: "Texas City",
			state: { abbreviation: "TX", name: "Texas" },
			zip: "77568",
		})
	})

	it.each([
		"2300 hickory grove trl\ntx, TX 76108",
		"1016 Merlot Drive\n76092, TX 76092",
		"13015 Silverglen Run Tr\nTexas, TX 77014",
	])("refuses %j, which states no city", (field) => {
		expect(parseTxNotaryAddress(field)).toBeNull()
	})

	it("refuses a state that isn't a US one", () => {
		expect(parseTxNotaryAddress("1 Main St\nHouston, ZZ 77002")).toBeNull()
	})
})
