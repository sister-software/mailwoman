// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   A parallel build writes the corpus a serial build writes.
 *
 *   These tests build three fixture sources split into several parquet parts,
 *   serially and with two and three workers, and compare every output byte for byte
 *   apart from the timestamps listed in `TIMESTAMP_FIELDS`.
 *   They then interrupt, break and contend for builds and check that a resumed
 *   build still lands on the serial bytes.
 */

import { sha256File } from "@mailwoman/core/crypto/hash"
import { readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, removePath, writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { workspacePath } from "@mailwoman/core/paths"
import { hostName } from "@mailwoman/core/utils/system"
import { parseJSONStrict } from "@mailwoman/core/values/json"
import type { PathBuilder } from "path-ts"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { wofAdminAdapter } from "#adapters/wof/admin/json/adapter"
import { buildCorpus, PriorOutput, type BuildCorpusOptions } from "#build"
import { ALIGN_RANGE_RECORD_FILE, alignRangeDirectory } from "#build/align/range"
import { planWorkerBudget, WORKER_CLASSES, workerReservationBytes, type WorkerClass } from "#build/budget"
import { acquireBuildLock, BUILD_LOCK_DIRECTORY } from "#build/lock"
import { concatenateFiles } from "#build/parallel"
import { sourceStateDirectory, SOURCE_RECORD_FILE, type SourceCompletionRecord } from "#build/source-record"
import { SOURCE_PARQUET_MANIFEST_FILE } from "#build/worker"
import { banAdapter } from "#fr/adapters/ban/adapter"
import { readParquetRecord } from "#parquet/record"
import type { ParquetManifest } from "#parquet/writers"
import { writeNADReleaseParquet } from "#test-kit"
import { usgovHrsaFqhcAdapter } from "#us/adapters/usgov/hrsa-fqhc/adapter"
import { usgovNADAdapter } from "#us/adapters/usgov/nad/adapter"

const GiB = 1024 ** 3

/**
 * The fields whose values are the time a build ran rather than what it built.
 * Every other byte of every compared file must match.
 *
 * `training_manifest_digest` and `contentDigest` are sha256 values over the frozen record.
 * The record includes its `builtAt`, so the two digests move with it.
 */
const TIMESTAMP_FIELDS = new Set([
	"built_at",
	"builtAt",
	"checked_at",
	"started_at",
	"ended_at",
	"elapsed_ms",
	"training_manifest_digest",
	"contentDigest",
])

const FIXTURE_RIGHTS = "test fixture: Who's On First, BAN and HRSA rows read for build mechanics"

const fixtureInputs = (): BuildCorpusOptions["adapterInputs"] => ({
	"wof-admin": { inputPath: workspacePath("corpus", "fixtures", "wof-admin-json") },
	ban: { inputPath: workspacePath("corpus", "fixtures", "ban", "sample.csv") },
	"usgov-hrsa-fqhc": { inputPath: workspacePath("corpus", "fixtures", "usgov-hrsa-fqhc", "sample.csv") },
})

const baseOptions = (outputDir: PathBuilder, extra: Partial<BuildCorpusOptions> = {}): BuildCorpusOptions => ({
	outputDir,
	corpusVersion: "0.1.0",
	adapters: [wofAdminAdapter, banAdapter, usgovHrsaFqhcAdapter],
	adapterInputs: fixtureInputs(),
	unshippableReason: FIXTURE_RIGHTS,
	synthesize: true,
	// Small enough that every source writes several parts in train and the shuffle window spans parts.
	rowsPerFile: 7,
	shuffleWindow: 5,
	// Leaves room for three adapter workers whatever the test host's memory.
	hostMemoryBytes: 64 * GiB,
	...extra,
})

/**
 * A JSON document with every timestamp field removed and the output directory written as `<out>`.
 */
function normalized(text: string, outDir: PathBuilder): unknown {
	const strip = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(strip)

		if (value && typeof value === "object") {
			return Object.fromEntries(
				Object.entries(value).flatMap(([key, inner]) => (TIMESTAMP_FIELDS.has(key) ? [] : [[key, strip(inner)]]))
			)
		}

		return value
	}

	return strip(parseJSONStrict(text.replaceAll(outDir.toString(), "<out>")))
}

