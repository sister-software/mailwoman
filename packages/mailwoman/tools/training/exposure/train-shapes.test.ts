// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import { afterAll, describe, expect, test } from "vitest"

import { countTrainShapes } from "./train-shapes.ts"

const directory = await temporaryDirectory("mw-train-shapes-")

afterAll(() => directory[Symbol.asyncDispose]())

/**
 * Writes `rows` of (source_id, source, country, span_tags) as a parquet file.
 */
async function writeParquet(name: string, rows: string): Promise<string> {
	const path = directory.path(name).toString()
	using db = await openDuckDB({ threads: 1 })

	await db.run(
		`COPY (SELECT * FROM (VALUES ${rows}) t(source_id, source, country, span_tags)) TO '${path}' (FORMAT parquet)`
	)

	return path
}

describe("countTrainShapes", () => {
	test("counts the rows the sampler's train split admits, file by file", async () => {
		const plain = await writeParquet(
			"plain.parquet",
			`('a1', 'a', 'FR', ['street', 'locality']), ('a2', 'a', 'FR', ['street', 'locality']),
			 ('b2', 'a', 'FR', ['street', 'locality'])`
		)

		const split = await writeParquet(
			"split.parquet",
			`('b1', 'b', 'US', ['venue', 'street']), ('b2', 'b', 'US', ['venue', 'street']),
			 ('b3', 'b', 'US', ['street']), (NULL, 'b', 'US', ['street'])`
		)

		const heldOut = await writeParquet("val.parquet", `('v1', 'a', 'FR', ['street'])`)
		const attribute = directory.path("split.split.json").toString()
		const manifest = directory.path("MANIFEST.json").toString()

		await writeLocalJSONFile({ val: ["b2"], test: ["b3"] }, attribute)

		await writeLocalJSONFile(
			{
				files: [
					{ path: plain, split: "train" },
					{ path: split, split_attribute: { path: attribute } },
					{ path: heldOut, split: "val" },
				],
				deletions: [],
			},
			manifest
		)

		const counts = await countTrainShapes(manifest, { threads: 1 })
		const byKey = new Map(counts.map((c) => [`${c.source}|${c.country}|${c.spanTags?.join(",")}`, c.rows]))

		// `b2` is held out in the attributed file only, so the plain file's `b2` row trains.
		expect(byKey.get("a|FR|street,locality")).toBe(3)
		// Of the attributed file: b1 trains, b2 is val, b3 is test, and the row with no id is never admitted.
		expect(byKey.get("b|US|venue,street")).toBe(1)
		expect(byKey.has("b|US|street")).toBe(false)
		// The val-only file holds no train row.
		expect(byKey.has("a|FR|street")).toBe(false)
	})

	test("refuses a manifest whose deletions it would not apply", async () => {
		const manifest = directory.path("deleting.json").toString()

		await writeLocalJSONFile({ files: [], deletions: [{ target: { source: "a" }, source_ids: ["a1"] }] }, manifest)

		await expect(countTrainShapes(manifest)).rejects.toThrow("records 1 deletions")
	})
})
