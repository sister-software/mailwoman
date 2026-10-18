/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { describe, expect, it } from "vitest"

import {
	AzerbaijanSpelling,
	type AzerbaijanPlaceRecord,
	componentsForAzerbaijanRecord,
	createAzerbaijanPlacesAdapter,
	OPENDATA_AZ_ADAPTER_ID,
	OPENDATA_AZ_LICENSE,
} from "#az/adapters/opendata/adapter"
import { runAdapter } from "#runner"
import { readCanonicalRows, useScratchDir } from "#test-kit"

const scratch = useScratchDir("opendata-az")

/**
 * Feature properties copied from `azrbaycanda_obyektlr_v_mkanlar.geojson`,
 * where an absent string reads as a single space.
 */
const POLICE = {
	OBJECTID: 1,
	CITY: "Baku",
	STATE: "Narimanov",
	STRT_NAME: "Agha Nematulla",
	STRT_ADDR: "49",
	NAME: "District police station of police department 17",
	NAME_AZ: " ",
	STATE_AZ: "Nərimanov",
	STRT_N_AZ: " ",
	CITY_AZ: "Bakı",
}

const BUSINESS_CENTER = {
	OBJECTID: 46,
	CITY: "Baku",
	STATE: "Narimanov",
	STRT_NAME: "Yusif Vazir Chamanzaminli",
	STRT_ADDR: "100",
	NAME: "Busniss centre",
	NAME_AZ: "Biznes mərkəzi",
	STATE_AZ: "Nərimanov",
	STRT_N_AZ: "Yusif Vəzir Çəmənzəminli",
	CITY_AZ: "Bakı",
}

const CARRIED = {
	OBJECTID: 9487,
	CITY: "Baku",
	STATE: "Sabail",
	STRT_NAME: "Zarifa Aliyeva,38",
	STRT_ADDR: " ",
	NAME: "JW Marriott Absheron Baku Hotel",
	NAME_AZ: " ",
	STATE_AZ: "Səbail",
	STRT_N_AZ: " ",
	CITY_AZ: "Bakı",
}

const PARENTHETICAL = {
	OBJECTID: 4092,
	CITY: "Baku",
	STATE: "Nasimi",
	STRT_NAME: "Javadkhan (Ganja Khan)",
	STRT_ADDR: "11",
	NAME: "Mugan Bank",
	NAME_AZ: " ",
	STATE_AZ: "Nəsimi",
	STRT_N_AZ: " ",
	CITY_AZ: "Bakı",
}

const BLOCK_CODE = {
	OBJECTID: 8212,
	CITY: "Baku",
	STATE: "Yasamal",
	STRT_NAME: "Huseyn Javid Avenue",
	STRT_ADDR: "535-ci0mehelle024",
	NAME: "Nicat",
	NAME_AZ: " ",
	STATE_AZ: "Yasamal",
	STRT_N_AZ: " ",
	CITY_AZ: "Bakı",
}

const BACKSLASH = {
	OBJECTID: 57,
	CITY: "Baku",
	STATE: "Nizami",
	STRT_NAME: "Jamshid Nakhicevanski",
	STRT_ADDR: "2\\55",
	NAME: "Women's salon",
	NAME_AZ: " ",
	STATE_AZ: "Nizami",
	STRT_N_AZ: " ",
	CITY_AZ: "Bakı",
}

const NO_NUMBER = {
	OBJECTID: 38,
	CITY: "Baku",
	STATE: "Surakhany",
	STRT_NAME: "Housing estate A-B",
	STRT_ADDR: "0",
	NAME: "Kindergarten 258",
	NAME_AZ: " ",
	STATE_AZ: "Suraxanı",
	STRT_N_AZ: " ",
	CITY_AZ: "Bakı",
}

const KHIRDALAN = {
	OBJECTID: 737,
	CITY: "Absheron",
	STATE: "Khirdalan",
	STRT_NAME: "Heydar Aliyev Avenue",
	STRT_ADDR: "1",
	NAME: "Auto service",
	NAME_AZ: " ",
	STATE_AZ: "Abşeron",
	STRT_N_AZ: " ",
	CITY_AZ: " ",
}

const ZABRAT = {
	OBJECTID: 9786,
	CITY: "Baku",
	STATE: "Sabunchu,Zabrat",
	STRT_NAME: "Zabrat Hwy",
	STRT_ADDR: " ",
	NAME: "SOCAR",
	NAME_AZ: " ",
	STATE_AZ: "Sabunçu,Zabrat",
	STRT_N_AZ: " ",
	CITY_AZ: "Bakı",
}

const MARKUP = {
	OBJECTID: 3651,
	CITY: "Baku",
	STATE: "Sabail",
	STRT_NAME: "{M2@{E60@{AH5@{Baku-Alat-Gazakh-Georgia HWY",
	STRT_ADDR: "0",
	NAME: "Market",
	NAME_AZ: " ",
	STATE_AZ: "Səbail",
	STRT_N_AZ: " ",
	CITY_AZ: "Bakı",
}

const SEVERAL_PARTS = {
	OBJECTID: 418,
	CITY: "Baku",
	STATE: "Surakhany",
	STRT_NAME: "Tahir Bagirov, ln 2",
	STRT_ADDR: "0",
	NAME: "Automatic telephone system 452",
	NAME_AZ: " ",
	STATE_AZ: "Suraxanı",
	STRT_N_AZ: " ",
	CITY_AZ: "Bakı",
}

