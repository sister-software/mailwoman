// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import { describe, expect, it } from "vitest"

import { buildHeldoutDatasetManifest, HeldoutCollectionKind } from "#tools/eval-harness/heldout/dataset/manifest"
import { sampleReserveRows } from "#tools/eval-harness/heldout/dataset/reserve"

const COLUMNS = "raw, span_starts, span_ends, span_tags, country, source, source_id, base_source_id"
const SPANS = "[0], [4], ['street']"

describe("sampleReserveRows", () => {
	it("draws whole train groups per country, never a held-out, excluded or required group", async () => {
		await using directory = await temporaryDirectory("heldout-reserve-")
		const train = directory.path("train.parquet").toString()
		const split = directory.path("split.parquet").toString()
		const attribute = directory.path("split.split.json").toString()

		const ids = Array.from({ length: 12 }, (_, i) => `a${i}`)

		{
			using db = await openDuckDB()

			await db.run(
				`COPY (SELECT * FROM (VALUES ${[
					...ids.map((id) => `('Main', ${SPANS}, 'NZ', 'oa-nz', '${id}', NULL)`),
					...ids.map((id) => `('MAIN', ${SPANS}, 'NZ', 'oa-nz', '${id}+case-upper', '${id}')`),
					`('Taupo', ${SPANS}, 'NZ', 'rendered-prominent-places', 'rendered-prominent-places-aa', 'wof-admin-5')`,
				].join(", ")}) t(${COLUMNS})) TO '${train}' (FORMAT PARQUET)`
			)

			// `h1` has one held-out row, so its train row isn't eligible either.
			await db.run(
				`COPY (SELECT * FROM (VALUES ('Elm', ${SPANS}, 'NZ', 'oa-nz', 'h1', NULL), ` +
					`('ELM', ${SPANS}, 'NZ', 'oa-nz', 'h1+case-upper', 'h1')) t(${COLUMNS})) TO '${split}' (FORMAT PARQUET)`
			)
		}

		await writeLocalJSONFile({ attribute: "split", val: [], test: ["h1"] }, attribute)

		const manifest = directory.path("MANIFEST.json").toString()

		await writeLocalJSONFile(
			{
				files: [
					{ path: train, split: "train" },
					{ path: split, split_attribute: { path: attribute, sha256: await sha256File(attribute) } },
				],
			},
			manifest
		)

		const sample = await sampleReserveRows({
			manifest,
			groupsPerCountry: 20,
			seed: 3,
			exclusions: [{ datasetID: "confirm", version: "v", groups: ["a0"] }],
			required: { receipts: [], records: new Map([[5, "NZ"]]) },
		})

		const groups = new Set(sample.rows.map((row) => row.group))

		expect([...groups].toSorted()).toEqual(ids.slice(1).toSorted())
		// One row per record: the base row and its augmentation share the record `a<i>`, then `a<i>+case-upper`.
		expect(sample.rows).toHaveLength(22)
		expect(sample.rule.reserveGroups).toEqual([{ country: "NZ", kind: "address", groups: 11 }])
		expect(sample.rule.requiredTrainingGroups?.byCountry).toEqual({ NZ: 1 })

		const few = await sampleReserveRows({ manifest, groupsPerCountry: 3, seed: 3 })

		expect(new Set(few.rows.map((row) => row.group)).size).toBe(3)
		expect(few.rows.every((row) => row.group !== "h1")).toBe(true)

		const built = buildHeldoutDatasetManifest({
			datasetID: "reserve-test",
			createdAt: "2026-11-22T00:00:00.000Z",
			drawnFrom: { manifest, sha256: await sha256File(manifest), corpusVersion: null, files: few.files },
			sampling: { ...few.rule, engine: "duckdb test" },
			cells: few.counts,
			rows: few.rows,
			rowsFilePath: "reserve-test.rows.jsonl",
		})

		expect(built.collectionKind).toBe(HeldoutCollectionKind.Reserve)
	})
})
