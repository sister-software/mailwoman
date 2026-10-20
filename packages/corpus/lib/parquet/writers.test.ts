/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests the staging lifecycle of `writeParquetSplits`: staged parts are removed after conversion, a failed
 *   conversion leaves the manifest without that part, and a resumed run writes the same files as an uninterrupted one.
 */

import { dirname } from "node:path"

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { type ParquetManifest, writeParquetSplits } from "#parquet/writers"
import { SurfaceOrigin } from "#types"
import type { LabeledRow } from "#types"

/**
 * Called before each staged-part conversion with the staged input and the output path.
 * A throw fails that conversion.
 */
const hooks = vi.hoisted(() => ({
	onConvert: null as null | ((stagePath: string, outputPath: string) => Promise<void> | void),
}))

vi.mock("#parquet/duckdb", async (importOriginal) => {
	const actual = await importOriginal<typeof import("#parquet/duckdb")>()

	return {
		...actual,
		openDuckDB: async (...args: Parameters<typeof actual.openDuckDB>) => {
			const db = await actual.openDuckDB(...args)
			const run = db.run.bind(db)

			db.run = (async (sql: string, ...rest: unknown[]) => {
				const match = /read_json\('([^']+)'.*\bTO '([^']+)'/su.exec(sql)

				if (match && hooks.onConvert) {
					await hooks.onConvert(match[1]!, match[2]!)
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
	it("removes each staged part once its conversion succeeds", async () => {
		const converted: string[] = []
		const presentAtNextConversion: string[] = []

		hooks.onConvert = async (stagePath) => {
			for (const earlier of converted) {
				if (await pathExists(earlier)) {
					presentAtNextConversion.push(earlier)
				}
			}

			converted.push(stagePath)
		}

		const manifest = await writeParquetSplits(
			{ train: asyncFrom(interleaved(["wof-admin"], 25)) },
			{ outputDir: scratch.path, corpusVersion: "0.1.0", derivationFor: () => FIXTURE_DERIVATION, rowsPerFile: 10 }
		)

		expect(converted).toHaveLength(3)
		expect(presentAtNextConversion).toEqual([])
		expect(manifest.slices.map((file) => file.rows).toSorted((a, b) => b - a)).toEqual([10, 10, 5])

		for (const file of manifest.slices) {
			expect(await pathExists(file.path)).toBe(true)
		}
	})

	it("records no file for a failed conversion and keeps its staged part for the error", async () => {
		let conversions = 0
		let failedStage = ""
		let failedStagePresent = false

		hooks.onConvert = async (stagePath) => {
			conversions++

			if (conversions === 2) {
				failedStage = stagePath
				failedStagePresent = await pathExists(stagePath)

				throw new Error("injected conversion failure")
			}
		}

		const write = writeParquetSplits(
			{ train: asyncFrom(interleaved(["wof-admin"], 25)) },
			{ outputDir: scratch.path, corpusVersion: "0.1.0", derivationFor: () => FIXTURE_DERIVATION, rowsPerFile: 10 }
		)

		await expect(write).rejects.toThrow(/converting train part 1 of wof-admin.*No file was recorded/su)
		await expect(write).rejects.toThrow(failedStage)
		expect(failedStagePresent).toBe(true)

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
		const maxParts = Math.ceil(perSource / rowsPerFile)
		const stagedCounts: number[] = []

		hooks.onConvert = async (stagePath) => {
			const staging = dirname(stagePath)
			let staged = 0

			for (const source of sources) {
				for (let part = 0; part < maxParts; part++) {
					if (await pathExists(`${staging}/${source}-${part}.ndjson`)) {
						staged++
					}
				}
			}

			stagedCounts.push(staged)
		}

		const manifest = await writeParquetSplits(
			{ train: asyncFrom(interleaved(sources, perSource)) },
			{ outputDir: scratch.path, corpusVersion: "0.1.0", derivationFor: () => FIXTURE_DERIVATION, rowsPerFile }
		)

		expect(stagedCounts).toHaveLength(sources.length * maxParts)
		expect(Math.max(...stagedCounts)).toBeLessThanOrEqual(sources.length)
		expect(manifest.total_rows).toBe(sources.length * perSource)
	})
})
