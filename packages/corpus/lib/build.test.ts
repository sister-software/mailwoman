/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   End-to-end integration test for `buildCorpus` against the wof-admin JSON-bundle fixture.
 *
 *   Phase 1.5.1 moved the WOF adapters from SQLite to per-record GeoJSON bundles. This test was
 *   updated in lockstep: the adapter is the JSON-bundle implementation at
 *   `./adapters/wof-admin-json/`, the fixture is a directory of cloned-repo skeletons under
 *   `../fixtures/wof-admin-json/` (no on-disk SQLite materialization step), and the holdout
 *   assertion still keys on "Vermont" since that's defined by the corpus split policy rather than the
 *   fixture shape.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { workspacePath } from "@mailwoman/core/paths"
import { wofAdminAdapter } from "@mailwoman/corpus/adapters/wof/admin/json/adapter"
import { buildCorpus, BuildProfile, type BuildStage } from "@mailwoman/corpus/build"
import type { ParquetRow } from "@mailwoman/corpus/parquet/schema"
import { openParquetRowStream } from "@mailwoman/corpus/parquet/streams"
import type { PathBuilder } from "path-ts"
import { JSONSpliterator, TextSpliterator } from "spliterator"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const fixtureRoot = workspacePath("corpus", "fixtures", "wof-admin-json")

let scratch: TemporaryDirectory

beforeEach(async () => {
	scratch = await temporaryDirectory("mailwoman-build-")
})

afterEach(async () => {
	scratch[Symbol.asyncDispose]()
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

		// Stages fire in order
		expect(stages).toEqual(expect.arrayContaining(["adapter-run", "align", "split", "parquet", "manifest"]))

		expect(manifest.corpus_version).toBe("0.1.0")
		expect(manifest.adapters).toHaveLength(1)
		expect(manifest.adapters[0]!.adapter_id).toBe("wof-admin")
		expect(manifest.total_aligned_rows).toBeGreaterThan(0)
		expect(manifest.slices.total_rows).toBe(manifest.total_aligned_rows)
		expect(manifest.splits.counts.train).toBeGreaterThan(0)

		// Top-level manifest written
		const onDisk = await readLocalJSONFile<{ corpus_version: string }>(outDir("MANIFEST.json"))
		expect(onDisk.corpus_version).toBe("0.1.0")

		// Per-stage artifacts exist
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

		// At least one `.parquet` file exists and round-trips through DuckDB.
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

		// The .txt manifests stay in lockstep with the per-split jsonl.
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

		// The default, and what every build did before profiles existed.
		expect(manifest.profile).toBe(BuildProfile.Exploratory)
		expect(manifest.excluded_by_eligibility).toBe(0)
		expect(manifest.ineligible_sources).toEqual({})
		expect(manifest.total_aligned_rows).toBeGreaterThan(0)
	})

	it("admits no row under the release-eligible profile while every source's terms are unread", async () => {
		// `wof-admin` is not a register source at all, and every one of the register's
		// 389 sources reads `unchecked`.
		// Both refusals land in the same place: a source nobody reviewed contributes
		// nothing to a corpus that reaches a published model.
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

		// The build says what to fix rather than only that it stopped.
		expect(Object.keys(manifest.ineligible_sources)).toEqual(["wof-admin"])
		expect(manifest.ineligible_sources["wof-admin"]?.[0]).toContain("the register names no source")
	})

	it("keeps a refused source out of the synthetic rows fanned from it", async () => {
		// The re-entry path P2 names: an augmentation carries its ancestor's `source`, so a check
		// running after the fan-out would admit a refused source's rows under a synthetic label.
		// The eligibility check runs before `synthesizeRow`, so the ancestor's
		// refusal covers everything derived from it.
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

		// Turning synthesis on adds no rows, because the rows it would fan from never got past the refusal.
		expect(withSynth.total_aligned_rows).toBe(0)
		expect(withoutSynth.total_aligned_rows).toBe(0)
		expect(withSynth.excluded_by_eligibility).toBe(withoutSynth.excluded_by_eligibility)
	})

	it("notes skipped adapters when no inputs configured", async () => {
		const manifest = await buildCorpus({
			outputDir: scratch.path("build"),
			corpusVersion: "0.1.0",
			adapters: [wofAdminAdapter],
			adapterInputs: {}, // no input for wof-admin
		})

		expect(manifest.skipped_adapters).toContain("wof-admin")
		expect(manifest.adapters).toHaveLength(0)
		expect(manifest.total_aligned_rows).toBe(0)
	})
})
