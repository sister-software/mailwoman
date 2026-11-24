// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { writtenPostcode } from "#labels/postcode/written-groups"

describe("writtenPostcode", () => {
	it("writes the operator's groups from a compact code", () => {
		expect(writtenPostcode("38473", "CZ")).toBe("384 73")
		expect(writtenPostcode("85110", "sk")).toBe("851 10")
		expect(writtenPostcode("4524jh", "NL")).toBe("4524 JH")
		expect(writtenPostcode("K7K6R2", "CA")).toBe("K7K 6R2")
	})

	it("leaves a code already in the operator's groups as it is", () => {
		expect(writtenPostcode(" 102 00 ", "CZ")).toBe("102 00")
		expect(writtenPostcode("H3Z 2Y7", "CA")).toBe("H3Z 2Y7")
	})

	it("returns the trimmed value for a country without a rule or a value outside the rule's shape", () => {
		expect(writtenPostcode("66798", "DE")).toBe("66798")
		expect(writtenPostcode("3847", "CZ")).toBe("3847")
		expect(writtenPostcode("CZ-38473", "CZ")).toBe("CZ-38473")
	})
})
