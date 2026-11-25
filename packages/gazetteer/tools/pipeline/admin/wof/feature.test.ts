// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { stringifyJSON } from "@mailwoman/core/values/json"
import { Globerator } from "spliterator/node/fs"
import { describe, expect, it } from "vitest"

import { ADMIN_PLACETYPES } from "#tools/pipeline/admin/ingest-wof"
import { extractWOFFeature } from "#tools/pipeline/admin/wof/feature"
import { reduceWOFFeature } from "#whosonfirst/record-store"

const ALL_PLACETYPES = new Set([...ADMIN_PLACETYPES, "postalcode"])

describe("extractWOFFeature over the record store's reduced features", () => {
	it("extracts the same fields as from the GeoJSON file, for every fixture record", async () => {
		const files = await Globerator.from("wof-*-json/**/*.geojson", {
			cwd: resolvePackagePath("@mailwoman/corpus", "fixtures"),
			absolute: true,
		}).toArray()

		expect(files.length).toBeGreaterThan(0)

		for (const file of files) {
			const text = await readLocalTextFile(file)
			const reduced = reduceWOFFeature(text)

			expect(reduced, file).not.toBeNull()
			expect(extractWOFFeature(reduced!.feature, ALL_PLACETYPES), file).toEqual(extractWOFFeature(text, ALL_PLACETYPES))
		}
	})
})

describe("the names extractWOFFeature keeps", () => {
	const namesOf = (names: Record<string, string[]>) =>
		extractWOFFeature(
			stringifyJSON({ properties: { "wof:id": 1, "wof:placetype": "region", "wof:country": "SG", ...names } }),
			ADMIN_PLACETYPES
		)?.names

	it("keeps the colloquial, unclassified and subtagged names an address writes", () => {
		expect(
			namesOf({
				"name:eng_x_preferred": ["Singapore"],
				"name:eng_x_colloquial": ["Lion City", "Singers"],
				"name:eng_x_unknown": ["SG"],
				"name:zho_tw_x_preferred": ["新加坡"],
				"name:zho_min_nan_x_preferred": ["Sin-ka-pho"],
			})
		).toEqual([
			{ name: "Singapore", language: "eng", privateuse: "preferred", official: 1 },
			{ name: "Lion City", language: "eng", privateuse: "colloquial", official: 0 },
			{ name: "Singers", language: "eng", privateuse: "colloquial", official: 0 },
			{ name: "SG", language: "eng", privateuse: "unknown", official: 0 },
			// The official flag reads the base language, so a subtagged Chinese name is official where Chinese is.
			{ name: "新加坡", language: "zho_tw", privateuse: "preferred", official: 1 },
			{ name: "Sin-ka-pho", language: "zho_min_nan", privateuse: "preferred", official: 1 },
		])
	})

	it("leaves out historical names and keys outside the name grammar", () => {
		expect(
			namesOf({
				"name:fra_x_historical": ["Département des Basses-Pyrénées"],
				"name:eng_x_preferred_abbreviation": ["CRD"],
				"name:eng": ["Singapore"],
			})
		).toEqual([])
	})
})

describe("the lifecycle flags extractWOFFeature stores", () => {
	const flagsOf = (properties: Record<string, string>) => {
		const record = { "wof:id": 1, "wof:placetype": "neighbourhood", "wof:country": "IN", ...properties }
		const feature = extractWOFFeature(stringifyJSON({ properties: record }), ADMIN_PLACETYPES)

		return [feature?.isDeprecated, feature?.isCeased]
	}

	it("sets deprecated and ceased only for a date", () => {
		expect(flagsOf({ "edtf:deprecated": "2024-03-01", "edtf:cessation": "2019" })).toEqual([1, 1])
		// WOF writes EDTF's unknown date on current records, such as 100,860 Indian `neighbourhood` records.
		expect(flagsOf({ "edtf:deprecated": "uuuu", "edtf:cessation": "uuuu" })).toEqual([0, 0])
		expect(flagsOf({ "edtf:deprecated": "", "edtf:cessation": "" })).toEqual([0, 0])
	})
})
