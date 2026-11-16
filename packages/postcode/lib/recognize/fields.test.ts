// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { isPostcodeFormat } from "@mailwoman/core/pipeline/types"
import { describe, expect, it } from "vitest"

import { LEGACY_FORMATS, PO_BOX } from "#legacy-formats/table"

describe("isPostcodeFormat over the legacy table", () => {
	it("accepts every format of the table and refuses the PO box", () => {
		for (const { format } of LEGACY_FORMATS) {
			expect(isPostcodeFormat(format), format).toBe(true)
		}

		expect(isPostcodeFormat(PO_BOX.format)).toBe(false)
	})
})
