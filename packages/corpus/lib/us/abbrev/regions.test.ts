// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { isZipCode, StateAbbreviationZipCodePrefixRecord } from "@mailwoman/codex/us"
import { describe, expect, it } from "vitest"

import { usAbbrevRegions } from "#us/abbrev/regions"

describe("usAbbrevRegions (#2769)", () => {
	const regions = usAbbrevRegions()

	it("pairs every locality with a five-digit postcode whose leading digit the codex assigns to that state", () => {
		expect(regions.length).toBeGreaterThan(0)

		for (const region of regions) {
			expect(region.localities.length, region.code).toBeGreaterThanOrEqual(2)
			expect(region.postcodes, region.code).toHaveLength(region.localities.length)

			for (const postcode of region.postcodes) {
				expect(isZipCode(postcode), `${region.code} ${postcode}`).toBe(true)

				expect(Number(postcode[0]), `${region.code} ${postcode}`).toBe(
					StateAbbreviationZipCodePrefixRecord[region.code]
				)
			}
		}
	})
})
