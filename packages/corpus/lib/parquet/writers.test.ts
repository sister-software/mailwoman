/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests the staging lifecycle of `writeParquetSplits`: staged tables are dropped after conversion, a failed
 *   conversion leaves the manifest without that part, a resumed run writes the same files as an uninterrupted one,
 *   and a file's bytes depend on its rows and not on the thread limit or the other sources interleaved with them.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { stringifyJSON } from "@mailwoman/core/json"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ROW_GROUP_SIZE } from "#parquet/schema"
import { type ParquetManifest, writeParquetSplits } from "#parquet/writers"
import { SurfaceOrigin } from "#types"
import type { LabeledRow } from "#types"

/**
 * Called before each staged-part conversion with the staged table, the output path
 * and the part tables the staging database holds at that moment.
 * A throw fails that conversion.
 */
const hooks = vi.hoisted(() => ({
	onConvert: null as null | ((table: string, outputPath: string, tables: string[]) => Promise<void> | void),
}))

vi.mock("#parquet/duckdb", async (importOriginal) => {
	const actual = await importOriginal<typeof import("#parquet/duckdb")>()

	return {
		...actual,
		openDuckDB: async (...args: Parameters<typeof actual.openDuckDB>) => {
			const db = await actual.openDuckDB(...args)
			const run = db.run.bind(db)

			db.run = (async (sql: string, ...rest: unknown[]) => {
				const match = /^COPY \(WITH .* FROM (part_\d+) AS staged .*\) TO '([^']+)'/su.exec(sql)

				if (match && hooks.onConvert) {
					const listed = await db.runAndReadAll(
						"SELECT table_name FROM duckdb_tables() WHERE table_name NOT LIKE '%_dict' ORDER BY table_name"
					)

					await hooks.onConvert(
						match[1]!,
						match[2]!,
						listed.getRowsJson().map(([name]) => String(name))
					)
				}

				return (run as (sql: string, ...rest: unknown[]) => unknown)(sql, ...rest)
			}) as typeof db.run

			return db
		},
	}
})

const FIXTURE_DERIVATION = { extractHash: "fixture", codeHash: "fixture", config: {} }

const labeled = (source: string, index: number): LabeledRow => ({
	raw: `${source} row ${index}`,
	components: { locality: "Paris" },
	country: "FR",
	source,
	source_id: `${source}-${index}`,
	license: "CC0-1.0",
	register: "whos-on-first",
	surface: SurfaceOrigin.Attested,
	tokens: ["Paris"],
	labels: ["B-locality"],
	span_starts: [0],
	span_ends: [5],
	span_tags: ["locality"],
})

/**
 * Rows of several sources, interleaved the way the shuffle delivers them.
 */
function interleaved(sources: readonly string[], perSource: number): LabeledRow[] {
	const rows: LabeledRow[] = []

	for (let index = 0; index < perSource; index++) {
		for (const source of sources) {
			rows.push(labeled(source, index))
		}
	}

	return rows
}

async function* asyncFrom<T>(items: readonly T[]): AsyncIterable<T> {
	for (const item of items) {
		yield item
	}
}

const fileSummary = (manifest: ParquetManifest) =>
	manifest.slices.map((file) => `${file.source}:${file.rows}:${file.sha256}`).toSorted()

let scratch: TemporaryDirectory

beforeEach(async () => {
	scratch = await temporaryDirectory("mailwoman-parquet-writers-")
	hooks.onConvert = null
})

afterEach(async () => {
	hooks.onConvert = null
	await scratch[Symbol.asyncDispose]()
})

