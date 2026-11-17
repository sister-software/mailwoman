// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { COUNTY_IN_LOCALITY_SLOT } from "#tools/eval-harness/heldout/dataset/relabel"
import type { HeldoutRow } from "#tools/eval-harness/heldout/per/country"

const row = (raw: string, country: string, spans: Array<[string, string]>): HeldoutRow => ({
	raw,
	span_starts: spans.map(([, text]) => raw.indexOf(text)),
	span_ends: spans.map(([, text]) => raw.indexOf(text) + text.length),
	span_tags: spans.map(([tag]) => tag),
	country,
	source: "usgov-nad",
	source_id: "r1",
	group: "r1",
})

describe("COUNTY_IN_LOCALITY_SLOT", () => {
	it("relabels a locality written with its country's county designator as subregion, and nothing else", () => {
		// Held-out rows usgov-nad-d46e8827-…+case-lower and gleif-lei-0ee0330b18fa.
		const us = row("2368 foxden road, carter county, ok 73401", "US", [
			["house_number", "2368"],
			["street", "foxden road"],
			["locality", "carter county"],
			["region", "ok"],
		])

		const ie = row("65 Monkstown road, co Dublin, A94 DF76", "IE", [
			["street", "Monkstown road"],
			["locality", "co Dublin"],
		])

		expect(COUNTY_IN_LOCALITY_SLOT.revise(us).span_tags).toEqual(["house_number", "street", "subregion", "region"])
		expect(COUNTY_IN_LOCALITY_SLOT.revise(ie).span_tags).toEqual(["street", "subregion"])
	})

	it("leaves a locality without a designator, a designator outside the table's countries and other tags", () => {
		const town = row("12 Main St, Ardmore, OK", "US", [["locality", "Ardmore"]])
		const gb = row("County Durham", "GB", [["locality", "County Durham"]])
		const street = row("12 County Line Road, Ardmore", "US", [["street", "County Line Road"]])

		for (const unchanged of [town, gb, street]) {
			expect(COUNTY_IN_LOCALITY_SLOT.revise(unchanged)).toBe(unchanged)
		}
	})
})
