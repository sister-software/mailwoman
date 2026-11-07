/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { bareMunicipalityName } from "#address-records/legal-forms"

describe("bareMunicipalityName", () => {
	it("strips a US municipality's legal-form words and keeps the publisher's case", () => {
		expect(bareMunicipalityName("Town of Madison", "US")).toBe("Madison")
		expect(bareMunicipalityName("CITY OF WAUWATOSA", "US")).toBe("WAUWATOSA")
		expect(bareMunicipalityName("Charter Township of Canton", "US")).toBe("Canton")
		expect(bareMunicipalityName("Madison", "US")).toBeNull()
		expect(bareMunicipalityName("Townsend", "US")).toBeNull()
	})

	it("derives no bare form in a country whose legal-form words the table lacks", () => {
		expect(bareMunicipalityName("City of London", "GB")).toBeNull()
	})
})
