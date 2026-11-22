// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { soldUnderCommercialTerms } from "#operations"

describe("soldUnderCommercialTerms", () => {
	it("reads the commercial branch of a dual license and nothing in a single open license", () => {
		expect(soldUnderCommercialTerms("AGPL-3.0-only OR LicenseRef-Commercial")).toBe(true)
		expect(soldUnderCommercialTerms("(AGPL-3.0-only OR LicenseRef-Commercial)")).toBe(true)
		expect(soldUnderCommercialTerms("AGPL-3.0-only")).toBe(false)
		expect(soldUnderCommercialTerms("LicenseRef-Commercial-Data")).toBe(false)
	})
})
