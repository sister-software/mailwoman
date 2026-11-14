// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { parseJSONStrict } from "@mailwoman/core/json"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { reduceWOFFeature } from "@mailwoman/gazetteer/whosonfirst/record-store"
import { Globerator } from "spliterator/node/fs"
import { describe, expect, it } from "vitest"

import { readRefutedParentIDs, recordFromFeature, type WOFFeature } from "#utils/wof-json"

describe("the record store's reduced features", () => {
	it("parse to the same corpus record as the GeoJSON file, for every fixture record", async () => {
		const files = await Globerator.from("wof-*-json/**/*.geojson", {
			cwd: resolvePackagePath("@mailwoman/corpus", "fixtures"),
			absolute: true,
		}).toArray()

		const refuted = await readRefutedParentIDs()

		expect(files.length).toBeGreaterThan(0)

		for (const file of files) {
			const text = await readLocalTextFile(file)
			const reduced = reduceWOFFeature(text)
			const full = recordFromFeature(parseJSONStrict<WOFFeature>(text), refuted)

			expect(reduced ? recordFromFeature(parseJSONStrict<WOFFeature>(reduced.feature), refuted) : null, file).toEqual(
				full
			)
		}
	})
})
