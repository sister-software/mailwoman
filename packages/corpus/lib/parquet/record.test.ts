/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The derivation hash, the per-file record, and the fold of records into a training manifest's tally.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, removeFile, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { escapeSQLString, openDuckDB } from "#parquet/duckdb"
import {
	derivationHash,
	type DerivationInputs,
	foldSourceLicenses,
	readParquetRecord,
	readSourceLicenseTally,
	recordPathFor,
	rowsBySourceFromTally,
} from "#parquet/record"
import { rowToParquet } from "#parquet/schema"
import { writeParquetFile, writeParquetSplits } from "#parquet/writers"
import { type LabeledRow, SurfaceOrigin } from "#types"

let scratch: TemporaryDirectory

beforeEach(async () => {
	scratch = await temporaryDirectory("mailwoman-record-")
})

afterEach(async () => {
	await scratch[Symbol.asyncDispose]()
})

const BASE: DerivationInputs = {
	extractHash: "a".repeat(64),
	codeHash: "b".repeat(64),
	config: { tool: "build", shuffleSeed: 1, split: "train", source: "ban", part: 0 },
	builderVersion: "10.7.0",
}

describe("derivationHash", () => {
	it("changes when any one of its four inputs changes", () => {
		const base = derivationHash(BASE)

		const changed: Record<keyof DerivationInputs, DerivationInputs> = {
			extractHash: { ...BASE, extractHash: "c".repeat(64) },
			codeHash: { ...BASE, codeHash: "d".repeat(64) },
			config: { ...BASE, config: { ...(BASE.config as object), shuffleSeed: 2 } },
			builderVersion: { ...BASE, builderVersion: "10.7.1" },
		}

		for (const [input, inputs] of Object.entries(changed)) {
			expect(derivationHash(inputs), input).not.toBe(base)
		}
	})

	it("changes with each per-file config field the writer adds", () => {
		const base = derivationHash(BASE)
		const config = BASE.config as Record<string, unknown>

		for (const [field, value] of [
			["split", "val"],
			["source", "tiger"],
			["part", 1],
		] as const) {
			expect(derivationHash({ ...BASE, config: { ...config, [field]: value } }), field).not.toBe(base)
		}
	})

	it("does not change when the config's keys arrive in another order", () => {
		const reordered = { part: 0, source: "ban", split: "train", shuffleSeed: 1, tool: "build" }

		expect(derivationHash({ ...BASE, config: reordered })).toBe(derivationHash(BASE))
	})

	it("is a sha256 hex digest", () => {
		expect(derivationHash(BASE)).toMatch(/^[0-9a-f]{64}$/u)
	})
})

const labeled = (over: Partial<LabeledRow>): LabeledRow => ({
	raw: "Paris",
	components: { locality: "Paris" },
	country: "FR",
	source: "ban",
	source_id: "r-1",
	corpus_version: "0.1.0",
	license: "etalab-2.0",
	register: "ban",
	surface: SurfaceOrigin.Attested,
	tokens: ["Paris"],
	labels: ["B-locality"],
	span_starts: [0],
	span_ends: [5],
	span_tags: ["locality"],
	...over,
})

async function* asyncFrom<T>(items: readonly T[]): AsyncIterable<T> {
	yield* items
}

const FIXTURE_DERIVATION = { extractHash: "fixture", codeHash: "fixture", config: { tool: "test" } }

/**
 * A fixture corpus of four sources across two splits, with two license labels on one source
 * and an empty label on another, written with a row cap that rolls one source over into a second part.
 */
function fixtureRows(): { train: LabeledRow[]; val: LabeledRow[] } {
	const train: LabeledRow[] = []

	for (let index = 0; index < 7; index++) {
		train.push(labeled({ source: "ban", source_id: `ban-${index}`, license: index % 3 ? "etalab-2.0" : "ODbL-1.0" }))
		train.push(labeled({ source: "wof-admin", source_id: `wof-${index}`, license: "CC0-1.0" }))
	}

	train.push(labeled({ source: "tiger", source_id: "tiger-0", license: "" }))

	return {
		train,
		val: [labeled({ source: "ban", source_id: "ban-val-0" }), labeled({ source: "wof-admin", source_id: "wof-val-0" })],
	}
}

