// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { sha256File } from "@mailwoman/core/crypto/hash"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/values/json"
import { openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import { describe, expect, it } from "vitest"

import { scanShortAdminRows } from "#tools/dev-tools/corpus/prominent/places"

import { readListedGroups } from "./records.ts"

const COLUMNS = "raw, span_starts, span_ends, span_tags, country, source, source_id, base_source_id"

/**
 * A corpus under the evaluation-group policy, each row a bare locality:
 *
 * - `Ashby`, group `wof-admin-1-0-0`, frozen, its row in `test`.
 * - `Brill`, a prominent-places row of group `wof-admin-2`, frozen, its row still in a `train` file.
 * - `Corby`, group `wof-admin-3-0-0`, a validation group, its row in `val`.
 * - `Dover`, a `tiger` row no list holds.
 */
async function corpus(directory: string, options: { validationSHA256?: string } = {}): Promise<string> {
	{
		using db = await openDuckDB()

		const row = (raw: string, source: string, id: string, base: string | null) =>
			`('${raw}', [0], [${raw.length}], ['locality'], 'GB', '${source}', '${id}', ${base ? `'${base}'` : "NULL::VARCHAR"})`

		const write = (name: string, rows: string[]) =>
			db.run(
				`COPY (SELECT * FROM (VALUES ${rows.join(", ")}) AS t(${COLUMNS})) TO '${directory}/${name}' (FORMAT PARQUET)`
			)

		await write("train.parquet", [
			row("Brill", "rendered-prominent-places", "rendered-prominent-places-b", "wof-admin-2"),
			row("Dover", "tiger", "tiger-9", null),
		])

		await write("test.parquet", [row("Ashby", "wof-admin", "wof-admin-1-0-0", null)])
		await write("val.parquet", [row("Corby", "wof-admin", "wof-admin-3-0-0", null)])
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

describe("readListedGroups", () => {
	it("reads both lists' groups, and the scan keeps their rows out of train and in its listed pass", async () => {
		await using directory = await temporaryDirectory("prominent-records-")
		const path = directory.path.toString()
		const manifest = await corpus(path)
		const listed = await readListedGroups(manifest)

		expect([...listed.groups].toSorted()).toEqual(["wof-admin-1-0-0", "wof-admin-2", "wof-admin-3-0-0"])

		const scan = await scanShortAdminRows({ manifest, out: path, listed: listed.groups })

		// Brill's row sits in a train file, but the re-split takes its listed group out of train.
		expect(scan.short_admin_train_rows).toBe(1)
		expect(scan.listed).toMatchObject({ groups: 3, short_admin_rows: 3 })
		expect(scan.listed?.files_read).toHaveLength(3)

		using db = await openDuckDB()

		const surfaces = (file: string) =>
			db
				.runAndReadAll(`SELECT s1 FROM read_parquet('${path}/${file}') ORDER BY s1`)
				.then((reader) => reader.getRowObjectsJson().map((row) => String(row.s1)))

		expect(await surfaces("short-admin-rows.parquet")).toEqual(["dover"])
		expect(await surfaces("listed-short-admin-rows.parquet")).toEqual(["ashby", "brill", "corby"])
	})

	it("refuses a list whose sha256 isn't the one the manifest records", async () => {
		await using directory = await temporaryDirectory("prominent-records-")

		const manifest = await corpus(directory.path.toString(), { validationSHA256: "0".repeat(64) })

		await expect(readListedGroups(manifest)).rejects.toThrow(`records ${"0".repeat(64)}`)
	})
})
