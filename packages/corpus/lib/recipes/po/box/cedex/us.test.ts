// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { mulberry32 } from "@mailwoman/core/utils"
import { describe, expect, it } from "vitest"

import { renderPmbUs, splitUSStreet } from "#recipes/po/box/cedex/us"

describe("renderPmbUs", () => {
	// Probe row invented-po-box-cedex-1773738b413b, `2510 ABBOTT PLZ, pmb 489, CARTER LAKE, IA 51510`,
	// labeled `street=ABBOTT PLZ` before the split.
	const tuple = { house_number: "2510", street: "ABBOTT PLZ", locality: "CARTER LAKE", region: "IA", postcode: "51510" }

	it("labels the street type street_suffix, as the schema's US split does", () => {
		for (let seed = 0; seed < 20; seed++) {
			const { raw, components } = renderPmbUs(mulberry32(seed), tuple)

			expect(components.street, raw).toBe("ABBOTT")
			expect(components.street_suffix, raw).toBe("PLZ")
			expect(raw).toContain("2510 ABBOTT PLZ")
		}
	})
})

describe("splitUSStreet", () => {
	it("splits the probe rows' streets into prefix, name and suffix as the skeleton writes them", () => {
		expect(splitUSStreet("E   MINERVA ST")).toEqual({ street_prefix: "E", street: "MINERVA", street_suffix: "ST" })

		expect(splitUSStreet("EAST COLLEGE STREET")).toEqual({
			street_prefix: "EAST",
			street: "COLLEGE",
			street_suffix: "STREET",
		})

		expect(splitUSStreet("ARTHUR FIEDLER LANE")).toEqual({ street: "ARTHUR FIEDLER", street_suffix: "LANE" })
		expect(splitUSStreet("239TH AVE")).toEqual({ street: "239TH", street_suffix: "AVE" })
	})

	it("joins a post-directional to the suffix and keeps a name beside every split", () => {
		expect(splitUSStreet("PENNSYLVANIA AVENUE NW")).toEqual({ street: "PENNSYLVANIA", street_suffix: "AVENUE NW" })
		expect(splitUSStreet("N ST")).toEqual({ street: "N", street_suffix: "ST" })
		expect(splitUSStreet("BROADWAY")).toEqual({ street: "BROADWAY" })
	})
})