const CODE_NAME = {
	OBJECTID: 5301,
	CITY: "Baku",
	STATE: "Narimanov",
	STRT_NAME: "Ahmadbay Agaoglu",
	STRT_ADDR: "0",
	NAME: "555",
	NAME_AZ: " ",
	STATE_AZ: "Nərimanov",
	STRT_N_AZ: " ",
	CITY_AZ: "Bakı",
}

const NO_STREET = {
	OBJECTID: 716,
	CITY: "Baku",
	STATE: "Surakhany",
	STRT_NAME: " ",
	STRT_ADDR: "27",
	NAME: "Library by Nizami",
	NAME_AZ: " ",
	STATE_AZ: "Suraxanı",
	STRT_N_AZ: " ",
	CITY_AZ: "Bakı",
}

const RECORDS = [
	POLICE,
	BUSINESS_CENTER,
	CARRIED,
	PARENTHETICAL,
	BLOCK_CODE,
	BACKSLASH,
	NO_NUMBER,
	KHIRDALAN,
	ZABRAT,
	MARKUP,
	SEVERAL_PARTS,
	CODE_NAME,
	NO_STREET,
] satisfies AzerbaijanPlaceRecord[]

describe("componentsForAzerbaijanRecord", () => {
	it("reads the venue, number, street, district and city", () => {
		expect(componentsForAzerbaijanRecord(POLICE)).toEqual({
			venue: "District police station of police department 17",
			house_number: "49",
			street: "Agha Nematulla",
			dependent_locality: "Narimanov",
			locality: "Baku",
		})
	})

	it("reads the Azerbaijani spelling from its own columns", () => {
		expect(componentsForAzerbaijanRecord(BUSINESS_CENTER, undefined, AzerbaijanSpelling.Azerbaijani)).toEqual({
			venue: "Biznes mərkəzi",
			house_number: "100",
			street: "Yusif Vəzir Çəmənzəminli",
			dependent_locality: "Nərimanov",
			locality: "Bakı",
		})
	})

	it("reads a number carried in the street, removes a parenthetical, and reads a backslash as a slash", () => {
		const dropped = new Map<string, number>()

		expect(componentsForAzerbaijanRecord(CARRIED, { dropped })).toMatchObject({
			street: "Zarifa Aliyeva",
			house_number: "38",
		})

		expect(componentsForAzerbaijanRecord(PARENTHETICAL, { dropped })).toMatchObject({
			street: "Javadkhan",
			house_number: "11",
		})

		expect(componentsForAzerbaijanRecord(BACKSLASH, { dropped })?.house_number).toBe("2/55")
		expect(Object.fromEntries(dropped)).toEqual({ "component:street:parenthetical-removed": 1 })
	})

	it("keeps a venue without a number, takes Absheron's settlement as the locality and a settlement within a district", () => {
		expect(componentsForAzerbaijanRecord(NO_NUMBER)).toEqual({
			venue: "Kindergarten 258",
			street: "Housing estate A-B",
			dependent_locality: "Surakhany",
			locality: "Baku",
		})

		expect(componentsForAzerbaijanRecord(KHIRDALAN)).toMatchObject({ locality: "Khirdalan" })
		expect(componentsForAzerbaijanRecord(KHIRDALAN)?.dependent_locality).toBeUndefined()
		expect(componentsForAzerbaijanRecord(ZABRAT)).toMatchObject({ dependent_locality: "Zabrat", locality: "Baku" })
	})

	it("drops a block code and a code venue, and refuses markup, a street of several parts and no street", () => {
		const dropped = new Map<string, number>()

		expect(componentsForAzerbaijanRecord(BLOCK_CODE, { dropped })).toMatchObject({
			venue: "Nicat",
			street: "Huseyn Javid Avenue",
		})

		expect(componentsForAzerbaijanRecord(BLOCK_CODE, { dropped })?.house_number).toBeUndefined()

		for (const record of [MARKUP, SEVERAL_PARTS, CODE_NAME, NO_STREET]) {
			expect(componentsForAzerbaijanRecord(record, { dropped })).toBeNull()
		}

		expect(Object.fromEntries(dropped)).toEqual({
			"component:house_number:block-code": 2,
			"row:street-markup": 1,
			"row:street-holds-several-parts": 1,
			"component:venue:code": 1,
			"row:no-house-number-or-venue": 1,
			"row:no-street": 1,
		})
	})
})

describe("opendata-az adapter", () => {
	it("emits a second row in Azerbaijani spelling where the file carries one", async () => {
		const file = scratch.path("places.geojson")

		await writeLocalTextFile(
			stringifyJSON({
				type: "FeatureCollection",
				features: RECORDS.map((properties, index) => ({
					type: "Feature",
					geometry: { type: "Point", coordinates: [49.8 + index / 1000, 40.4] },
					properties,
				})),
			}),
			file
		)

		const manifest = await runAdapter({
			adapter: createAzerbaijanPlacesAdapter(),
			adapterOptions: { inputPath: file, country: "AZ" },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		expect(manifest.yielded).toBe(10)

		const rows = await readCanonicalRows(scratch.path, OPENDATA_AZ_ADAPTER_ID)

		expect(rows.every((row) => row.license === OPENDATA_AZ_LICENSE && row.country === "AZ")).toBe(true)
		expect(rows.map((row) => row.raw)).toContain("Busniss centre, 100 Yusif Vazir Chamanzaminli, Narimanov, Baku")

		expect(rows.find((row) => row.locale === "az-AZ")?.raw).toBe(
			"Biznes mərkəzi, 100 Yusif Vəzir Çəmənzəminli, Nərimanov, Bakı"
		)
	})
})
