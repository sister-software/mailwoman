// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { licenseExcluded } from "@mailwoman/license/policy"
import { describe, expect, it } from "vitest"

import { compileLicenseExcludes } from "#utils/license"

describe("compileLicenseExcludes", () => {
	it("builds anchored, case-insensitive prefix patterns", () => {
		const p = compileLicenseExcludes("ODbL, CC-BY-SA")

		expect(licenseExcluded("ODbL-1.0", p)).toBe(true)
		expect(licenseExcluded("odbl-1.0", p)).toBe(true)
		expect(licenseExcluded("CC-BY-SA-3.0", p)).toBe(true)
		// The prefix is anchored, so a CC-BY-SA exclusion leaves CC-BY unchanged.
		expect(licenseExcluded("CC-BY-4.0", p)).toBe(false)
		expect(licenseExcluded("Licence Ouverte 2.0", p)).toBe(false)
	})
})
