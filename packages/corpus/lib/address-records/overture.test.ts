/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { overtureAddressRecord, type OvertureAddressRow } from "#address-records/overture"

/**
 * The May 2026 release's row for 1927 Blessings Ave, Lorida, from Highlands County's OpenAddresses run.
 */
const LORIDA: OvertureAddressRow = {
	id: "08b2a8e3c5a6dfff0200b9d2e5c1a0b1",
	country: "US",
	postcode: null,
	street: "BLESSINGS AVE",
	number: "1927",
	unit: null,
	address_levels: [{ value: "FL" }, { value: "LORIDA" }],
	postal_city: null,
	sources: [{ dataset: "OpenAddresses/FL/Highlands County", record_id: "a3c9e144-facf-40f3-a174-84fe9d81df5e" }],
	lon: -81.249841,
	lat: 27.4409658,
}

describe("overtureAddressRecord", () => {
	it("keeps the source id today's builder writes, and reads the state as the subdivision", () => {
		expect(overtureAddressRecord(LORIDA, "en")).toMatchObject({
			source: "overture:OpenAddresses/FL/Highlands County",
			sourceRecordID: "a3c9e144-facf-40f3-a174-84fe9d81df5e",
			country: "US",
			subdivision: "US-FL",
			number: "1927",
			lat: 27.4409658,
		})
	})

	it("states the region, the locality with its bare form, and the postal city", () => {
		const record = overtureAddressRecord(
			{ ...LORIDA, address_levels: [{ value: "WI" }, { value: "Town of Madison" }], postal_city: "Madison" },
			"en"
		)

		expect(record?.names.map(({ level, form, value }) => `${level}:${form}:${value}`)).toEqual([
			"region:written:WI",
			"locality:written:Town of Madison",
			"locality:bare:Madison",
		])
	})

	it("reads no subdivision from a region name, and takes the row id when the source states none", () => {
		const record = overtureAddressRecord(
			{
				...LORIDA,
				country: "IT",
				address_levels: [{ value: "Lombardia" }, { value: "Milano" }],
				sources: [{ dataset: "Comune di Milano", record_id: null }],
			},
			"it"
		)

		expect(record).toMatchObject({ subdivision: null, sourceRecordID: LORIDA.id, source: "overture:Comune di Milano" })
	})

	it("refuses a row without a number, a source or a position", () => {
		expect(overtureAddressRecord({ ...LORIDA, number: " " }, "en")).toBeNull()
		expect(overtureAddressRecord({ ...LORIDA, sources: [] }, "en")).toBeNull()
		expect(overtureAddressRecord({ ...LORIDA, lat: null }, "en")).toBeNull()
	})
})
