// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { postcodeRetryForms } from "#labels/postcode/retry-forms"

describe("postcodeRetryForms", () => {
	it("tries the joined Dutch code before its four-digit district", () => {
		expect(postcodeRetryForms("1012 LG", "NL")).toEqual(["1012LG", "1012"])
		expect(postcodeRetryForms(" 1012 lg ", "nl")).toEqual(["1012lg", "1012"])
	})

	it("leaves out the form the lookup already tried", () => {
		expect(postcodeRetryForms("1012LG", "NL")).toEqual(["1012"])
	})

	it("returns no form for a text outside the country's shape", () => {
		expect(postcodeRetryForms("1012", "NL")).toEqual([])
		expect(postcodeRetryForms("1012  LG", "NL")).toEqual([])
		expect(postcodeRetryForms("SW1A 1AA", "NL")).toEqual([])
	})

	it("returns no form for a country without a rule, so the same shape isn't coarsened elsewhere", () => {
		expect(postcodeRetryForms("1012 LG", "BE")).toEqual([])
		expect(postcodeRetryForms("1012 LG", undefined)).toEqual([])
		expect(postcodeRetryForms("1012 LG", "constructor")).toEqual([])
	})
})
