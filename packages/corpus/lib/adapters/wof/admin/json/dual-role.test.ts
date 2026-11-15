// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import {
	DualRoleBasis,
	dualRolePlaceOf,
	dualRoleRowRule,
	findDualRolePairs,
	readCapitalSeats,
	type DualRolePlace,
} from "#adapters/wof/admin/json/dual-role"
import type { CanonicalRow } from "#types"

const place = (over: Partial<DualRolePlace> & Pick<DualRolePlace, "id" | "name" | "placetype">): DualRolePlace => ({
	country: "DE",
	ancestors: [],
	latitude: 52.5,
	longitude: 13.4,
	bbox: null,
	population: 0,
	...over,
})

const berlinRegion = place({ id: 10, name: "Berlin", placetype: "region", bbox: [13.09, 52.34, 13.76, 52.68] })

describe("findDualRolePairs", () => {
	it("pairs a region with its same-name seat inside it", () => {
		const locality = place({ id: 20, name: "Berlin", placetype: "locality", ancestors: [10], latitude: 52.52 })

		expect(findDualRolePairs([berlinRegion], [locality], new Set(["DE|berlin"]))).toEqual([
			{ regionID: 10, localityID: 20, country: "DE", name: "Berlin", basis: DualRoleBasis.seat },
		])
	})

	it("pairs a canton with the city its name spells without the diacritic", () => {
		const canton = place({ id: 12, name: "Zurich", placetype: "region", country: "CH", latitude: 47.4, longitude: 8.6 })

		const city = place({
			id: 23,
			name: "Zürich",
			placetype: "locality",
			country: "CH",
			ancestors: [12],
			latitude: 47.37,
			longitude: 8.54,
		})

		expect(findDualRolePairs([canton], [city], new Set(["CH|zurich"]))).toEqual([
			expect.objectContaining({ regionID: 12, localityID: 23, basis: DualRoleBasis.seat }),
		])
	})

	it("pairs a non-seat locality only when it is the region's most populous", () => {
		const region = place({ id: 11, name: "Testmark", placetype: "region" })
		const same = place({ id: 21, name: "Testmark", placetype: "locality", ancestors: [11], population: 50 })
		const bigger = place({ id: 22, name: "Grosshafen", placetype: "locality", ancestors: [11], population: 9000 })

		expect(findDualRolePairs([region], [same, bigger], new Set())).toEqual([])

		expect(findDualRolePairs([region], [{ ...same, population: 10_000 }, bigger], new Set())).toEqual([
			expect.objectContaining({ regionID: 11, localityID: 21, basis: DualRoleBasis.largest }),
		])
	})

	it("refuses a same-name locality outside the region or far from its centroid", () => {
		const outside = place({ id: 20, name: "Berlin", placetype: "locality", ancestors: [99] })
		// About 160 km away, past both 15% of the region's ~46 km diagonal and the 12 km floor.
		const far = place({ id: 21, name: "Berlin", placetype: "locality", ancestors: [10], latitude: 51 })
		const seats = new Set(["DE|berlin"])

		expect(findDualRolePairs([berlinRegion], [outside, far], seats)).toEqual([])
	})

	it("reads a stored record's label point, bounding box, population and parent", () => {
		const record = {
			id: 20,
			parent_id: 10,
			name: "Berlin",
			placetype: "locality",
			country: "DE",
			nameVariants: new Map(),
			ancestors: [],
		}

		expect(
			dualRolePlaceOf(record, {
				"geom:latitude": 1,
				"geom:longitude": 2,
				"lbl:latitude": 52.5,
				"lbl:longitude": 13.4,
				"geom:bbox": "13.09,52.34,13.76,52.68",
				"gn:population": 7,
			})
		).toMatchObject({
			latitude: 52.5,
			longitude: 13.4,
			bbox: [13.09, 52.34, 13.76, 52.68],
			population: 7,
			ancestors: [10],
		})
	})
})

describe("dualRoleRowRule", () => {
	const rule = dualRoleRowRule("wof-admin", [
		{ regionID: 10, localityID: 20, country: "DE", name: "Berlin", basis: DualRoleBasis.seat },
	])

	const row = (sourceID: string, components: CanonicalRow["components"], country = "DE"): CanonicalRow => ({
		raw: Object.values(components).join(", "),
		components,
		country,
		source: "wof-admin",
		source_id: sourceID,
		license: "CC0-1.0",
	})

	it("drops a `<region>, <country>` row of the paired name in any spelling the fold joins, from any slot", () => {
		expect(rule.drops(row("wof-admin-10-default-with-country", { region: "Berlin", country: "Germany" }))).toBe(true)

		expect(
			rule.drops(row("wof-admin-10-name-deu-x-preferred-with-country", { region: "BERLÍN", country: "Deutschland" }))
		).toBe(true)
	})

	it("keeps the region alone, the region in a longer chain, another country's region and the city's own row", () => {
		expect(rule.drops(row("wof-admin-10-default-self", { region: "Berlin" }))).toBe(false)
		expect(rule.drops(row("x", { locality: "Mitte", region: "Berlin", country: "Germany" }))).toBe(false)
		expect(rule.drops(row("x", { region: "Berlin", country: "United States" }, "US"))).toBe(false)
		expect(rule.drops(row("wof-admin-20-default-with-country", { locality: "Berlin", country: "Germany" }))).toBe(false)
	})

	it("requires the paired locality's canonical `<locality>, <country>` row only", () => {
		const canonical = row("wof-admin-20-default-with-country", { locality: "Berlin", country: "Germany" })
		const form = row("wof-admin-20-default-with-country-form", { locality: "Berlin", country: "DE" })

		expect(rule.requires(canonical)).toBe(true)
		expect(rule.requires(form)).toBe(false)
	})
})

describe("readCapitalSeats", () => {
	it("reads the committed reference, keyed by country and folded name", async () => {
		const seats = await readCapitalSeats()

		expect(seats.has("DE|berlin")).toBe(true)
		expect(seats.has("CH|zurich")).toBe(true)
	})
})
