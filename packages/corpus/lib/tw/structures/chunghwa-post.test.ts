// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Reads five of the 1,277 offices Chunghwa Post's CSV held on 2026-11-14
 *   (dataset modified 2026-04-10): a street address with a floor, a basement floor with a note,
 *   a note naming a campus or hospital, and a list of numbers before one 號.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import { workspacePath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

import { readCSVRecords } from "#recipes/scaffold"
import {
	chunghwaPostStreetLine,
	chunghwaPostStructureRecord,
	type TWChunghwaPostRow,
} from "#tw/structures/chunghwa-post"

const fixture = workspacePath("corpus", "fixtures", "tw-chunghwa-post-offices", "sample.csv")

async function readRecords() {
	const rows = (await Array.fromAsync(readCSVRecords(fixture))) as TWChunghwaPostRow[]

	return rows.map((row) => chunghwaPostStructureRecord(row, "post-office")!)
}

describe("Chunghwa Post structure records", () => {
	it("splits the street line at the number and keeps the district from its own column", async () => {
		const [beimen] = await readRecords()

		expect(beimen).toMatchObject({
			id: "000100-6",
			name: "臺北北門郵局",
			point: { latitude: 25.047246, longitude: 121.512212 },
			address: {
				postcode: "10044",
				region: "臺北市",
				subregion: "中正區",
				street: "忠孝西路一段",
				house_number: "120號",
				unit: "1樓",
			},
		})
	})

	it("leaves out a note naming the building and keeps the floor before it", async () => {
		const records = await readRecords()
		const byID = new Map(records.map((record) => [record.id, record]))

		expect(byID.get("000149-7")!.address).toMatchObject({ street: "市府路", house_number: "1號", unit: "地下2樓" })
		expect(byID.get("000279-6")!.address).toMatchObject({ street: "指南路2段", house_number: "64號" })
		expect(byID.get("000279-6")!.address).not.toHaveProperty("unit")
	})

	it("reads a list of numbers before one 號 as the house number", async () => {
		const records = await readRecords()

		expect(records.find((record) => record.id === "028121-4")!.address).toMatchObject({
			street: "中央西路2段",
			house_number: "271、273號",
		})
	})

	it("renders an office through the codex layout with its district, unseparated, and the venue set off after it", async () => {
		const [beimen] = await readRecords()
		const row = formatAddressRow({ ...beimen!.address!, venue: beimen!.name! }, "TW", { singleLine: true })

		expect(row).toMatchObject({
			raw: "10044臺北市中正區忠孝西路一段120號1樓 臺北北門郵局",
			unplaced: [],
			script: "local",
		})
	})

	it("places every component of every office the layout renders", async () => {
		for (const record of await readRecords()) {
			const components = { ...record.address!, venue: record.name! }
			const row = formatAddressRow(components, "TW", { singleLine: true })!

			expect(row.unplaced, record.id).toEqual([])
			expect(row.components, record.id).toEqual(components)
		}
	})

	it("never splits inside a section or lane number", () => {
		expect(chunghwaPostStreetLine("忠孝路434巷3號")).toEqual({ street: "忠孝路434巷", house_number: "3號" })
		expect(chunghwaPostStreetLine("中正路")).toBeNull()
		expect(chunghwaPostStreetLine("中正路10號旁")).toBeNull()
	})
})
