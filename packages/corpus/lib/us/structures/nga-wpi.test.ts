// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { wpiCountryCode, wpiStructureRecord } from "#us/structures/nga-wpi"

describe("wpiCountryCode", () => {
	it("reads a GENC name through the codex lookup, then through the GENC table", () => {
		expect(wpiCountryCode("United States")).toBe("US")
		expect(wpiCountryCode("Burma")).toBe("MM")
		expect(wpiCountryCode("Congo (Kinshasa)")).toBe("CD")
		expect(wpiCountryCode("Wake Island")).toBe("UM")
	})

	it("refuses a name neither table holds", () => {
		expect(() => wpiCountryCode("Atlantis")).toThrow(/Atlantis/)
	})
})

describe("wpiStructureRecord", () => {
	it("files a port as a seaport stamped with its own country and no address", () => {
		// The first row of UpdatedPub150.csv in the 2026-11-20 archive, reduced to the columns read.
		const record = wpiStructureRecord({
			world_port_index_number: "8225.0",
			main_port_name: "Annapolis",
			country_code: "United States",
			latitude: "38.983333000000002",
			longitude: "-76.483333000000002",
		})

		expect(record).toEqual({
			id: "8225",
			name: "Annapolis",
			category: "seaport",
			point: { latitude: 38.983333000000002, longitude: -76.483333000000002 },
			address: null,
			country: "US",
		})
	})

	it("refuses a port number that isn't whole", () => {
		expect(() =>
			wpiStructureRecord({ world_port_index_number: "8225.5", country_code: "Norway", latitude: "", longitude: "" })
		).toThrow(/whole port number/)
	})

	it("records no point for an empty coordinate rather than a point at 0, 0", () => {
		const record = wpiStructureRecord({
			world_port_index_number: "1",
			main_port_name: "Nowhere",
			country_code: "Norway",
			latitude: "",
			longitude: "",
		})

		expect(record.point).toBeNull()
	})
})