/**
 * Every output a corpus consumer reads, as digests and normalized documents.
 */
async function snapshot(outDir: PathBuilder): Promise<Record<string, unknown>> {
	const corpusManifestText = await readLocalTextFile(outDir("corpus-v0.1.0", "MANIFEST.json"))
	const corpusManifest = parseJSONStrict<ParquetManifest>(corpusManifestText)
	const parquet: Record<string, unknown> = {}

	for (const file of corpusManifest.files) {
		const key = file.path.replace(outDir.toString(), "<out>")

		parquet[key] = {
			sha256: await sha256File(file.path),
			rows: file.rows,
			record: normalized(await readLocalTextFile(file.path.replace(/\.parquet$/u, ".RECORD.json")), outDir),
		}
	}

	const splits: Record<string, string> = {}

	for (const name of ["train.txt", "val.txt", "test.txt", "SPLIT_MANIFEST.json"]) {
		splits[name] = await sha256File(outDir("splits", name))
	}

	return {
		parquet,
		corpusManifest: normalized(corpusManifestText, outDir),
		splits,
		manifest: normalized(await readLocalTextFile(outDir("MANIFEST.json")), outDir),
		training: normalized(await readLocalTextFile(outDir("TRAINING_SOURCES.json")), outDir),
		quarantine: await sha256File(outDir("intermediate", "quarantine.jsonl")),
	}
}

let scratch: TemporaryDirectory
let serial: Record<string, unknown>

beforeAll(async () => {
	scratch = await temporaryDirectory("mailwoman-parallel-build-")

	await buildCorpus(baseOptions(scratch.path("serial")))

	serial = await snapshot(scratch.path("serial"))
}, 300_000)

afterAll(async () => {
	await scratch[Symbol.asyncDispose]()
})

