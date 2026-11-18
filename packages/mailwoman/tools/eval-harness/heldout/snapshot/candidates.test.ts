// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { createUnitSplitter } from "@mailwoman/corpus/adapters/street/unit"
import { escapeSQLString, openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import type { CanonicalRow, CorpusAdapter } from "@mailwoman/corpus/types"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { readHeldoutDatasetRows } from "#tools/eval-harness/heldout/dataset/manifest"
import { buildProbeSets } from "#tools/eval-harness/heldout/probes/build"
import {
	snapshotCandidatesManifestPath,
	writeSnapshotCandidates,
} from "#tools/eval-harness/heldout/snapshot/candidates"

let scratch: TemporaryDirectory

beforeEach(async () => {
	scratch = await temporaryDirectory("snapshot-candidates-")
})

afterEach(() => scratch[Symbol.asyncDispose]())

const record = (id: string, house: string, street: string): CanonicalRow => ({
	raw: `${house} ${street}, Springfield, IL 62704`,
	components: { house_number: house, street, locality: "Springfield", region: "IL", postcode: "62704" },
	country: "US",
	source: "probe-snapshot",
	source_id: `probe-snapshot-${id}`,
	license: "public-domain",
})

const adapterOf = (rows: readonly CanonicalRow[]): CorpusAdapter =>
	({
		id: "probe-snapshot",
		async *rows() {
			yield* rows
		},
	}) as unknown as CorpusAdapter

describe("writeSnapshotCandidates", () => {
	it("keeps only the records no corpus or frozen set holds by identity, group or folded text", async () => {
		const corpusFile = scratch.path("corpus.parquet").toString()

		{
			using db = await openDuckDB()

			// The corpus holds record 1 by id and record 2's text under another id.
			await db.run(
				`COPY (SELECT * FROM (VALUES ` +
					`('1 Elm St, Springfield, IL 62704', 'probe-snapshot', 'probe-snapshot-1', NULL), ` +
					`('2 OAK ST, SPRINGFIELD, IL 62704', 'probe-snapshot', 'probe-snapshot-old-2', NULL)` +
					`) t(raw, source, source_id, base_source_id)) TO '${escapeSQLString(corpusFile)}' (FORMAT PARQUET)`
			)
		}

		const corpus = scratch.path("MANIFEST.json").toString()

		await writeLocalJSONFile({ files: [{ path: corpusFile, split: "train", source: "probe-snapshot" }] }, corpus)

		// A frozen set holds record 3's group.
		const frozen = await buildProbeSets({
			names: { development: "dev-frozen", confirmation: "confirm-frozen" },
			candidates: [0, 1].map((i) => ({
				row: {
					raw: `${3 + i * 10} Pine St, Springfield, IL 62704`,
					span_starts: [0],
					span_ends: [1],
					span_tags: ["house_number"],
					country: "US",
					source: "probe-snapshot",
					source_id: `probe-snapshot-${3 + i * 10}`,
					group: `probe-snapshot-${3 + i * 10}`,
				},
				template: "t",
			})),
			folded: new Map([
				["probe-snapshot:probe-snapshot-3", "3 pine st springfield il 62704"],
				["probe-snapshot:probe-snapshot-13", "13 pine st springfield il 62704"],
			]),
			exclusions: { groups: new Set(), texts: new Set() },
			legs: [{ source: "probe-snapshot", country: "US", quota: 1 }],
			seeds: { development: 1, confirmation: 2 },
			floor: 1,
			render: {},
			excludedBy: [],
			outDirectory: scratch.path("frozen").toString(),
			createdAt: "2026-11-18T00:00:00.000Z",
		})

		const frozenGroup = (await readHeldoutDatasetRows(frozen.development.path)).rows[0]!.group
		const frozenID = frozenGroup.replace(/^probe-snapshot-/u, "")

		const out = scratch.path("out").toString()

		const result = await writeSnapshotCandidates({
			adapter: adapterOf([
				record("1", "1", "Elm St"),
				record("2", "2", "Oak St"),
				record(frozenID, frozenID, "Pine St"),
				record("4", "4", "Birch St"),
				record("5", "4", "Birch St"),
			]),
			adapterOptions: [{ inputPath: "fixture" }],
			fetchRecord: { fixture: true },
			corpora: [corpus],
			datasets: [frozen.development.path],
			outDirectory: out,
			pathRoot: scratch.path().toString(),
			units: await createUnitSplitter(),
			regions: null,
		})

		expect(result.countries).toEqual([
			{ country: "US", labeled: 5, excludedByIdentity: 2, excludedByText: 1, repeatedText: 1, kept: 1 },
		])

		const manifest = await readLocalJSONFile<{ files: Array<{ path: string; split: string; rows: number }> }>(
			snapshotCandidatesManifestPath(out, "probe-snapshot")
		)

		expect(manifest.files).toMatchObject([{ split: "test", rows: 1 }])

		using db = await openDuckDB()

		const kept = await db.runAndReadAll(
			`SELECT source_id FROM read_parquet('${escapeSQLString(manifest.files[0]!.path)}')`
		)

		expect(kept.getRowObjects().map((row) => row.source_id)).toEqual(["probe-snapshot-4"])
	})
})
