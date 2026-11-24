// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { mxStatePostalAbbreviation } from "#mx/state"

describe("mxStatePostalAbbreviation", () => {
	it("reads the sheet's names and the long constitutional names, ignoring case and accents", () => {
		expect(mxStatePostalAbbreviation("Ciudad de México")).toBe("CDMX")
		expect(mxStatePostalAbbreviation("QUINTANA ROO")).toBe("Q ROO")
		expect(mxStatePostalAbbreviation("Michoacán de Ocampo")).toBe("MICH")
		expect(mxStatePostalAbbreviation("Veracruz de Ignacio de la Llave")).toBe("VER")
		expect(mxStatePostalAbbreviation("Mexico")).toBe("MEX")
	})

	it("returns null for a name that is no Mexican state", () => {
		expect(mxStatePostalAbbreviation("Texas")).toBeNull()
	})
})
