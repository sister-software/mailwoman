// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { isPostcodeFormat } from "@mailwoman/query-shape"
import { describe, expect, it } from "vitest"

import { LEGACY_FORMATS, PO_BOX } from "#legacy-formats/table"
import { isKnownPostcodeFormat } from "#recognize/fields"

describe("isKnownPostcodeFormat", () => {
	it("accepts every format of the table and refuses the PO box", () => {
		for (const { format } of LEGACY_FORMATS) {
			expect(isKnownPostcodeFormat(format), format).toBe(true)
		}

		expect(isKnownPostcodeFormat(PO_BOX.format)).toBe(false)
	})

	it("agrees with the legacy predicate on every name in the table and a few others", () => {
		const names = [
			...LEGACY_FORMATS.map(({ format }) => format),
			PO_BOX.format,
			"",
			"postcode",
			"zip",
			"us_zip5",
			"xx_postcode",
		]

		expect(names.filter((name) => isKnownPostcodeFormat(name) !== isPostcodeFormat(name))).toEqual([])
	})
})
