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
import { openWriteStream } from "@mailwoman/core/fs/streams"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { sha256File } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { ROW_GROUP_SIZE, rowToParquet } from "#parquet/schema"
import {
	type ParquetManifest,
	type WriteParquetSplitsOptions,
	writeParquetSplits,
	writeStagedParquet,
} from "#parquet/writers"
import { SurfaceOrigin } from "#types"
import type { LabeledRow } from "#types"

/**
 * Called before each staged-part conversion with the staged input and the output path.
 * A throw fails that conversion.
 */
const hooks = {
	onConvert: null as null | ((stagePath: string, outputPath: string) => Promise<void> | void),
}

/**
 * The real conversion behind {@linkcode hooks}, passed through `convertStagedPart`.
 */
const convertStagedPart: NonNullable<WriteParquetSplitsOptions["convertStagedPart"]> = async (
	stagePath,
	outputPath,
	limits
) => {
	if (hooks.onConvert) {
		await hooks.onConvert(stagePath, outputPath)
	}

	await writeStagedParquet(stagePath, outputPath, limits)
}

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
	manifest.files.map((file) => `${file.source}:${file.rows}:${file.sha256}`).toSorted()

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
			{
				outputDir: scratch.path,
				corpusVersion: "0.1.0",
				derivationFor: () => FIXTURE_DERIVATION,
				rowsPerFile: 10,
				convertStagedPart,
			}
		)

		expect(converted).toHaveLength(3)
		expect(presentAtNextConversion).toEqual([])
		expect(manifest.files.map((file) => file.rows).toSorted((a, b) => b - a)).toEqual([10, 10, 5])

		for (const file of manifest.files) {
			await expect(pathExists(file.path)).resolves.toBe(true)
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
			{
				outputDir: scratch.path,
				corpusVersion: "0.1.0",
				derivationFor: () => FIXTURE_DERIVATION,
				rowsPerFile: 10,
				convertStagedPart,
			}
		)

		await expect(write).rejects.toThrow(/converting train part 1 of wof-admin.*No file was recorded/su)
		await expect(write).rejects.toThrow(failedStage)
		expect(failedStagePresent).toBe(true)

		const manifest = await readLocalJSONFile<ParquetManifest>(scratch.path("corpus-v0.1.0", "MANIFEST.json"))

		expect(manifest.files.map((file) => file.rows)).toEqual([10])
		expect(manifest.total_rows).toBe(10)
	})

	it("resumes after an interrupted conversion to the same files as an uninterrupted run", async () => {
		const rows = interleaved(["wof-admin", "wof-postalcode"], 11)

		const options = (outputDir: TemporaryDirectory["path"]) => ({
			outputDir,
			corpusVersion: "0.1.0",
			derivationFor: () => FIXTURE_DERIVATION,
			rowsPerFile: 4,
			convertStagedPart,
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
			{
				outputDir: scratch.path,
				corpusVersion: "0.1.0",
				derivationFor: () => FIXTURE_DERIVATION,
				rowsPerFile,
				convertStagedPart,
			}
		)

		expect(stagedCounts).toHaveLength(sources.length * maxParts)
		expect(Math.max(...stagedCounts)).toBeLessThanOrEqual(sources.length)
		expect(manifest.total_rows).toBe(sources.length * perSource)
	})
})

describe("writeStagedParquet", () => {
	it("writes the same bytes from one staged part under every instance thread limit", { timeout: 120_000 }, async () => {
		// Several row groups, because a multi-threaded COPY moved row-group boundaries between runs.
		const rows = ROW_GROUP_SIZE * 3 + 1234
		const stagePath = scratch.path("part.ndjson").toString()
		const stage = openWriteStream(stagePath)

		for (let index = 0; index < rows; index++) {
			stage.write(`${stringifyJSON(rowToParquet(labeled("ban", index)))}\n`)
		}

		await new Promise<void>((resolve, reject) => {
			stage.end((error?: Error | null) => (error ? reject(error) : resolve()))
		})

		const digests = new Set<string>()

		for (const threads of [1, 2, 4]) {
			for (let run = 0; run < 2; run++) {
				const out = scratch.path(`t${threads}-r${run}.parquet`).toString()

				await writeStagedParquet(stagePath, out, { threads, memoryLimitBytes: 1024 ** 3 })
				digests.add(await sha256File(out))
			}
		}

		expect([...digests]).toHaveLength(1)
	})
})
