// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Guards the GB postcode pattern without loading model weights.
 */

import { describe, expect, it } from "vitest"

import { conventionsForSystem } from "#address/system/conventions"

describe("GB address-system conventions (#1275)", () => {
	it("the declared shape accepts canonical GB postcodes and rejects the #1275 clip fragments", () => {
		const pattern = conventionsForSystem("gb")!.postcodePattern!

		for (const valid of ["SK11 9PD", "SW1A 1AA", "M1 1AE", "B33 8TH", "CR2 6XH", "DN55 1PT"]) {
			expect(valid).toMatch(pattern)
		}

		// These truncated postcode fragments do not match the canonical pattern.
		for (const clipped of ["1 9PD", "2LH", "3 2GL"]) {
			expect(clipped).not.toMatch(pattern)
		}
	})
})
