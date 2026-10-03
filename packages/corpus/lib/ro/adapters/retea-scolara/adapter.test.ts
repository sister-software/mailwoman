import { describe, expect, it } from "vitest"

import {
	readHouseNumber,
	readReteaScolaraUnit,
	ReteaScolaraRefusal,
	type ReteaScolaraUnit,
} from "#ro/adapters/retea-scolara/adapter"

function unit(fields: Record<string, string>): ReteaScolaraUnit {
	return {
		"Localitate unitate": "BLAJ",
		"Denumire lunga unitate": 'ȘCOALA GIMNAZIALĂ "TOMA COCIȘIU" BLAJ',
		"Cod postal": "515400",
		...fields,
	}
}

describe("ro-retea-scolara", () => {
	it("renders the street, number, postcode and locality the sheet splits", () => {
		const reading = readReteaScolaraUnit(unit({ Strada: "REPUBLICII", Numar: "48" }))

		expect("admitted" in reading).toBe(true)

		if (!("admitted" in reading)) return

		expect(reading.admitted.components).toMatchObject({
			street: "REPUBLICII",
			house_number: "48",
			postcode: "515400",
			locality: "BLAJ",
		})

		expect(reading.admitted.raw).toContain("REPUBLICII 48")
		expect(reading.admitted.country).toBe("RO")
	})

	it("reads FN and a dash as no house number, and strips an nr. marker", () => {
		expect(readHouseNumber("FN")).toBe("")
		expect(readHouseNumber("-")).toBe("")
		expect(readHouseNumber("Nr. 12")).toBe("12")
		expect(readHouseNumber("12-14")).toBe("12-14")
	})

	it("leaves a postcode that is not six digits out of the row", () => {
		const reading = readReteaScolaraUnit(unit({ Strada: "PRINCIPALA", Numar: "1", "Cod postal": "51711" }))

		expect("admitted" in reading && reading.admitted.components.postcode).toBeFalsy()
	})

	it("refuses a unit with neither a street nor a number, and one with no locality", () => {
		expect(readReteaScolaraUnit(unit({ Strada: "", Numar: "FN" }))).toEqual({
			refused: ReteaScolaraRefusal.PremiseAbsent,
		})

		expect(readReteaScolaraUnit(unit({ Strada: "X", Numar: "1", "Localitate unitate": "" }))).toEqual({
			refused: ReteaScolaraRefusal.LocalityAbsent,
		})
	})
})