describe("writeParquetSplits", () => {
	it("writes one source per file under store/<source>/<derivation hash>/, each with a record", async () => {
		const rows = fixtureRows()

		const manifest = await writeParquetSplits(
			{ train: asyncFrom(rows.train), val: asyncFrom(rows.val) },
			{ outputDir: scratch.path, corpusVersion: "0.1.0", rowsPerFile: 4, derivationFor: () => FIXTURE_DERIVATION }
		)

		// ban train 7 rows → 4 + 3, wof-admin train 7 → 4 + 3, tiger 1, and one file per source in val.
		expect(manifest.slices).toHaveLength(7)
		expect(manifest.total_rows).toBe(rows.train.length + rows.val.length)

		const hashes = new Set<string>()

		for (const file of manifest.slices) {
			expect(file.path).toBe(scratch.path("store", file.source!, file.derivation_hash!, "data.parquet").toString())
			hashes.add(file.derivation_hash!)

			const record = await readParquetRecord(file.path)

			expect(record).not.toBeNull()
			expect(record!.source).toBe(file.source)
			expect(record!.rows).toBe(file.rows)
			expect(record!.sha256).toBe(file.sha256)
			expect(record!.sha256).toBe(await sha256File(file.path))
			expect(record!.derivationHash).toBe(file.derivation_hash)
			expect(derivationHash(record!.derivation)).toBe(record!.derivationHash)
			expect(record!.registerInputs.length).toBeGreaterThan(0)

			const sources = await readSourceLicenseTally([file.path])

			expect([...sources.keys()]).toEqual([file.source])
		}

		expect(hashes.size).toBe(manifest.slices.length)
	})

	it("keeps a file whose store path already holds the same bytes", async () => {
		const rows = fixtureRows()

		const options = {
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
			rowsPerFile: 4,
			derivationFor: () => FIXTURE_DERIVATION,
		}

		const first = await writeParquetSplits({ train: asyncFrom(rows.train) }, options)
		const second = await writeParquetSplits({ train: asyncFrom(rows.train) }, options)

		expect(second.slices.map((file) => [file.path, file.sha256])).toEqual(
			first.slices.map((file) => [file.path, file.sha256])
		)
	})

	it("refuses a store path that holds different bytes under the same derivation hash", async () => {
		const options = { outputDir: scratch.path, corpusVersion: "0.1.0", derivationFor: () => FIXTURE_DERIVATION }

		await writeParquetSplits({ train: asyncFrom([labeled({ raw: "Paris" })]) }, options)

		await expect(writeParquetSplits({ train: asyncFrom([labeled({ raw: "Lyon" })]) }, options)).rejects.toThrow(
			/under the same derivation hash/u
		)
	})
})

describe("foldSourceLicenses", () => {
	it("folds records to the tally a re-read of every row computes", async () => {
		const rows = fixtureRows()

		const manifest = await writeParquetSplits(
			{ train: asyncFrom(rows.train), val: asyncFrom(rows.val) },
			{ outputDir: scratch.path, corpusVersion: "0.1.0", rowsPerFile: 4, derivationFor: () => FIXTURE_DERIVATION }
		)

		// An overlay file whose record was never written, standing for one built before records existed.
		const overlay = scratch.path("overlay", "part-gb.train.parquet").toString()

		await writeParquetFile(
			[0, 1, 2].map((index) =>
				rowToParquet(labeled({ source: "rendered-gb", source_id: `gb-${index}`, license: "OGL-UK-3.0" }))
			),
			overlay,
			FIXTURE_DERIVATION
		)

		await removeFile(recordPathFor(overlay))

		// A multi-source base part with no record, the shape of the v0.7.0 `part-NNNN.parquet` files.
		const legacy = scratch.path("legacy", "part-0000.parquet").toString()

		await makeDirectories(scratch.path("legacy"))

		{
			using db = await openDuckDB()

			await db.run(
				`COPY (SELECT * FROM (VALUES ('ban', 'etalab-2.0'), ('tiger', NULL), ('tiger', '')) AS t(source, license)) ` +
					`TO '${escapeSQLString(legacy)}' (FORMAT parquet)`
			)
		}

		const listed = [
			...manifest.slices.map((file) => ({ path: file.path, rows: file.rows, sha256: file.sha256 })),
			{ path: overlay, rows: 3 },
			{ path: legacy, rows: 3 },
		]

		const folded = await foldSourceLicenses(listed)
		const reread = await readSourceLicenseTally(listed.map((file) => file.path))

		expect(folded.folded).toBe(manifest.slices.length)
		expect(folded.reread).toBe(2)
		expect(rowsBySourceFromTally(folded.tally)).toEqual(rowsBySourceFromTally(reread))

		const bySource = rowsBySourceFromTally(folded.tally)

		// Seven train rows (three under ODbL), one val row and one legacy row.
		expect(bySource.get("ban")).toEqual({
			rows: 9,
			license: "etalab-2.0",
			licenseValues: { "etalab-2.0": 6, "ODbL-1.0": 3 },
		})

		expect(bySource.get("tiger")).toEqual({ rows: 3, license: "none-recorded-on-rows" })
	})

	it("refuses a record whose row count disagrees with the manifest", async () => {
		const path = scratch.path("one.parquet").toString()

		await writeParquetFile([rowToParquet(labeled({}))], path, FIXTURE_DERIVATION)

		await expect(foldSourceLicenses([{ path, rows: 2 }])).rejects.toThrow(/records 1 rows and the manifest lists 2/u)
	})

	it("refuses a record whose sha256 disagrees with the manifest", async () => {
		const path = scratch.path("one.parquet").toString()
		const record = await writeParquetFile([rowToParquet(labeled({}))], path, FIXTURE_DERIVATION)

		await writeLocalJSONFile({ ...record, sha256: "0".repeat(64) }, recordPathFor(path))

		await expect(foldSourceLicenses([{ path, rows: 1, sha256: record.sha256 }])).rejects.toThrow(/records sha256/u)
	})
})

describe("writeParquetFile", () => {
	it("refuses rows of more than one source", async () => {
		await expect(
			writeParquetFile(
				[rowToParquet(labeled({})), rowToParquet(labeled({ source: "tiger" }))],
				scratch.path("mixed.parquet"),
				FIXTURE_DERIVATION
			)
		).rejects.toThrow(/would hold 2 sources/u)
	})

	it("refuses a source corpus-source-inputs.json does not map", async () => {
		await expect(
			writeParquetFile(
				[rowToParquet(labeled({ source: "no-such-source" }))],
				scratch.path("unmapped.parquet"),
				FIXTURE_DERIVATION
			)
		).rejects.toThrow(/maps to no register source/u)
	})
})
