/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A parallel build writes the corpus a serial build writes. These tests build three fixture sources split into
 *   several parquet parts, serially and with two and three workers, and compare every output byte for byte apart
 *   from the timestamps listed in `TIMESTAMP_FIELDS`. They then interrupt, break and contend for builds and check
 *   that a resumed build still lands on the serial bytes.
 */

import { readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, removePath, writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { parseJSONStrict } from "@mailwoman/core/json"
import { workspacePath } from "@mailwoman/core/paths"
import { hostName } from "@mailwoman/core/utils/system"
import type { PathBuilder } from "path-ts"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { wofAdminAdapter } from "#adapters/wof/admin/json/adapter"
import { buildCorpus, PriorOutput, type BuildCorpusOptions } from "#build"
import { planWorkerBudget, workerReservationBytes } from "#build/budget"
import { acquireBuildLock, BUILD_LOCK_DIRECTORY } from "#build/lock"
import { sourceStateDirectory, SOURCE_RECORD_FILE, type SourceCompletionRecord } from "#build/source-record"
import { SOURCE_PARQUET_MANIFEST_FILE } from "#build/worker"
import { banAdapter } from "#fr/adapters/ban/adapter"
import { readParquetRecord } from "#parquet/record"
import type { ParquetManifest } from "#parquet/writers"
import { usgovHrsaFqhcAdapter } from "#us/adapters/usgov/hrsa-fqhc/adapter"

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
	// Leaves room for three standard workers whatever the test host's memory.
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

	for (const file of corpusManifest.slices) {
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

			expect(await snapshot(outDir)).toEqual(serial)
			expect(await pathExists(outDir(BUILD_LOCK_DIRECTORY))).toBe(false)
		}
	})

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

		const runs = await readLocalJSONFile<{ task: string; heapLimitBytes: number; maxRSSBytes: number }[]>(
			outDir("intermediate", "workers", "WORKERS.json")
		)

		expect(runs.map((run) => run.task).toSorted()).toEqual(
			["ban", "usgov-hrsa-fqhc", "wof-admin"]
				.flatMap((source) => [`${source}/adapter`, `${source}/align-1-of-1`, `${source}/finish`])
				.toSorted()
		)

		// Each worker ran under the ceiling it was given rather than the parent's.
		expect(runs.every((run) => run.heapLimitBytes >= 6 * GiB)).toBe(true)
		expect(runs.every((run) => run.maxRSSBytes > 0)).toBe(true)
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

		expect(await pathExists(outDir("corpus-v0.1.0", "MANIFEST.json"))).toBe(false)

		await buildCorpus(baseOptions(outDir, { jobs: 2, priorOutput: PriorOutput.Resume }))

		expect(await snapshot(outDir)).toEqual(serial)
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

		const train = manifest.slices.filter((slice) => slice.split === "train")
		const parts = await Promise.all(train.map((slice) => partOf(slice.path)))
		const last = train[parts.indexOf(Math.max(...parts))]!
		const kept = train.filter((slice) => slice !== last)

		expect(kept.length).toBeGreaterThan(0)

		await removePath(banDir(SOURCE_RECORD_FILE))

		for (const removed of manifest.slices.filter((slice) => !kept.includes(slice))) {
			await removePath(removed.path)
		}

		await writeLocalJSONFile({ ...manifest, slices: kept }, banDir(SOURCE_PARQUET_MANIFEST_FILE))
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
		expect(await snapshot(outDir)).toEqual(serial)
	})

	it("treats neither a directory of parts nor a record over a missing part as a complete source", async () => {
		const outDir = scratch.path("incomplete")

		await buildCorpus(baseOptions(outDir, { jobs: 2 }))

		const banDir = sourceStateDirectory(outDir("intermediate"), "ban")
		const hrsaDir = sourceStateDirectory(outDir("intermediate"), "usgov-hrsa-fqhc")
		const hrsa = await readLocalJSONFile<SourceCompletionRecord>(hrsaDir(SOURCE_RECORD_FILE))

		// Every ban part is on disk, and the record that would make them a source is not.
		await removePath(banDir(SOURCE_RECORD_FILE))
		// The hrsa record stands and one of the parts it lists does not.
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
		expect(await snapshot(outDir)).toEqual(serial)
	})

	it("fails a source whose worker fails, finishes the others and resumes to the serial bytes", async () => {
		const outDir = scratch.path("failed")
		const inputs = fixtureInputs()

		await expect(
			buildCorpus(
				baseOptions(outDir, {
					jobs: 2,
					adapterInputs: { ...inputs, ban: { inputPath: scratch.path("no-such-ban.csv") } },
				})
			)
		).rejects.toThrow(
			/1 of 3 sources did not finish.*ban: corpus build worker ban\/adapter .* exited with code 1\. Its log is /s
		)

		expect(await pathExists(sourceStateDirectory(outDir("intermediate"), "wof-admin")(SOURCE_RECORD_FILE))).toBe(true)
		expect(await pathExists(sourceStateDirectory(outDir("intermediate"), "ban")(SOURCE_RECORD_FILE))).toBe(false)
		expect(await pathExists(outDir("MANIFEST.json"))).toBe(false)
		expect(await pathExists(outDir(BUILD_LOCK_DIRECTORY))).toBe(false)

		await buildCorpus(baseOptions(outDir, { jobs: 2, priorOutput: PriorOutput.Resume }))

		expect(await snapshot(outDir)).toEqual(serial)
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

		expect(await snapshot(outDir)).toEqual(serial)
	})
})

describe("parallel build budget", () => {
	it("refuses a job count whose workers do not fit and names the count that does", () => {
		const host = 4.5 * GiB + 2.5 * workerReservationBytes("standard")

		expect(() => planWorkerBudget({ jobs: 3, adapterIDs: ["ban"], hostMemoryBytes: host })).toThrow(
			/--jobs 3 needs .*--jobs 2 fits\./su
		)

		expect(planWorkerBudget({ jobs: 2, adapterIDs: ["ban"], hostMemoryBytes: host }).jobs).toBe(2)
	})

	it("refuses a resident-record adapter whose worker does not fit the budget alone", () => {
		const host = 4.5 * GiB + 2 * workerReservationBytes("standard")

		expect(() => planWorkerBudget({ jobs: 2, adapterIDs: ["wof-admin"], hostMemoryBytes: host })).toThrow(
			/wof-admin runs in a worker reserving/u
		)
	})

	it("refuses through buildCorpus before any work begins", async () => {
		await using dir = await temporaryDirectory("mailwoman-parallel-budget-")

		await expect(buildCorpus(baseOptions(dir.path("out"), { jobs: 4, hostMemoryBytes: 16 * GiB }))).rejects.toThrow(
			/corpus build refused: --jobs 4 needs/u
		)

		expect(await pathExists(dir.path("out"))).toBe(false)
	})
})
