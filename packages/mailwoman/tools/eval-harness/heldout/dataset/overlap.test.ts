import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import { afterAll, describe, expect, it } from "vitest"

import { buildHeldoutDatasetManifest } from "#tools/eval-harness/heldout/dataset/manifest"
import { auditHeldoutOverlap } from "#tools/eval-harness/heldout/dataset/overlap"
import type { HeldoutRow } from "#tools/eval-harness/heldout/per/country"

const directory = await temporaryDirectory("mw-heldout-overlap-")
const root = directory.path.toString()

afterAll(() => directory[Symbol.asyncDispose]())

const evalRow = (sourceID: string, group = sourceID): HeldoutRow => ({
	raw: `${sourceID} Main St`,
	span_starts: [0],
	span_ends: [sourceID.length],
	span_tags: ["house_number"],
	country: "US",
	source: "oa-us",
	source_id: sourceID,
	group,
})

const dataset = buildHeldoutDatasetManifest({
	datasetID: "heldout-fixture",
	createdAt: "2026-10-20T00:00:00.000Z",
	drawnFrom: {
		manifest: "/data/eval/MANIFEST.json",
		sha256: "a".repeat(64),
		corpusVersion: "v-eval",
		files: [],
	},
	sampling: {
		method: "per-country-kind-hash-order",
		perCountry: 10,
		seed: null,
		order: "hash(raw)",
		engine: "duckdb",
	},
	cells: [{ country: "US", kind: "address", available: 4, sampled: 4 }],
	rows: [evalRow("same"), evalRow("variant-base"), evalRow("held-only"), evalRow("fresh")],
	rowsFilePath: "fixture.rows.jsonl",
})

/**
 * Writes one parquet file of `(source, source_id, base_source_id)` rows and returns its row count.
 */
async function writeIDs(relative: string, rows: Array<[string, string, string | null]>): Promise<number> {
	const file = `${root}/${relative}`

	await makeDirectories(file.slice(0, file.lastIndexOf("/")))

	using db = await openDuckDB()

	const values = rows
		.map(([source, id, base]) => `('${source}', '${id}', ${base == null ? "NULL::VARCHAR" : `'${base}'`})`)
		.join(", ")

	await db.run(
		`COPY (SELECT * FROM (VALUES ${values}) t(source, source_id, base_source_id)) TO '${file}' (FORMAT parquet)`
	)

	return rows.length
}

async function writeCorpus(name: string, corpusVersion: string | null, trainRowsDelta = 0): Promise<string> {
	const trainRows = await writeIDs(`${name}/train/part-0.parquet`, [
		["oa-us", "same", null],
		["oa-us", "variant-base~typo", "variant-base"],
		["oa-us", "unrelated", null],
	])

	const valRows = await writeIDs(`${name}/val/part-0.parquet`, [["oa-us", "other", null]])
	const testRows = await writeIDs(`${name}/test/part-0.parquet`, [["oa-us", "held-only", null]])
	const manifest = `${root}/${name}/MANIFEST.json`

	await writeLocalJSONFile(
		{
			...(corpusVersion ? { corpus_version: corpusVersion } : {}),
			slices: [
				{
					path: `/data/${name}/train/part-0.parquet`,
					split: "train",
					rows: trainRows + trainRowsDelta,
					sha256: "t",
				},
				{
					path: `/data/${name}/val/part-0.parquet`,
					split: "val",
					rows: valRows,
					sha256: "v",
				},
				{
					path: `/data/${name}/test/part-0.parquet`,
					split: "test",
					rows: testRows,
					sha256: "s",
				},
			],
		},
		manifest
	)

	return manifest
}

async function writeCard(name: string, corpusVersion: string): Promise<string> {
	const path = `${root}/cards/${name}.json`

	await writeLocalJSONFile({ training: { corpus_version: corpusVersion } }, path)

	return path
}

describe("auditHeldoutOverlap", () => {
	it("classes identity and group matches as known_overlap and the rest as verified_unseen", async () => {
		const corpus = await writeCorpus("published", "v-published")
		const card = await writeCard("published", "v-published")

		const result = await auditHeldoutOverlap({
			dataset,
			corpora: [corpus],
			modelCards: [card],
			pathRoot: root,
		})

		expect(result.audit.verifiedUnseenAdmitted).toBe(true)

		expect(result.audit.counts).toEqual({
			verified_unseen: 2,
			known_overlap: 2,
			unknown: 0,
		})

		expect(result.rows["oa-us:same"]).toMatchObject({
			provenance: "known_overlap",
		})

		expect(result.rows["oa-us:same"]!.evidence).toMatch(/identity oa-us:same in v-published train/u)
		expect(result.rows["oa-us:variant-base"]!.evidence).toMatch(/group variant-base/u)

		// A row present only in the training corpus's test split is not training data.
		expect(result.rows["oa-us:held-only"]).toMatchObject({
			provenance: "verified_unseen",
		})

		expect(result.unknown).toEqual([])

		expect(result.audit.corpora[0]!.files.map((file) => [file.split, file.read])).toEqual([
			["train", true],
			["val", true],
			["test", false],
		])
	})

	it("refuses verified_unseen when a model card's corpus is not among those read", async () => {
		const corpus = await writeCorpus("candidate", "v-candidate")
		const read = await writeCard("candidate", "v-candidate")
		const unread = await writeCard("published-elsewhere", "v-never-read")

		const result = await auditHeldoutOverlap({
			dataset,
			corpora: [corpus],
			modelCards: [read, unread],
			pathRoot: root,
		})

		expect(result.audit.verifiedUnseenAdmitted).toBe(false)
		expect(result.audit.reasons.join("\n")).toMatch(/v-never-read is not among the corpora read/u)

		expect(result.audit.counts).toEqual({
			verified_unseen: 0,
			known_overlap: 2,
			unknown: 2,
		})

		expect(result.unknown.toSorted()).toEqual(["oa-us:fresh", "oa-us:held-only"])
		expect(Object.values(result.rows).every((record) => record.provenance === "known_overlap")).toBe(true)
	})

	it("refuses verified_unseen when no model card is named", async () => {
		const corpus = await writeCorpus("no-card", "v-no-card")

		const result = await auditHeldoutOverlap({
			dataset,
			corpora: [corpus],
			modelCards: [],
			pathRoot: root,
		})

		expect(result.audit.verifiedUnseenAdmitted).toBe(false)
		expect(result.audit.counts.verified_unseen).toBe(0)
	})

	it("refuses a partial read: a row count that differs from the manifest's record", async () => {
		const corpus = await writeCorpus("short", "v-short", 1)
		const card = await writeCard("short", "v-short")

		await expect(
			auditHeldoutOverlap({
				dataset,
				corpora: [corpus],
				modelCards: [card],
				pathRoot: root,
			})
		).rejects.toThrow(/holds 3 rows; .* records 4; refusing a partial read/u)
	})

	it("refuses a partial read: a listed file that is missing", async () => {
		const manifest = `${root}/missing/MANIFEST.json`

		await writeLocalJSONFile(
			{
				corpus_version: "v-missing",
				slices: [{ path: "/data/missing/train/gone.parquet", split: "train", rows: 1 }],
			},
			manifest
		)

		await expect(
			auditHeldoutOverlap({
				dataset,
				corpora: [manifest],
				modelCards: [],
				pathRoot: root,
			})
		).rejects.toThrow(/is missing; refusing a partial read/u)
	})
})