describe("parallel corpus build", { timeout: 300_000 }, () => {
	it("writes the serial build's parquet, splits, manifests and provenance with 2 and 3 workers", async () => {
		const parquet = serial.parquet as Record<string, { rows: number }>
		const sources = new Set(Object.keys(parquet).map((key) => key.split("/store/")[1]!.split("/")[0]))

		// The comparison means something only over several sources each split into several parts.
		expect([...sources].toSorted()).toEqual(["ban", "usgov-hrsa-fqhc", "wof-admin"])
		expect(Object.keys(parquet).length).toBeGreaterThan(6)

		for (const jobs of [2, 3]) {
			const outDir = scratch.path(`jobs-${jobs}`)

			await buildCorpus(baseOptions(outDir, { jobs }))

			await expect(snapshot(outDir)).resolves.toEqual(serial)
			await expect(pathExists(outDir(BUILD_LOCK_DIRECTORY))).resolves.toBe(false)
		}
	}, 600_000)

	it("records each source's parts, derivation and sorted ids, and reports each worker's heap and peak RSS", async () => {
		const outDir = scratch.path("records")

		await buildCorpus(baseOptions(outDir, { jobs: 2 }))

		const record = await readLocalJSONFile<SourceCompletionRecord>(
			sourceStateDirectory(outDir("intermediate"), "ban")(SOURCE_RECORD_FILE)
		)

		expect(record.parts.length).toBeGreaterThan(1)
		expect(record.parts.every((part) => part.source === "ban")).toBe(true)
		expect(record.derivation.codeHash).toMatch(/^[0-9a-f]{64}$/u)
		expect(record.sourceIDs.train.bytes).toBeGreaterThan(0)

		const runs = await readLocalJSONFile<
			{ task: string; workerClass: WorkerClass; heapLimitBytes: number; maxRSSBytes: number }[]
		>(outDir("intermediate", "workers", "WORKERS.json"))

		expect(runs.map((run) => run.task).toSorted()).toEqual(
			["ban", "usgov-hrsa-fqhc", "wof-admin"]
				.flatMap((source) => [`${source}/adapter`, `${source}/align-1-of-1`, `${source}/finish`])
				.toSorted()
		)

		// Each worker ran under the ceiling it was given rather than the parent's.
		expect(runs.map((run) => run.workerClass).toSorted()).toEqual(
			["adapter", "align", "finish"].flatMap((workerClass) => [workerClass, workerClass, workerClass])
		)

		expect(runs.every((run) => run.heapLimitBytes >= WORKER_CLASSES[run.workerClass].heapBytes)).toBe(true)
		expect(runs.every((run) => run.maxRSSBytes > 0)).toBe(true)
	})

	it("aligns each source in several byte ranges and writes the serial build's bytes", async () => {
		const outDir = scratch.path("ranges")

		// Small enough that every fixture's canonical file divides into several ranges.
		await buildCorpus(baseOptions(outDir, { jobs: 3, alignRangeBytes: 2048 }))

		await expect(snapshot(outDir)).resolves.toEqual(serial)

		const runs = await readLocalJSONFile<{ task: string }[]>(outDir("intermediate", "workers", "WORKERS.json"))

		for (const source of ["ban", "wof-admin"]) {
			const ranges = runs.filter((run) => run.task.startsWith(`${source}/align-`))

			expect(ranges.length).toBeGreaterThan(1)
		}

		// A resumed build realigns a range whose record is gone and reuses the others.
		const record = await readLocalJSONFile<SourceCompletionRecord>(
			sourceStateDirectory(outDir("intermediate"), "ban")(SOURCE_RECORD_FILE)
		)

		expect(record.alignRanges.length).toBeGreaterThan(1)

		await removePath(sourceStateDirectory(outDir("intermediate"), "ban")(SOURCE_RECORD_FILE))

		await removePath(
			alignRangeDirectory(sourceStateDirectory(outDir("intermediate"), "ban"), {
				index: 1,
				count: record.alignRanges.length,
			})(ALIGN_RANGE_RECORD_FILE)
		)

		await buildCorpus(baseOptions(outDir, { jobs: 3, alignRangeBytes: 2048, priorOutput: PriorOutput.Resume }))

		const resumed = await readLocalJSONFile<{ task: string }[]>(outDir("intermediate", "workers", "WORKERS.json"))

		expect(resumed.map((run) => run.task).filter((task) => task.startsWith("ban/"))).toEqual([
			`ban/align-2-of-${record.alignRanges.length}`,
			"ban/finish",
		])

		await expect(snapshot(outDir)).resolves.toEqual(serial)
	})

	it("resumes a build cancelled while a source was writing parquet and lands on the serial bytes", async () => {
		const outDir = scratch.path("cancelled")
		const controller = new AbortController()

		await expect(
			buildCorpus(
				baseOptions(outDir, {
					jobs: 2,
					signal: controller.signal,
					onProgress: (_stage, message) => {
						if (message.includes("/finish] writing parquet files")) {
							controller.abort("test interruption")
						}
					},
				})
			)
		).rejects.toThrow(/did not finish.*--resume/s)

		await expect(pathExists(outDir("corpus-v0.1.0", "MANIFEST.json"))).resolves.toBe(false)

		await buildCorpus(baseOptions(outDir, { jobs: 2, priorOutput: PriorOutput.Resume }))

		await expect(snapshot(outDir)).resolves.toEqual(serial)
	})

	it("continues at the next part after an interruption between conversions", async () => {
		const outDir = scratch.path("conversion")

		await buildCorpus(baseOptions(outDir, { jobs: 3 }))

		// The state a worker killed while converting ban's last train part leaves.
		// The completion record and every val and test part are absent.
		// The per-source manifest lists the train parts before the last, and the abandoned
		// output of the conversion it was in sits beside the store file.
		const banDir = sourceStateDirectory(outDir("intermediate"), "ban")
		const manifest = await readLocalJSONFile<ParquetManifest>(banDir(SOURCE_PARQUET_MANIFEST_FILE))

		const partOf = async (path: string): Promise<number> =>
			((await readParquetRecord(path))!.derivation.config as { part: number }).part

		const train = manifest.files.filter((file) => file.split === "train")
		const parts = await Promise.all(train.map((file) => partOf(file.path)))
		const last = train[parts.indexOf(Math.max(...parts))]!
		const kept = train.filter((file) => file !== last)

		expect(kept.length).toBeGreaterThan(0)

		await removePath(banDir(SOURCE_RECORD_FILE))

		for (const removed of manifest.files.filter((file) => !kept.includes(file))) {
			await removePath(removed.path)
		}

		await writeLocalJSONFile({ ...manifest, files: kept }, banDir(SOURCE_PARQUET_MANIFEST_FILE))
		await writeLocalTextFile("partial bytes", `${last.path}.partial.1.deadbeef`)

		const messages: string[] = []

		await buildCorpus(
			baseOptions(outDir, {
				jobs: 3,
				priorOutput: PriorOutput.Resume,
				onProgress: (_stage, message) => messages.push(message),
			})
		)

		expect(messages.some((message) => message.startsWith("[wof-admin] reused the complete source"))).toBe(true)
		expect(messages.some((message) => message.startsWith("[ban] not complete:"))).toBe(true)
		await expect(snapshot(outDir)).resolves.toEqual(serial)
	})

	it("treats neither a directory of parts nor a record over a missing part as a complete source", async () => {
		const outDir = scratch.path("incomplete")

		await buildCorpus(baseOptions(outDir, { jobs: 2 }))

		const banDir = sourceStateDirectory(outDir("intermediate"), "ban")
		const hrsaDir = sourceStateDirectory(outDir("intermediate"), "usgov-hrsa-fqhc")
		const hrsa = await readLocalJSONFile<SourceCompletionRecord>(hrsaDir(SOURCE_RECORD_FILE))

		// Every ban part is on disk, and the record that would make them a source isn't.
		await removePath(banDir(SOURCE_RECORD_FILE))
		// The hrsa record stands and one of the parts it lists doesn't.
		await removePath(hrsa.parts[0]!.path)

		const messages: string[] = []

		await buildCorpus(
			baseOptions(outDir, {
				jobs: 2,
				priorOutput: PriorOutput.Resume,
				onProgress: (_stage, message) => messages.push(message),
			})
		)

		expect(messages.find((message) => message.startsWith("[ban] not complete:"))).toMatch(/absent or unreadable/u)
		expect(messages.find((message) => message.startsWith("[usgov-hrsa-fqhc] not complete:"))).toMatch(/is missing/u)
		expect(messages.some((message) => message.startsWith("[wof-admin] reused the complete source"))).toBe(true)
		await expect(snapshot(outDir)).resolves.toEqual(serial)
	})

	it("fails a source whose worker fails, finishes the others and resumes to the serial bytes", async () => {
		const outDir = scratch.path("failed")
		const inputs = fixtureInputs()
		// The coordinator fingerprints a directory by its listing, and the ban adapter fails
		// to read it as a CSV, so the failure happens inside the adapter's worker.
		const unreadable = scratch.path("ban-input-is-a-directory")

		await makeDirectories(unreadable)

		await expect(
			buildCorpus(
				baseOptions(outDir, {
					jobs: 2,
					adapterInputs: { ...inputs, ban: { inputPath: unreadable } },
				})
			)
		).rejects.toThrow(
			/1 of 3 sources did not finish.*ban: corpus build worker ban\/adapter .* exited with code 1\. Its log is /s
		)

		await expect(
			pathExists(sourceStateDirectory(outDir("intermediate"), "wof-admin")(SOURCE_RECORD_FILE))
		).resolves.toBe(true)

		await expect(pathExists(sourceStateDirectory(outDir("intermediate"), "ban")(SOURCE_RECORD_FILE))).resolves.toBe(
			false
		)

		await expect(pathExists(outDir("MANIFEST.json"))).resolves.toBe(false)
		await expect(pathExists(outDir(BUILD_LOCK_DIRECTORY))).resolves.toBe(false)

		await buildCorpus(baseOptions(outDir, { jobs: 2, priorOutput: PriorOutput.Resume }))

		await expect(snapshot(outDir)).resolves.toEqual(serial)
	})

	it("keeps every validation and test row under a train share and counts the training rows it leaves out", async () => {
		const outDir = scratch.path("train-share")

		const capped = Object.fromEntries(
			Object.entries(fixtureInputs()).map(([source, options]) => [source, { ...options, trainShare: 0.5 }])
		)

		await buildCorpus(baseOptions(outDir, { jobs: 2, adapterInputs: capped }))

		const filesOf = async (dir: PathBuilder) =>
			(await readLocalJSONFile<ParquetManifest>(dir("corpus-v0.1.0", "MANIFEST.json"))).files

		const shaBySplit = (files: ParquetManifest["files"], split: string) =>
			files.filter((file) => file.split === split).map((file) => `${file.source} ${file.sha256}`)

		const rowsIn = (files: ParquetManifest["files"], split: string) =>
			files.filter((file) => file.split === split).reduce((sum, file) => sum + file.rows, 0)

		const full = await filesOf(scratch.path("serial"))
		const kept = await filesOf(outDir)

		expect(rowsIn(full, "val") + rowsIn(full, "test")).toBeGreaterThan(0)
		expect(shaBySplit(kept, "val")).toEqual(shaBySplit(full, "val"))
		expect(shaBySplit(kept, "test")).toEqual(shaBySplit(full, "test"))

		const leftOut = Object.values(
			(await readLocalJSONFile<{ train_rows_left_out_by_source: Record<string, number> }>(outDir("MANIFEST.json")))
				.train_rows_left_out_by_source
		).reduce((sum, count) => sum + count, 0)

		expect(leftOut).toBeGreaterThan(0)
		expect(rowsIn(kept, "train") + leftOut).toBe(rowsIn(full, "train"))
	})

	it("clones every source from an earlier build at another corpus version and writes its parquet bytes", async () => {
		const earlier = scratch.path("reuse-earlier")
		const later = scratch.path("reuse-later")

		await buildCorpus(baseOptions(earlier, { jobs: 2 }))
		await buildCorpus(baseOptions(later, { jobs: 2, corpusVersion: "0.2.0", reuseFrom: [earlier] }))

		for (const source of ["ban", "usgov-hrsa-fqhc", "wof-admin"]) {
			const record = await readLocalJSONFile<SourceCompletionRecord>(
				sourceStateDirectory(later("intermediate"), source)(SOURCE_RECORD_FILE)
			)

			expect(record.reusedFrom, source).toBe(earlier.toString())
		}

		const parts = async (dir: PathBuilder, version: string) =>
			(await readLocalJSONFile<ParquetManifest>(dir(`corpus-v${version}`, "MANIFEST.json"))).files.map(
				(file) => `${file.path.replace(dir.toString(), "<out>")} ${file.sha256} ${file.rows}`
			)

		await expect(parts(later, "0.2.0")).resolves.toEqual(await parts(earlier, "0.1.0"))
	})

	it("splits an adapter run into row-range partitions and writes the serial build's canonical and parquet bytes", async () => {
		const nadInput = await writeNADReleaseParquet(scratch.path)

		const nadOptions = (outDir: PathBuilder, extra: Partial<BuildCorpusOptions>) =>
			baseOptions(outDir, {
				adapters: [usgovNADAdapter],
				adapterInputs: { "usgov-nad": { inputPath: nadInput } },
				...extra,
			})

		const serialDir = scratch.path("nad-serial")
		const partitionedDir = scratch.path("nad-partitioned")

		await buildCorpus(nadOptions(serialDir, {}))
		await buildCorpus(nadOptions(partitionedDir, { jobs: 2, partitionRows: 3 }))

		const runs = await readLocalJSONFile<{ task: string }[]>(partitionedDir("intermediate", "workers", "WORKERS.json"))

		expect(runs.filter((run) => /^usgov-nad\/adapter-\d+-of-\d+$/u.test(run.task)).length).toBeGreaterThan(1)

		await expect(sha256File(partitionedDir("intermediate", "usgov-nad", "canonical.jsonl"))).resolves.toBe(
			await sha256File(serialDir("intermediate", "usgov-nad", "canonical.jsonl"))
		)

		const parts = async (dir: PathBuilder) =>
			(await readLocalJSONFile<ParquetManifest>(dir("corpus-v0.1.0", "MANIFEST.json"))).files.map(
				(file) => `${file.path.replace(dir.toString(), "<out>")} ${file.sha256}`
			)

		await expect(parts(partitionedDir)).resolves.toEqual(await parts(serialDir))
	})

	it("refuses a second build into an output directory a live build holds, and takes over a dead one's lock", async () => {
		const outDir = scratch.path("locked")

		await makeDirectories(outDir)

		{
			await using _held = await acquireBuildLock(outDir)

			await expect(buildCorpus(baseOptions(outDir, { jobs: 2 }))).rejects.toThrow(
				new RegExp(`locked by pid ${process.pid} on `, "u")
			)
		}

		// A build killed with SIGKILL leaves its lock behind.
		// No process holds this pid.
		await writeLocalJSONFile(
			{ pid: 2 ** 22 + 1, host: hostName(), started_at: "2026-10-20T00:00:00.000Z" },
			outDir(BUILD_LOCK_DIRECTORY, "owner.json")
		)

		await buildCorpus(baseOptions(outDir, { jobs: 2 }))

		await expect(snapshot(outDir)).resolves.toEqual(serial)
	})
})

