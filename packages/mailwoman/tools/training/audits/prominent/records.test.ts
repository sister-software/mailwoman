// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import { describe, expect, it } from "vitest"

import { readHeldOutByDesign } from "./records.ts"

/**
 * A corpus of three WOF records under the evaluation-group policy:
 *
 * - record 1: its one group is frozen, and its rows sit in `test`.
 * - record 2: its prominent-places group `wof-admin-2` is frozen, and its `wof-admin` group trains.
 * - record 3: its one group is a validation group, and its rows sit in `val`.
 */
async function corpus(directory: string, options: { validationSHA256?: string } = {}): Promise<string> {
	{
		using db = await openDuckDB()

		const write = (name: string, rows: string) =>
			db.run(
				`COPY (SELECT * FROM (VALUES ${rows}) AS t(source_id, base_source_id)) TO '${directory}/${name}' (FORMAT PARQUET)`
			)

		await write("train.parquet", "('wof-admin-2-0-0', NULL::VARCHAR), ('tiger-9', NULL)")
		await write("test.parquet", "('wof-admin-1-0-0', NULL::VARCHAR), ('rendered-prominent-places-a', 'wof-admin-2')")
		await write("val.parquet", "('wof-admin-3-0-0', NULL::VARCHAR)")
	}

	const frozen = `${directory}/evaluation-groups.json`
	const validation = `${directory}/validation-groups.json`

	await writeLocalTextFile(
		stringifyJSON({
			attribute: "evaluation-groups",
			datasets: [{ datasetID: "heldout-test", version: "0000000000000000", rows: 2, groups: 2 }],
			groups: ["wof-admin-1-0-0", "wof-admin-2"],
		}),
		frozen
	)

	await writeLocalTextFile(
		stringifyJSON({
			attribute: "validation-groups",
			quota: { margin: 2, minimumRows: 200, capRows: 20_000 },
			evaluationGroups: { sha256: await sha256File(frozen) },
			groups: ["wof-admin-3-0-0"],
		}),
		validation
	)

	const manifest = `${directory}/MANIFEST.json`

	await writeLocalTextFile(
		stringifyJSON({
			files: ["train", "test", "val"].map((split) => ({ path: `${directory}/${split}.parquet`, split })),
			evaluation_groups: {
				paths: { evaluationGroups: frozen, validationGroups: validation },
				evaluationGroups: { sha256: await sha256File(frozen) },
				validationGroups: { sha256: options.validationSHA256 ?? (await sha256File(validation)) },
			},
		}),
		manifest
	)

	return manifest
}

describe("readHeldOutByDesign", () => {
	it("holds out a listed record only when no group of its trains", async () => {
		await using directory = await temporaryDirectory("prominent-records-")

		const held = await readHeldOutByDesign(await corpus(directory.path.toString()))

		expect([...held.records].toSorted()).toEqual([1, 3])
		expect(held.listed_records).toBe(3)
		expect(held.trained_records).toBe(1)
	})

	it("refuses a list whose sha256 isn't the one the manifest records", async () => {
		await using directory = await temporaryDirectory("prominent-records-")

		const manifest = await corpus(directory.path.toString(), { validationSHA256: "0".repeat(64) })

		await expect(readHeldOutByDesign(manifest)).rejects.toThrow(`records ${"0".repeat(64)}`)
	})
})
