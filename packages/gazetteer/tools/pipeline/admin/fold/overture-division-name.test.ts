// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The predicate is exported for direct tests.
 *
 *   The fold streams the Overture divisions theme remotely with no local fixture.
 */

import { describe, expect, it } from "vitest"

import { isDivisionName } from "#tools/pipeline/admin/fold/overture"

describe("admitting an Overture division name", () => {
	it("admits a name in the script its country writes", () => {
		// Singapore, Sri Lanka and Malaysia: their Overture primary is already Latin,
		// so `common` is the only place their own script appears.
		expect(isDivisionName("新加坡")).toBe(true)
		expect(isDivisionName("சிங்கப்பூர்")).toBe(true)
		expect(isDivisionName("ශ්‍රී ලංකාව")).toBe(true)
		expect(isDivisionName("كوالا لومڤور")).toBe(true)
	})

	it("still admits the Latin names it always did", () => {
		for (const name of ["Singapore", "Moscow", "Moskva", "Kuala Lumpur", "Bandaranayake"]) {
			expect(isDivisionName(name)).toBe(true)
		}
	})

	it("refuses the packing noise the old rule's character class refused", () => {
		for (const noise of ["(( Karis Landskommun ))", "Noise Town [old]", "a|b", "name/other", "x_y"]) {
			expect(isDivisionName(noise)).toBe(false)
		}
	})

	it("refuses a value carrying no letter, so a bare code is not a name", () => {
		expect(isDivisionName("35001")).toBe(false)
		expect(isDivisionName("   ")).toBe(false)
	})
})
