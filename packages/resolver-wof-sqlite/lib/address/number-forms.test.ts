// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file A French number with a repetition index reaches every spelling BAN stores (`3 bis` across most of France,
 *   `3 b` in Paris) before the bare number, and the same spellings stay out of a locale without the index.
 */

import { describe, expect, it } from "vitest"

import { houseNumberForms } from "#address/number-forms"
import { parseStreetLocale } from "#labels/street/normalize"

const forms = (number: string, locale: string) => [...houseNumberForms(number, parseStreetLocale(locale))]

describe("houseNumberForms", () => {
	it("tries each spelling of a repetition index under fr, the bare number last", () => {
		const spellings = ["3 bis", "3bis", "3 b", "3b", "3"]

		for (const written of ["3bis", "3 bis", "3 b", "3b"]) {
			expect(forms(written, "fr")).toEqual([written, ...spellings.filter((form) => form !== written)])
		}

		expect(forms("12 ter", "fr")).toEqual(["12 ter", "12ter", "12 t", "12t", "12"])
	})

	it("keeps a locale without repetition indexes to its letter forms", () => {
		expect(forms("12 b", "us")).toEqual(["12 b", "12b", "12"])
		expect(forms("3bis", "us")).toEqual(["3bis"])
	})

	it("leaves a French letter that names no index to the letter forms", () => {
		expect(forms("3 a", "fr")).toEqual(["3 a", "3a", "3"])
	})
})
