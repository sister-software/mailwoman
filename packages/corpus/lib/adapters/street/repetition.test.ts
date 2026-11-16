// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { splitStreetLine } from "#adapters/street/line"
import { joinRepetitionIndex, withoutRepetitionIndex } from "#adapters/street/repetition"

describe("joinRepetitionIndex", () => {
	it("moves the index onto the number in a country that writes one", () => {
		expect(joinRepetitionIndex(splitStreetLine("20 BIS RUE LOUIS PHILIPPE")!, "FR")).toEqual({
			house_number: "20 BIS",
			street: "RUE LOUIS PHILIPPE",
		})
	})

	it("reads a number written against its index", () => {
		expect(joinRepetitionIndex(splitStreetLine("20BIS RUE LOUIS PHILIPPE")!, "FR")).toEqual({
			house_number: "20BIS",
			street: "RUE LOUIS PHILIPPE",
		})
	})

	it("leaves the street's first word in a country that writes no index", () => {
		const split = splitStreetLine("12 Ter Haar Road")!

		expect(joinRepetitionIndex(split, "GB")).toEqual(split)
	})

	it("leaves a street whose first word only begins with an index word", () => {
		const split = splitStreetLine("5 TERRASSE DES ROSES")!

		expect(joinRepetitionIndex(split, "FR")).toEqual(split)
	})
})

describe("withoutRepetitionIndex", () => {
	it("strips a trailing index in a country that writes one", () => {
		expect(withoutRepetitionIndex("20 BIS", "FR")).toBe("20")
		expect(withoutRepetitionIndex("20bis", "MC")).toBe("20")
		expect(withoutRepetitionIndex("20", "FR")).toBeNull()
		expect(withoutRepetitionIndex("20 BIS", "GB")).toBeNull()
	})
})
