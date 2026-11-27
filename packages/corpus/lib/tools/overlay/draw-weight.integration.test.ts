// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { describe, expect, it } from "vitest"

import { openDuckDB } from "#parquet/duckdb"
import { useScratchDir } from "#test-kit"
import { writeDrawWeightedFiles } from "#tools/overlay/draw-weight"
import { readSplitAttribute, type SplitAttributeFile } from "#tools/overlay/split/attribute"

describe("writeDrawWeightedFiles", () => {
	const scratch = useScratchDir("draw-weight")

	/**
	 * A `wof-admin` file of six rows over three records, and its split attribute
	 * holding record 3's row as test.
	 */
	async function writeBase(): Promise<{ parquet: string; splitAttribute: string }> {
		const parquet = scratch.path("base.parquet").toString()

		using db = await openDuckDB()

		await db.run(
			`COPY (SELECT 'wof-admin' AS source, 'wof-admin-' || (i % 3 + 1) || '-v' || i AS source_id, ` +
				`'place ' || i AS raw FROM range(6) t(i) ORDER BY i DESC) TO '${parquet}' (FORMAT parquet)`
		)

		const attribute: SplitAttributeFile = {
			attribute: "split",
			policyHash: "p".repeat(64),
			policy: { holdouts: {}, codeHash: "c" },
			file: { name: "base.parquet", sha256: "s", rows: 6 },
			counts: { train: 5, val: 0, test: 1 },
			val: [],
			test: ["wof-admin-3-v2"],
		}

		const splitAttribute = scratch.path("base.split.json").toString()

		await writeLocalJSONFile(attribute, splitAttribute)

		return { parquet, splitAttribute }
	}

	it("adds a weight with mean 1 over the train rows and keeps the rows, their order and the held-out ids", async () => {
		const base = await writeBase()
		const outDir = scratch.path("out")

		const summary = await writeDrawWeightedFiles({
			source: "wof-admin",
			files: [base],
			keyPattern: "^wof-admin-(\\d+)-",
			// Record 2 scores under the floor and record 3 has no score, so both take the floor.
			scores: new Map([
				[1, 0.5],
				[2, 0.01],
			]),
			floor: 0.1,
			outDir,
		})

		const [file] = summary.files

		using db = await openDuckDB()

		const read = async (path: string) =>
			(
				await db.runAndReadAll(`SELECT * FROM read_parquet('${path}', file_row_number = true) ORDER BY file_row_number`)
			).getRowObjectsJson()

		const before = await read(base.parquet)
		const after = await read(outDir(file!.parquet).toString())

		expect(after.map((row) => [row["source_id"], row["raw"]])).toEqual(
			before.map((row) => [row["source_id"], row["raw"]])
		)

		// Train rows: records 1 (two rows at 0.5), 2 (two at the floor) and 3 (one at the floor), mean 0.26.
		const weightOf = (id: string) => Number(after.find((row) => row["source_id"] === id)!["draw_weight"])

		expect(weightOf("wof-admin-1-v0")).toBeCloseTo(0.5 / 0.26)
		expect(weightOf("wof-admin-2-v1")).toBeCloseTo(0.1 / 0.26)
		expect(weightOf("wof-admin-3-v2")).toBeCloseTo(0.1 / 0.26)
		expect(summary).toMatchObject({ trainRows: 5, scoredTrainRows: 4, floorTrainRows: 3 })

		const attribute = await readSplitAttribute(outDir(file!.splitAttribute).toString())

		expect(attribute.test).toEqual(["wof-admin-3-v2"])
		expect(attribute.policyHash).toBe("p".repeat(64))
		expect(attribute.file).toMatchObject({ name: file!.parquet, rows: 6 })
		expect(file!.parquet).toBe(`wof-admin-${attribute.file.sha256}.parquet`)
	})

	it("refuses a row whose source_id names no record", async () => {
		const base = await writeBase()

		await expect(
			writeDrawWeightedFiles({
				source: "wof-admin",
				files: [base],
				keyPattern: "^wof-postalcode-(\\d+)-",
				scores: new Map(),
				floor: 0.1,
				outDir: scratch.path("out"),
			})
		).rejects.toThrow(/6 row\(s\) carry a source_id without a record id/)
	})
})
