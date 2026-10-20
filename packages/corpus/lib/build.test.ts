/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists, statPath } from "@mailwoman/core/fs/readers/stat"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { appendLocalTextFile, removeFile, removePath, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { workspacePath } from "@mailwoman/core/paths"
import type { PathBuilder } from "path-ts"
import { JSONSpliterator, TextSpliterator } from "spliterator"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { wofAdminAdapter } from "#adapters/wof/admin/json/adapter"
import {
	assertHeapForAdapters,
	buildCorpus,
	BuildProfile,
	PriorOutput,
	RESIDENT_ADAPTER_HEAP_FLOOR_BYTES,
	type BuildStage,
} from "#build"
import type { AlignCheckpoint } from "#build/checkpoint"
import { readParquetRecord } from "#parquet/record"
import type { ParquetRow } from "#parquet/schema"
import { openParquetRowStream } from "#parquet/streams"
import type { ParquetManifest } from "#parquet/writers"
import { compileLicenseExcludes, LicensePolicy, LicenseRefusalKind } from "#utils/license"
import { writeSplitManifestsFromLabeledFiles } from "#utils/split"

const fixtureRoot = workspacePath("corpus", "fixtures", "wof-admin-json")

/**
 * The fixture is Who's On First data, whose register row reads unchecked,
 * so every build here passes the override.
 * The rights tests below drive the refusal itself.
 */
const FIXTURE_RIGHTS = "test fixture: Who's On First rows read for build mechanics"

let scratch: TemporaryDirectory

beforeEach(async () => {
	scratch = await temporaryDirectory("mailwoman-build-")
})

afterEach(async () => {
	await scratch[Symbol.asyncDispose]()
})

describe("assertHeapForAdapters", () => {
	const floor = RESIDENT_ADAPTER_HEAP_FLOOR_BYTES

	it("refuses a resident-record adapter under the floor and names the setting that raises it", () => {
		expect(() => assertHeapForAdapters(["ban", "wof-admin"], 4 * 1024 ** 3)).toThrow(
			/wof-admin.*max-old-space-size=20480/s
		)
	})

	it("admits the same adapter at the floor, and admits any other adapter below it", () => {
		expect(() => assertHeapForAdapters(["wof-admin", "wof-postalcode"], floor)).not.toThrow()
		expect(() => assertHeapForAdapters(["ban", "tiger", "usgov-nad"], 512 * 1024 ** 2)).not.toThrow()
	})
})

describe("buildCorpus end-to-end against wof-admin JSON-bundle fixture", () => {
	it("produces top-level MANIFEST.json + parquet files + splits + quarantine pile", async () => {
		const outDir = scratch.path("build")
		const stages: BuildStage[] = []

		const manifest = await buildCorpus({
			outputDir: outDir,
			corpusVersion: "0.1.0",
			adapters: [wofAdminAdapter],
			unshippableReason: FIXTURE_RIGHTS,
			adapterInputs: { "wof-admin": { inputPath: fixtureRoot } },
			synthesize: true,
			onProgress: (stage) => stages.push(stage),
		})

		expect(stages).toEqual(expect.arrayContaining(["adapter-run", "align", "split", "parquet", "manifest"]))

		expect(manifest.corpus_version).toBe("0.1.0")
		expect(manifest.adapters).toHaveLength(1)
		expect(manifest.adapters[0]!.adapter_id).toBe("wof-admin")
		expect(manifest.total_aligned_rows).toBeGreaterThan(0)
		expect(manifest.slices.total_rows).toBe(manifest.total_aligned_rows)
		expect(manifest.splits.counts.train).toBeGreaterThan(0)

		const onDisk = await readLocalJSONFile<{ corpus_version: string }>(outDir("MANIFEST.json"))
		expect(onDisk.corpus_version).toBe("0.1.0")

		const corpusManifest = await readLocalJSONFile<{
			total_rows: number
			slices: Array<{ split: string; format: string; path: string; rows: number }>
		}>(outDir("corpus-v0.1.0", "MANIFEST.json"))

		expect(corpusManifest.total_rows).toBe(manifest.total_aligned_rows)
		expect(corpusManifest.slices.length).toBeGreaterThanOrEqual(1)

		const splitManifest = await readLocalJSONFile<{ corpus_version: string; holdouts: Record<string, string[]> }>(
			outDir("splits", "SPLIT_MANIFEST.json")
		)

		expect(splitManifest.corpus_version).toBe("0.1.0")
		expect(splitManifest.holdouts.US).toContain("Vermont")

		const trainFile = corpusManifest.slices.find((s) => s.split === "train")!
		expect(trainFile).toBeDefined()
		expect(trainFile.format).toBe("parquet")
		expect(trainFile.path).toMatch(/\.parquet$/)
		const firstRow = (await openParquetRowStream<ParquetRow>(trainFile.path).next()).value ?? null

		expect(firstRow).not.toBeNull()
		expect(firstRow).not.toHaveProperty("corpus_version")
		expect(firstRow).toHaveProperty("augmentation")
		expect(firstRow!.tokens).toHaveLength(firstRow!.labels.length)

		for (const file of corpusManifest.slices) {
			const record = await readParquetRecord(file.path)

			expect(file.path).toMatch(new RegExp(`/store/${record!.source}/${record!.derivationHash}/data\\.parquet$`, "u"))
			expect(record!.rows).toBe(file.rows)
		}
	})

	it("routes rows whose components.region is held out to val/test", async () => {
		const outDir = scratch.path("build")

		await buildCorpus({
			outputDir: outDir,
			corpusVersion: "0.1.0",
			adapters: [wofAdminAdapter],
			unshippableReason: FIXTURE_RIGHTS,
			adapterInputs: { "wof-admin": { inputPath: fixtureRoot, country: "US" } },
			synthesize: false,
		})

		const readVermontRows = (path: PathBuilder) =>
			JSONSpliterator.fromAsync<{ source_id: string; components: { region?: string } }>(path)
				.filter((row) => row.components.region === "Vermont")
				.toArray()

		const [trainVermont, valVermont, testVermont] = await Promise.all([
			readVermontRows(outDir("intermediate", "labeled-train.jsonl")),
			readVermontRows(outDir("intermediate", "labeled-val.jsonl")),
			readVermontRows(outDir("intermediate", "labeled-test.jsonl")),
		])

		const vermontHeldOut = [...valVermont, ...testVermont]
		expect(vermontHeldOut.length).toBeGreaterThan(0)
		expect(trainVermont).toEqual([])

		const trainIDs = new Set(await TextSpliterator.fromAsync(outDir("splits", "train.txt")).toArray())

		for (const r of vermontHeldOut) {
			expect(trainIDs.has(r.source_id)).toBe(false)
		}
	})

	it("synthesis fan-out increases row count over the non-synth path", async () => {
		const noSynth = await buildCorpus({
			outputDir: scratch.path("no-synth"),
			corpusVersion: "0.1.0",
			adapters: [wofAdminAdapter],
			unshippableReason: FIXTURE_RIGHTS,
			adapterInputs: { "wof-admin": { inputPath: fixtureRoot } },
			synthesize: false,
		})

		const withSynth = await buildCorpus({
			outputDir: scratch.path("with-synth"),
			corpusVersion: "0.1.0",
			adapters: [wofAdminAdapter],
			unshippableReason: FIXTURE_RIGHTS,
			adapterInputs: { "wof-admin": { inputPath: fixtureRoot } },
			synthesize: true,
		})

		expect(withSynth.total_aligned_rows).toBeGreaterThan(noSynth.total_aligned_rows)
	})

	it("admits every row under the exploratory profile, which asks the register nothing", async () => {
		const manifest = await buildCorpus({
			outputDir: scratch.path("exploratory"),
			corpusVersion: "0.1.0",
			adapters: [wofAdminAdapter],
			unshippableReason: FIXTURE_RIGHTS,
			adapterInputs: { "wof-admin": { inputPath: fixtureRoot } },
		})

		expect(manifest.profile).toBe(BuildProfile.Exploratory)
		expect(manifest.excluded_by_eligibility).toBe(0)
		expect(manifest.ineligible_sources).toEqual({})
		expect(manifest.total_aligned_rows).toBeGreaterThan(0)
	})

	it("admits no row under the release-eligible profile while every source's terms are unread", async () => {
		const manifest = await buildCorpus({
			outputDir: scratch.path("release-eligible"),
			corpusVersion: "0.1.0",
			adapters: [wofAdminAdapter],
			unshippableReason: FIXTURE_RIGHTS,
			adapterInputs: { "wof-admin": { inputPath: fixtureRoot } },
			synthesize: true,
			profile: BuildProfile.ReleaseEligible,
		})

		expect(manifest.total_aligned_rows).toBe(0)
		expect(manifest.excluded_by_eligibility).toBeGreaterThan(0)

		// A refusal is keyed by the adapter and the jurisdiction together, so one adapter reading
		// three countries records which of them went unreviewed rather than one entry for all three.
		expect(Object.keys(manifest.ineligible_sources).toSorted()).toEqual([
			"wof-admin:FR",
			"wof-admin:NL",
			"wof-admin:US",
		])

		expect(manifest.ineligible_sources["wof-admin:US"]?.[0]).toContain(
			'no register source declares "wof-admin" as its adapter in "US"'
		)
	})

	it("keeps a refused source out of the synthetic rows fanned from it", async () => {
		// An augmentation inherits its ancestor's `source`, so the eligibility check must run
		// before `synthesizeRow` for the ancestor's refusal to cover the fan-out.
		const withSynth = await buildCorpus({
			outputDir: scratch.path("release-eligible-synth"),
			corpusVersion: "0.1.0",
			adapters: [wofAdminAdapter],
			unshippableReason: FIXTURE_RIGHTS,
			adapterInputs: { "wof-admin": { inputPath: fixtureRoot } },
			synthesize: true,
			profile: BuildProfile.ReleaseEligible,
		})

		const withoutSynth = await buildCorpus({
			outputDir: scratch.path("release-eligible-nosynth"),
			corpusVersion: "0.1.0",
			adapters: [wofAdminAdapter],
			unshippableReason: FIXTURE_RIGHTS,
			adapterInputs: { "wof-admin": { inputPath: fixtureRoot } },
			synthesize: false,
			profile: BuildProfile.ReleaseEligible,
		})

		expect(withSynth.total_aligned_rows).toBe(0)
		expect(withoutSynth.total_aligned_rows).toBe(0)
		expect(withSynth.excluded_by_eligibility).toBe(withoutSynth.excluded_by_eligibility)
	})

	it("notes skipped adapters when no inputs configured", async () => {
		const manifest = await buildCorpus({
			outputDir: scratch.path("build"),
			corpusVersion: "0.1.0",
			adapters: [wofAdminAdapter],
			unshippableReason: FIXTURE_RIGHTS,
			adapterInputs: {},
		})

		expect(manifest.skipped_adapters).toContain("wof-admin")
		expect(manifest.adapters).toHaveLength(0)
		expect(manifest.total_aligned_rows).toBe(0)
	})

	it("records the license policy it ran under, so an unfiltered corpus reads apart from a clean one", async () => {
		const manifest = await buildCorpus({
			outputDir: scratch.path("build"),
			corpusVersion: "0.1.0",
			adapters: [wofAdminAdapter],
			unshippableReason: FIXTURE_RIGHTS,
			adapterInputs: { "wof-admin": { inputPath: fixtureRoot } },
		})

		expect(manifest.license_policy).toBe(LicensePolicy.All)
		expect(manifest.excluded_by_license).toBe(0)
		expect(manifest.refused_license_values).toEqual({})
		// Every fixture row is stamped `CC0-1.0`, which resolves to an expression with no obligations.
		expect(manifest.admitted_unresolved_license_rows).toBe(0)
	})

	it("admits the CC0 fixture under the share-alike-free policy", async () => {
		const all = await buildCorpus({
			outputDir: scratch.path("all"),
			corpusVersion: "0.1.0",
			adapters: [wofAdminAdapter],
			unshippableReason: FIXTURE_RIGHTS,
			adapterInputs: { "wof-admin": { inputPath: fixtureRoot } },
		})

		const free = await buildCorpus({
			outputDir: scratch.path("free"),
			corpusVersion: "0.1.0",
			adapters: [wofAdminAdapter],
			unshippableReason: FIXTURE_RIGHTS,
			adapterInputs: { "wof-admin": { inputPath: fixtureRoot } },
			licensePolicy: LicensePolicy.ShareAlikeFree,
		})

		expect(free.license_policy).toBe(LicensePolicy.ShareAlikeFree)
		expect(free.excluded_by_license).toBe(0)
		expect(free.total_aligned_rows).toBe(all.total_aligned_rows)
	})

	it("refuses every row under an operator prefix and records the value it refused them for", async () => {
		const manifest = await buildCorpus({
			outputDir: scratch.path("build"),
			corpusVersion: "0.1.0",
			adapters: [wofAdminAdapter],
			unshippableReason: FIXTURE_RIGHTS,
			adapterInputs: { "wof-admin": { inputPath: fixtureRoot } },
			excludeLicenses: compileLicenseExcludes("CC0"),
		})

		expect(manifest.excluded_by_license).toBeGreaterThan(0)

		expect(manifest.refused_by_license_kind).toEqual({
			[LicenseRefusalKind.OperatorExcluded]: manifest.excluded_by_license,
		})

		expect(manifest.refused_license_values).toEqual({ "CC0-1.0": LicenseRefusalKind.OperatorExcluded })
		expect(manifest.total_aligned_rows).toBe(0)
		// The license set records what the adapters yielded rather than what survived the refusal.
		expect(manifest.licenses["CC0-1.0"]).toBe(manifest.excluded_by_license)
	})

	it("aligns one intermediate to the same four digests twice, which is what makes a resumed align safe", async () => {
		// A resumed build reuses an adapter's canonical rows and re-runs the align phase over them.
		// That is sound only where the phase is a function of its input: the split routing,
		// the augmentation draw and the write order all have to land the same way on a second pass.
		// This pins the four files the phase writes rather than the row counts,
		// because a count matches across two runs that ordered their rows differently.
		const digests = async (outDir: PathBuilder): Promise<Record<string, string>> => {
			const named: Record<string, string> = {}

			for (const name of ["labeled-train.jsonl", "labeled-val.jsonl", "labeled-test.jsonl", "quarantine.jsonl"]) {
				const path = outDir("intermediate", name)

				named[name] = (await pathExists(path)) ? await sha256File(path) : "absent"
			}

			return named
		}

		const options = {
			corpusVersion: "0.1.0",
			adapters: [wofAdminAdapter],
			unshippableReason: FIXTURE_RIGHTS,
			adapterInputs: { "wof-admin": { inputPath: fixtureRoot } },
			synthesize: true,
		} as const

		const firstDir = scratch.path("align-1")
		const secondDir = scratch.path("align-2")

		await buildCorpus({ ...options, outputDir: firstDir })
		await buildCorpus({ ...options, outputDir: secondDir })

		const first = await digests(firstDir)

		expect(await digests(secondDir)).toEqual(first)
		// A run that wrote no labeled rows would pass a digest comparison of two empty files.
		expect(first["labeled-train.jsonl"]).not.toBe("absent")
	})
})

describe("buildCorpus resume", () => {
	const options = {
		corpusVersion: "0.1.0",
		adapters: [wofAdminAdapter],
		unshippableReason: FIXTURE_RIGHTS,
		adapterInputs: { "wof-admin": { inputPath: fixtureRoot } },
		synthesize: true,
	} as const

	const alignDigests = async (outDir: PathBuilder): Promise<Record<string, string>> => {
		const named: Record<string, string> = {}

		for (const name of ["labeled-train.jsonl", "labeled-val.jsonl", "labeled-test.jsonl", "quarantine.jsonl"]) {
			const path = outDir("intermediate", name)

			named[name] = (await pathExists(path)) ? await sha256File(path) : "absent"
		}

		return named
	}

	const parquetManifest = (outDir: PathBuilder) =>
		readLocalJSONFile<ParquetManifest>(outDir("corpus-v0.1.0", "MANIFEST.json"))

	it("reuses the aligned rows and the parquet files a finished build recorded", async () => {
		const outDir = scratch.path("build")
		const first = await buildCorpus({ ...options, outputDir: outDir })
		const firstParquet = await parquetManifest(outDir)
		const firstDigests = await alignDigests(outDir)

		const checkpoint = await readLocalJSONFile<AlignCheckpoint>(outDir("intermediate", "align-checkpoint.json"))

		expect(checkpoint.completed_adapters).toEqual(["wof-admin"])
		expect(checkpoint.aligned).toBe(first.total_aligned_rows)
		expect(checkpoint.offsets.train).toBe((await statPath(outDir("intermediate", "labeled-train.jsonl"))).size)

		const stages: string[] = []

		const second = await buildCorpus({
			...options,
			outputDir: outDir,
			priorOutput: PriorOutput.Resume,
			onProgress: (_stage, message) => stages.push(message),
		})

		expect(stages.some((message) => message.startsWith("resumed align after wof-admin"))).toBe(true)
		expect(second.total_aligned_rows).toBe(first.total_aligned_rows)
		expect(second.splits.counts).toEqual(first.splits.counts)
		expect(second.slices.total_rows).toBe(first.slices.total_rows)

		const secondParquet = await parquetManifest(outDir)

		expect(secondParquet.slices.map((slice) => slice.sha256)).toEqual(firstParquet.slices.map((s) => s.sha256))
		expect(await alignDigests(outDir)).toEqual(firstDigests)
	})

	it("sorts the ids align recorded into the split files a parse of the labeled rows writes", async () => {
		const outDir = scratch.path("build")

		await buildCorpus({ ...options, outputDir: outDir })

		const checkpoint = await readLocalJSONFile<AlignCheckpoint>(outDir("intermediate", "align-checkpoint.json"))

		expect(checkpoint.source_id_offsets?.train).toBe(
			(await statPath(outDir("intermediate", "source-ids-train.txt"))).size
		)

		const reparsed = scratch.path("reparsed")

		await writeSplitManifestsFromLabeledFiles({
			labeledPaths: {
				train: outDir("intermediate", "labeled-train.jsonl"),
				val: outDir("intermediate", "labeled-val.jsonl"),
				test: outDir("intermediate", "labeled-test.jsonl"),
			},
			outputDir: reparsed,
			corpusVersion: "0.1.0",
			counts: { train: 0, val: 0, test: 0 },
		})

		for (const name of ["train.txt", "val.txt", "test.txt"]) {
			expect(await sha256File(outDir("splits", name))).toBe(await sha256File(reparsed(name)))
		}

		expect((await statPath(outDir("splits", "train.txt"))).size).toBeGreaterThan(0)
	})

	it("reads the ids from the labeled rows when the checkpoint predates the id lists", async () => {
		const outDir = scratch.path("build")

		await buildCorpus({ ...options, outputDir: outDir })

		const before = await sha256File(outDir("splits", "train.txt"))
		const checkpointPath = outDir("intermediate", "align-checkpoint.json")
		const { source_id_offsets: _offsets, ...older } = await readLocalJSONFile<AlignCheckpoint>(checkpointPath)

		await writeLocalJSONFile(older, checkpointPath)

		for (const split of ["train", "val", "test"]) {
			await removePath(outDir("intermediate", `source-ids-${split}.txt`))
		}

		await removePath(outDir("splits"))
		await buildCorpus({ ...options, outputDir: outDir, priorOutput: PriorOutput.Resume })

		expect(await sha256File(outDir("splits", "train.txt"))).toBe(before)
		expect(await pathExists(outDir("intermediate", "source-ids-train.txt"))).toBe(false)
	})

	it("discards bytes written past the checkpoint rather than appending after them", async () => {
		const outDir = scratch.path("build")

		await buildCorpus({ ...options, outputDir: outDir })

		const trainPath = outDir("intermediate", "labeled-train.jsonl")
		const before = await sha256File(trainPath)

		// Stands for the rows an interrupted adapter wrote after the last checkpoint.
		// The checkpoint's accumulators do not count them, so a resume that appended would
		// report fewer rows than the file holds and every later reader would accept that count.
		await appendLocalTextFile(`${stringifyJSON({ raw: "partial row from an interrupted run" })}\n`, trainPath)

		expect(await sha256File(trainPath)).not.toBe(before)

		await buildCorpus({ ...options, outputDir: outDir, priorOutput: PriorOutput.Resume })

		expect(await sha256File(trainPath)).toBe(before)
	})

	it("refuses to resume under align settings the checkpoint was not written under", async () => {
		const outDir = scratch.path("build")

		await buildCorpus({ ...options, outputDir: outDir })

		await expect(
			buildCorpus({ ...options, outputDir: outDir, synthesize: false, priorOutput: PriorOutput.Resume })
		).rejects.toThrow(/resume refused.*align-checkpoint\.json/s)
	})

	it("refuses to resume when a recorded parquet file is no longer on disk", async () => {
		const outDir = scratch.path("build")

		await buildCorpus({ ...options, outputDir: outDir })

		const recorded = (await parquetManifest(outDir)).slices[0]!

		await removeFile(recorded.path)
		await removePath(outDir("intermediate", "align-checkpoint.json"))

		await expect(buildCorpus({ ...options, outputDir: outDir, priorOutput: PriorOutput.Resume })).rejects.toThrow(
			/resume refused.*no file sits at that path/s
		)
	})

	const intermediateSizes = async (outDir: PathBuilder): Promise<Record<string, number | null>> => {
		const sizes: Record<string, number | null> = {}

		for (const name of [
			"labeled-train.jsonl",
			"labeled-val.jsonl",
			"labeled-test.jsonl",
			"quarantine.jsonl",
			"align-checkpoint.json",
			"wof-admin/canonical.jsonl",
			"wof-admin/MANIFEST.json",
		]) {
			const path = outDir("intermediate", ...name.split("/"))

			sizes[name] = (await pathExists(path)) ? (await statPath(path)).size : null
		}

		return sizes
	}

	it("refuses a rerun into an output holding a checkpoint and leaves every file as it was", async () => {
		const outDir = scratch.path("build")

		await buildCorpus({ ...options, outputDir: outDir })

		const before = await intermediateSizes(outDir)
		const trainDigest = await sha256File(outDir("intermediate", "labeled-train.jsonl"))

		expect(before["labeled-train.jsonl"]).toBeGreaterThan(0)

		await expect(buildCorpus({ ...options, outputDir: outDir })).rejects.toThrow(
			/corpus build refused.*align-checkpoint\.json records 1 aligned adapters: wof-admin.*labeled-train\.jsonl: [\d,]+ bytes.*--resume.*--fresh/s
		)

		expect(await intermediateSizes(outDir)).toEqual(before)
		expect(await sha256File(outDir("intermediate", "labeled-train.jsonl"))).toBe(trainDigest)
	})

	it("refuses a rerun when only a finished adapter run is present", async () => {
		const outDir = scratch.path("build")

		await buildCorpus({ ...options, outputDir: outDir })

		for (const name of ["labeled-train.jsonl", "labeled-val.jsonl", "labeled-test.jsonl", "quarantine.jsonl"]) {
			await removePath(outDir("intermediate", name))
		}

		await removePath(outDir("intermediate", "align-checkpoint.json"))

		const before = await intermediateSizes(outDir)

		await expect(buildCorpus({ ...options, outputDir: outDir })).rejects.toThrow(/adapter run wof-admin/)
		expect(await intermediateSizes(outDir)).toEqual(before)
	})

	it("continues from the checkpoint on a resume rather than aligning a completed adapter again", async () => {
		const outDir = scratch.path("build")

		await buildCorpus({ ...options, outputDir: outDir })

		const before = await intermediateSizes(outDir)
		const stages: string[] = []

		await buildCorpus({
			...options,
			outputDir: outDir,
			priorOutput: PriorOutput.Resume,
			onProgress: (_stage, message) => stages.push(message),
		})

		expect(stages.some((message) => message.startsWith("resumed wof-admin"))).toBe(true)
		expect(stages.some((message) => message.startsWith("aligning wof-admin"))).toBe(false)

		const after = await intermediateSizes(outDir)

		expect(after["labeled-train.jsonl"]).toBe(before["labeled-train.jsonl"])
		expect(after["wof-admin/canonical.jsonl"]).toBe(before["wof-admin/canonical.jsonl"])
	})

	it("deletes the prior work and builds from the start under an explicit fresh choice", async () => {
		const outDir = scratch.path("build")

		const first = await buildCorpus({ ...options, outputDir: outDir })
		const trainPath = outDir("intermediate", "labeled-train.jsonl")
		const digest = await sha256File(trainPath)

		// Stands for rows a fresh build must not keep.
		await appendLocalTextFile(`${stringifyJSON({ raw: "row from the earlier build" })}\n`, trainPath)

		const stages: string[] = []

		const second = await buildCorpus({
			...options,
			outputDir: outDir,
			priorOutput: PriorOutput.Fresh,
			onProgress: (_stage, message) => stages.push(message),
		})

		expect(stages.some((message) => message.startsWith("aligning wof-admin"))).toBe(true)
		expect(stages.some((message) => message.startsWith("resumed"))).toBe(false)
		expect(second.total_aligned_rows).toBe(first.total_aligned_rows)
		expect(await sha256File(trainPath)).toBe(digest)
	})
})

// Who's On First's committed decision is elected, so these tests refuse its
// register row in a copy of the register.
// They measure how a build treats a refused row, whatever the committed decision says.
vi.mock("#source-register/register", async (importOriginal) => {
	const original = await importOriginal<typeof import("#source-register/register")>()

	return {
		...original,
		readAddressSourceRegister: async () => {
			const register = await original.readAddressSourceRegister()

			if (!refuseWhosOnFirst.active) return register

			const license = register.sources.find((row) => row.sourceID === "us-geodata-aggregate-2")?.license

			return {
				...register,
				licenses: register.licenses.map((decision) =>
					decision.licenseID === license ? { ...decision, state: "refused" as const } : decision
				),
			}
		},
	}
})

const refuseWhosOnFirst = vi.hoisted(() => ({ active: false }))

describe("buildCorpus source rights", () => {
	// The suite runs with `isolate: false`, so a file earlier in the worker may
	// already have loaded `#build` over the real register.
	// Reloading it here makes it read the register through the mock above.
	let buildWithMockedRegister: typeof buildCorpus

	beforeAll(async () => {
		vi.resetModules()
		buildWithMockedRegister = (await import("#build")).buildCorpus
	})

	beforeEach(() => {
		refuseWhosOnFirst.active = true
	})

	afterEach(() => {
		refuseWhosOnFirst.active = false
	})

	it("refuses a source whose register row lacks a transform and train permission before any adapter runs", async () => {
		const outDir = scratch.path("refused")

		await expect(
			buildWithMockedRegister({
				outputDir: outDir,
				corpusVersion: "0.1.0",
				adapters: [wofAdminAdapter],
				adapterInputs: { "wof-admin": { inputPath: fixtureRoot } },
			})
		).rejects.toThrow(
			/corpus source wof-admin reads register source us-geodata-aggregate-2 .*refused.*transform and train/s
		)

		expect(await pathExists(outDir("intermediate", "labeled-train.jsonl"))).toBe(false)
		expect(await pathExists(outDir("MANIFEST.json"))).toBe(false)
	})

	it("records the corpus as not shippable when the override admits the source", async () => {
		const outDir = scratch.path("override")

		const manifest = await buildWithMockedRegister({
			outputDir: outDir,
			corpusVersion: "0.1.0",
			adapters: [wofAdminAdapter],
			unshippableReason: FIXTURE_RIGHTS,
			adapterInputs: { "wof-admin": { inputPath: fixtureRoot } },
			synthesize: false,
		})

		expect(manifest.source_rights.shippable).toBe(false)
		expect(manifest.source_rights.unshippable_reason).toBe(FIXTURE_RIGHTS)
		expect(manifest.source_rights.gaps.map((gap) => gap.registerSource)).toContain("us-geodata-aggregate-2")
		expect((await readLocalJSONFile<typeof manifest>(outDir("MANIFEST.json"))).source_rights.shippable).toBe(false)
	})
})