describe("parallel build concatenation", () => {
	it("joins more than ten sources into one stream without accumulating its listeners", async () => {
		await using dir = await temporaryDirectory("mailwoman-concatenate-")
		const sources = Array.from({ length: 24 }, (_, index) => dir.path(`part-${index}.jsonl`))
		const expected = sources.map((_, index) => `{"row":${index}}\n`)

		await Promise.all(sources.map((source, index) => writeLocalTextFile(expected[index]!, source)))

		const warnings: Error[] = []

		const onWarning = (warning: Error): void => {
			if (warning.name === "MaxListenersExceededWarning") {
				warnings.push(warning)
			}
		}

		process.on("warning", onWarning)

		try {
			await concatenateFiles(
				sources.map((source) => source.toString()),
				dir.path("joined.jsonl")
			)

			// `emitWarning` delivers on the next tick.
			await new Promise<void>((resolve) => {
				setImmediate(resolve)
			})
		} finally {
			process.off("warning", onWarning)
		}

		expect(warnings.map((warning) => warning.message)).toEqual([])
		await expect(readLocalTextFile(dir.path("joined.jsonl"))).resolves.toBe(expected.join(""))
	})
})

describe("parallel build budget", () => {
	it("refuses a job count whose workers do not fit and names the count that does", () => {
		// One adapter worker and one and a half align workers.
		const host = 4.5 * GiB + workerReservationBytes("adapter") + 1.5 * workerReservationBytes("align")

		expect(() => planWorkerBudget({ jobs: 3, hostMemoryBytes: host })).toThrow(/--jobs 3 needs .*--jobs 2 fits\./su)

		expect(planWorkerBudget({ jobs: 2, hostMemoryBytes: host }).jobs).toBe(2)
	})

	it("refuses through buildCorpus before any work begins", async () => {
		await using dir = await temporaryDirectory("mailwoman-parallel-budget-")

		await expect(buildCorpus(baseOptions(dir.path("out"), { jobs: 4, hostMemoryBytes: 12 * GiB }))).rejects.toThrow(
			/corpus build refused: --jobs 4 needs/u
		)

		await expect(pathExists(dir.path("out"))).resolves.toBe(false)
	})
})
