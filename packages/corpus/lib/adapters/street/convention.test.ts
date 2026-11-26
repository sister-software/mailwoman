// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { withConventionStreet } from "#adapters/street/convention"

describe("withConventionStreet", () => {
	it("splits a whole US street into its directional, name and type", () => {
		expect(withConventionStreet({ house_number: "415", street: "N JACKSON ST" }, "US")).toEqual({
			house_number: "415",
			street_prefix: "N",
			street: "JACKSON",
			street_suffix: "ST",
		})
	})

	it("keeps a street that already labels an affix", () => {
		const components = { street: "BELLE VIEW", street_suffix: "BLVD" }

		expect(withConventionStreet(components, "US")).toBe(components)
	})

	it("keeps the whole street for a country whose convention is whole", () => {
		const components = { street: "Lister Lane" }

		expect(withConventionStreet(components, "GB")).toBe(components)
	})
})
