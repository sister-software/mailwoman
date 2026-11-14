// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
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