describe("writeParquetSplits staging", () => {
	it("drops each staged table once its conversion succeeds", async () => {
		const converted: string[] = []
		const presentAtNextConversion: string[] = []

		hooks.onConvert = (table, _outputPath, tables) => {
			presentAtNextConversion.push(...converted.filter((earlier) => tables.includes(earlier)))
			converted.push(table)
		}

		const manifest = await writeParquetSplits(
			{ train: asyncFrom(interleaved(["wof-admin"], 25)) },
			{ outputDir: scratch.path, corpusVersion: "0.1.0", derivationFor: () => FIXTURE_DERIVATION, rowsPerFile: 10 }
		)

		expect(converted).toHaveLength(3)
		expect(presentAtNextConversion).toEqual([])
		expect(manifest.slices.map((file) => file.rows).toSorted((a, b) => b - a)).toEqual([10, 10, 5])
	})

	it("records no file for a failed conversion and names its staged table in the error", async () => {
		let conversions = 0
		let failedTable = ""

		hooks.onConvert = (table) => {
			conversions++

			if (conversions === 2) {
				failedTable = table

				throw new Error("injected conversion failure")
			}
		}

		const write = writeParquetSplits(
			{ train: asyncFrom(interleaved(["wof-admin"], 25)) },
			{ outputDir: scratch.path, corpusVersion: "0.1.0", derivationFor: () => FIXTURE_DERIVATION, rowsPerFile: 10 }
		)

		await expect(write).rejects.toThrow(/converting train part 1 of wof-admin.*No file was recorded/su)
		await expect(write).rejects.toThrow(/staged table wof-admin-1 in .*stage\.duckdb/u)
		expect(failedTable).toMatch(/^part_\d+$/u)

		const manifest = await readLocalJSONFile<ParquetManifest>(scratch.path("corpus-v0.1.0", "MANIFEST.json"))

		expect(manifest.slices.map((file) => file.rows)).toEqual([10])
		expect(manifest.total_rows).toBe(10)
	})

	it("resumes after an interrupted conversion to the same files as an uninterrupted run", async () => {
		const rows = interleaved(["wof-admin", "wof-postalcode"], 11)

		const options = (outputDir: TemporaryDirectory["path"]) => ({
			outputDir,
			corpusVersion: "0.1.0",
			derivationFor: () => FIXTURE_DERIVATION,
			rowsPerFile: 4,
		})

		await using uninterruptedDir = await temporaryDirectory("mailwoman-parquet-uninterrupted-")
		const uninterrupted = await writeParquetSplits({ train: asyncFrom(rows) }, options(uninterruptedDir.path))

		let conversions = 0

		hooks.onConvert = () => {
			if (++conversions === 3) throw new Error("injected conversion failure")
		}

		await expect(writeParquetSplits({ train: asyncFrom(rows) }, options(scratch.path))).rejects.toThrow(
			/No file was recorded/u
		)

		hooks.onConvert = null

		const resumed = await writeParquetSplits({ train: asyncFrom(rows) }, { ...options(scratch.path), resume: true })

		expect(fileSummary(resumed)).toEqual(fileSummary(uninterrupted))
		expect(resumed.counts).toEqual(uninterrupted.counts)
		expect(resumed.total_rows).toBe(rows.length)
	})

	it("holds at most the open parts in staging during a multi-part, multi-source write", async () => {
		const sources = ["wof-admin", "wof-postalcode", "openaddresses"]
		const perSource = 20
		const rowsPerFile = 3
		const stagedCounts: number[] = []
		const peaks: number[] = []

		hooks.onConvert = (_table, _outputPath, tables) => {
			stagedCounts.push(tables.length)
		}

		const manifest = await writeParquetSplits(
			{ train: asyncFrom(interleaved(sources, perSource)) },
			{
				outputDir: scratch.path,
				corpusVersion: "0.1.0",
				derivationFor: () => FIXTURE_DERIVATION,
				rowsPerFile,
				onStaging: (_split, peakBytes) => peaks.push(peakBytes),
			}
		)

		expect(stagedCounts).toHaveLength(sources.length * Math.ceil(perSource / rowsPerFile))
		expect(Math.max(...stagedCounts)).toBeLessThanOrEqual(sources.length)
		expect(manifest.total_rows).toBe(sources.length * perSource)
		expect(peaks).toHaveLength(1)
		expect(peaks[0]).toBeGreaterThan(0)
	})
})

describe("writeParquetSplits bytes", () => {
	const write = async (rows: readonly LabeledRow[], duckdb: { threads?: number } = {}) => {
		await using out = await temporaryDirectory("mailwoman-parquet-bytes-")

		const manifest = await writeParquetSplits(
			{ train: asyncFrom(rows) },
			{
				outputDir: out.path,
				corpusVersion: "0.1.0",
				derivationFor: () => FIXTURE_DERIVATION,
				rowsPerFile: ROW_GROUP_SIZE * 3 + 1234,
				duckdb: { ...duckdb, memoryLimitBytes: 1024 ** 3 },
			}
		)

		return new Map(manifest.slices.map((file) => [`${file.source}:${file.rows}`, file.sha256]))
	}

	it("writes the same bytes under every instance thread limit", { timeout: 180_000 }, async () => {
		// Several row groups and more than one part, because a multi-threaded COPY moved row-group boundaries.
		const rows = interleaved(["ban"], ROW_GROUP_SIZE * 4)
		const digests = new Set<string>()

		for (const threads of [1, 2, 4]) {
			digests.add(stringifyJSON([...(await write(rows, { threads }))]))
		}

		expect([...digests]).toHaveLength(1)
	})

	it(
		"writes a source's files from its rows alone, whatever other sources interleave",
		{ timeout: 180_000 },
		async () => {
			const alone = await write(interleaved(["ban"], ROW_GROUP_SIZE + 4321))
			const mixed = await write(interleaved(["ban", "wof-admin"], ROW_GROUP_SIZE + 4321))

			for (const [key, sha256] of alone) {
				expect(mixed.get(key)).toBe(sha256)
			}
		}
	)
})
