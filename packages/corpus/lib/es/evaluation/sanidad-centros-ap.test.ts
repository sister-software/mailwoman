// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { readSanidadCentre, spanishSettlementName } from "#es/evaluation/sanidad-centros-ap"

// Lines from SIAP_CENTROS.txt in the 2026 catalogue, decoded from Windows-1252.
const line = (street: string, locality: string) => [
	"114747",
	"8613",
	"21990",
	"2",
	"REQUENA - LOS COJOS",
	"1046002631",
	street,
	locality,
	"962301158",
	"N",
	"462135",
	"46354",
	"AGÈNCIA VALENCIANA DE SALUT",
	"1",
]

describe("readSanidadCentre", () => {
	it("reads the street, number, postcode and settlement in address order", () => {
		expect(readSanidadCentre(line("CALLE MAYOR, Nº 42", "COJOS (LOS)"))).toEqual({
			id: "114747",
			stratum: "province 46",
			components: { street: "CALLE MAYOR", house_number: "42", postcode: "46354", locality: "LOS COJOS" },
		})
	})

	it("yields no record for a street line without a number", () => {
		expect(readSanidadCentre(line("CALLE LA ESTRELLA, S/N", "DUQUES (LOS)"))).toMatchObject({
			refused: expect.stringMatching(/^street:/u),
		})
	})
})

describe("spanishSettlementName", () => {
	it("moves a bracketed article in front, joining an apostrophe article without a space", () => {
		expect(spanishSettlementName("REBOLLAR (EL)")).toBe("EL REBOLLAR")
		expect(spanishSettlementName("ALCÚDIA (L')")).toBe("L'ALCÚDIA")
		expect(spanishSettlementName("REQUENA")).toBe("REQUENA")
	})
})
