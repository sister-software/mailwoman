// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { JSONSpliterator } from "spliterator"
import { describe, expect, it } from "vitest"

import type { ClassRoots } from "#tools/fetch/wikidata/vital-places/classify"
import type { VitalEntity, VitalEntityRecord } from "#tools/fetch/wikidata/vital-places/entities"
import { buildInventory, type VitalPlace, writeInventory } from "#tools/fetch/wikidata/vital-places/inventory"

function entity(qid: string, qrank: number, classes: string[], extra: Partial<VitalEntity> = {}): VitalEntity {
	return {
		qid,
		qrank,
		classes,
		countries: ["Q142"],
		coordinate: { lat: 48.8, lon: 2.3 },
		population: null,
		sitelinks: 10,
		labels: { en: qid },
		aliases: {},
		...extra,
	}
}

const ROOTS: ClassRoots = {
	Q1440476: ["Q811979"],
	Q515: ["Q2221906"],
	Q178561: ["Q1190554"],
	Q5: [],
}

const CODES = { Q142: "FR", Q30: "US", Q15180: null }

describe("buildInventory", () => {
	const records: VitalEntityRecord[] = [
		entity("Q243", 100, ["Q1440476"]),
		entity("Q90", 900, ["Q515", "Q1440476"], { countries: ["Q142", "Q30"] }),
		entity("Q1", 50, ["Q515"], { countries: ["Q15180"] }),
		entity("Q2", 40, ["Q178561", "Q1440476"]),
		entity("Q3", 30, ["Q5"]),
		entity("Q4", 20, ["Q515"], { coordinate: null }),
		{ qid: "Q5", qrank: 10, missing: true },
	]

	it("keeps the located places with the place verdict, ranked, with their country codes", () => {
		const { places } = buildInventory(records, ROOTS, CODES)

		expect(places.map((place) => place.qid)).toEqual(["Q90", "Q243", "Q1"])
		expect(places[0]!.countryCodes).toEqual(["FR", "US"])
		expect(places[2]!.countryCodes).toEqual([])
	})

	it("reconciles every record under a reason and counts places by country and class", () => {
		const { counts } = buildInventory(records, ROOTS, CODES)

		expect(counts).toEqual({
			records: 7,
			places: 3,
			excluded: { missing: 1, "no-coordinate": 1, excluded: 1, unclassified: 1 },
			byCountry: { FR: 2, US: 1, "??": 1 },
			byClass: { Q515: 2, Q1440476: 2 },
		})

		expect(counts.places + Object.values(counts.excluded).reduce((a, b) => a + b, 0)).toBe(counts.records)
	})
})

describe("writeInventory", () => {
	it("writes the places as JSONL and the counts as JSON", async () => {
		await using scratch = await temporaryDirectory("mailwoman-vital-inventory-")
		const inventory = buildInventory([entity("Q243", 100, ["Q1440476"])], ROOTS, CODES)

		await writeInventory(inventory, scratch.path("places.jsonl"), scratch.path("counts.json"))

		const places = await JSONSpliterator.fromAsync<VitalPlace>(scratch.path("places.jsonl")).toArray()

		expect(places.map((place) => place.qid)).toEqual(["Q243"])
		await expect(readLocalJSONFile(scratch.path("counts.json"))).resolves.toEqual(inventory.counts)
	})
})
