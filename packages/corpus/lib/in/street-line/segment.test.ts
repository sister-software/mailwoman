// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { INStreetLineRefusal, isINSubProvince, segmentINStreetLine } from "#in/street-line/segment"

describe("segmentINStreetLine", () => {
	it("reads the UPU description's premise number and street", () => {
		expect(segmentINStreetLine("4, Amrita Shergill Road")).toEqual({
			house_number: "4",
			street: "Amrita Shergill Road",
			omitted: 0,
		})

		expect(segmentINStreetLine("32/1, 2nd Main Road, Jayanagar")).toEqual({
			house_number: "32/1",
			street: "2nd Main Road",
			dependent_locality: "Jayanagar",
			omitted: 0,
		})
	})

	it("reads a building before the street and leaves designators and landmarks out", () => {
		expect(segmentINStreetLine("Flat 408, Tagore Road Hostel, Tagore Road")).toEqual({
			venue: "Tagore Road Hostel",
			street: "Tagore Road",
			omitted: 1,
		})

		expect(
			segmentINStreetLine("No. 484/2, 1st Floor, Rithvi Tower, Perundurai - Chennimalai Rd., Near LIC Office")
		).toEqual({ house_number: "484/2", venue: "Rithvi Tower", street: "Perundurai - Chennimalai Rd", omitted: 2 })
	})

	it("takes the number a street part opens with, but not a measure or an ordinal in the name", () => {
		expect(segmentINStreetLine("No 14 Muthuvelapa Street")).toEqual({
			house_number: "14",
			street: "Muthuvelapa Street",
			omitted: 0,
		})

		expect(segmentINStreetLine("100 Ft. Vajarahalli Main Road")).toEqual({
			street: "100 Ft. Vajarahalli Main Road",
			omitted: 0,
		})
	})

	it("drops parts that repeat the locality or the state", () => {
		expect(
			segmentINStreetLine("Hospital Road, Kozhikode, Kerala", { locality: "Kozhikode", region: "Kerala" })
		).toEqual({ street: "Hospital Road", omitted: 0 })
	})

	it("refuses a line no one reading labels", () => {
		expect(segmentINStreetLine("Nidhin Peter")).toEqual({ refused: INStreetLineRefusal.NoThoroughfare })

		expect(segmentINStreetLine("Chittoor Road Ernakulam Kochi 682018")).toEqual({
			refused: INStreetLineRefusal.PostcodeInLine,
		})

		expect(segmentINStreetLine("5B, Kiadb, Bommasandra Ind. Area, Attibele Hobli, Anekal Taluk")).toEqual({
			refused: INStreetLineRefusal.SubProvinceInLine,
		})

		expect(segmentINStreetLine("318 DB Road Near Axis Bank R.S Puram")).toEqual({
			refused: INStreetLineRefusal.LandmarkInsidePart,
		})

		// A village before the street could be a building or a sub-locality, and the line doesn't say which.
		expect(segmentINStreetLine("Kurumassery, Angamaly Kanakankadavu Road")).toEqual({
			refused: INStreetLineRefusal.PremiseUnread,
		})

		expect(
			segmentINStreetLine(
				"Hudco Colony, Gandhipuram, Dr. Alagappa Chettiar Road, Pappanaickenpalayam, Coimbatore North"
			)
		).toEqual({
			refused: INStreetLineRefusal.PremiseUnread,
		})

		expect(segmentINStreetLine("Bazullah Road, T")).toEqual({ refused: INStreetLineRefusal.SubLocalityUnread })
	})
})

describe("isINSubProvince", () => {
	it("holds census sub-districts and district designators, and no locality", () => {
		expect(isINSubProvince("Thiruvallur Sub-District")).toBe(true)
		expect(isINSubProvince("Purulia-II")).toBe(true)
		expect(isINSubProvince("Coimbatore")).toBe(false)
	})
})
