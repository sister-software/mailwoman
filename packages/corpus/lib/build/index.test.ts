/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { pathExists, readLocalJSONFile, statPath } from "@mailwoman/core/fs/readers"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { appendLocalTextFile, removeFile, removePath } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { workspacePath } from "@mailwoman/core/paths"
import type { PathBuilder } from "path-ts"
import { JSONSpliterator, TextSpliterator } from "spliterator"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { wofAdminAdapter } from "#adapters/wof/admin/json/adapter"
import {
	assertHeapForAdapters,
	buildCorpus,
	BuildProfile,
	RESIDENT_ADAPTER_HEAP_FLOOR_BYTES,
	type BuildStage,
} from "#build"
import type { AlignCheckpoint } from "#build/checkpoint"
import type { ParquetRow } from "#parquet/schema"
import { openParquetRowStream } from "#parquet/streams"
import type { ParquetManifest } from "#parquet/writers"
import { compileLicenseExcludes, LicensePolicy, LicenseRefusalKind } from "#utils/license"

const fixtureRoot = workspacePath("corpus", "fixtures", "wof-admin-json")

let scratch: TemporaryDirectory

beforeEach(async () => {
	scratch = await temporaryDirectory("mailwoman-build-")
})

afterEach(async () => {
	scratch[Symbol.asyncDispose]()
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
			slices: Array<{ split: string; format: string; path: string }>
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
		expect(firstRow!.corpus_version).toBe("0.1.0")
		expect(firstRow!.tokens).toHaveLength(firstRow!.labels.length)
	})

	it("routes rows whose components.region is held out to val/test", async () => {
		const outDir = scratch.path("build")

		await buildCorpus({
			outputDir: outDir,
			corpusVersion: "0.1.0",
			adapters: [wofAdminAdapter],
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
			adapterInputs: { "wof-admin": { inputPath: fixtureRoot } },
			synthesize: false,
		})

		const withSynth = await buildCorpus({
			outputDir: scratch.path("with-synth"),
			corpusVersion: "0.1.0",
			adapters: [wofAdminAdapter],
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
			adapterInputs: { "wof-admin": { inputPath: fixtureRoot } },
			synthesize: true,
			profile: BuildProfile.ReleaseEligible,
		})

		expect(manifest.total_aligned_rows).toBe(0)
		expect(manifest.excluded_by_eligibility).toBeGreaterThan(0)

		expect(Object.keys(manifest.ineligible_sources)).toEqual(["wof-admin"])
		expect(manifest.ineligible_sources["wof-admin"]?.[0]).toContain("the register names no source")
	})

	it("keeps a refused source out of the synthetic rows fanned from it", async () => {
		// An augmentation inherits its ancestor's `source`, so the eligibility check must run
		// before `synthesizeRow` for the ancestor's refusal to cover the fan-out.
		const withSynth = await buildCorpus({
			outputDir: scratch.path("release-eligible-synth"),
			corpusVersion: "0.1.0",
			adapters: [wofAdminAdapter],
			adapterInputs: { "wof-admin": { inputPath: fixtureRoot } },
			synthesize: true,
			profile: BuildProfile.ReleaseEligible,
		})

		const withoutSynth = await buildCorpus({
			outputDir: scratch.path("release-eligible-nosynth"),
			corpusVersion: "0.1.0",
			adapters: [wofAdminAdapter],
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
			adapterInputs: { "wof-admin": { inputPath: fixtureRoot } },
		})

		const free = await buildCorpus({
			outputDir: scratch.path("free"),
			corpusVersion: "0.1.0",
			adapters: [wofAdminAdapter],
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

	afterEach(() => {
		vi.unstubAllEnvs()
	})

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

		vi.stubEnv("MAILWOMAN_RESUME", "1")

		const second = await buildCorpus({
			...options,
			outputDir: outDir,
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

		vi.stubEnv("MAILWOMAN_RESUME", "1")

		await buildCorpus({ ...options, outputDir: outDir })

		expect(await sha256File(trainPath)).toBe(before)
	})

	it("refuses to resume under align settings the checkpoint was not written under", async () => {
		const outDir = scratch.path("build")

		await buildCorpus({ ...options, outputDir: outDir })

		vi.stubEnv("MAILWOMAN_RESUME", "1")

		await expect(buildCorpus({ ...options, outputDir: outDir, synthesize: false })).rejects.toThrow(
			/resume refused.*align-checkpoint\.json/s
		)
	})

	it("refuses to resume when a recorded parquet file is no longer on disk", async () => {
		const outDir = scratch.path("build")

		await buildCorpus({ ...options, outputDir: outDir })

		const recorded = (await parquetManifest(outDir)).slices[0]!

		await removeFile(recorded.path)
		await removePath(outDir("intermediate", "align-checkpoint.json"))

		vi.stubEnv("MAILWOMAN_RESUME", "1")

		await expect(buildCorpus({ ...options, outputDir: outDir })).rejects.toThrow(
			/resume refused.*no file sits at that path/s
		)
	})
})
