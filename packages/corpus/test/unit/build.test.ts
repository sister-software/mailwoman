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
 *   assertion still keys on "Vermont" since that's defined by the corpus split policy, not the
 *   fixture shape.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { workspacePath } from "@mailwoman/core/paths"
import { wofAdminAdapter } from "@mailwoman/corpus/adapters/wof-admin-json/adapter"
import { buildCorpus, type BuildStage } from "@mailwoman/corpus/build"
import { ParquetReader } from "@mailwoman/corpus/parquet-wrapper"
import type { ParquetRow } from "@mailwoman/corpus/utils/parquet"
import { join } from "path-ts"
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
	it("produces top-level MANIFEST.json + parquet slices + splits + quarantine pile", async () => {
		const outDir = scratch.resolve("build")
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
		expect(stages).toEqual(expect.arrayContaining(["adapter-run", "align", "split", "slice", "manifest"]))

		expect(manifest.corpus_version).toBe("0.1.0")
		expect(manifest.adapters).toHaveLength(1)
		expect(manifest.adapters[0]!.adapter_id).toBe("wof-admin")
		expect(manifest.total_aligned_rows).toBeGreaterThan(0)
		expect(manifest.slices.total_rows).toBe(manifest.total_aligned_rows)
		expect(manifest.splits.counts.train).toBeGreaterThan(0)

		// Top-level manifest written
		const onDisk = await readLocalJSONFile<{ corpus_version: string }>(join(outDir, "MANIFEST.json"))
		expect(onDisk.corpus_version).toBe("0.1.0")

		// Per-stage artifacts exist
		const corpusManifest = await readLocalJSONFile<{
			total_rows: number
			slices: Array<{ split: string; format: string; path: string }>
		}>(join(outDir, "corpus-v0.1.0", "MANIFEST.json"))

		expect(corpusManifest.total_rows).toBe(manifest.total_aligned_rows)
		expect(corpusManifest.slices.length).toBeGreaterThanOrEqual(1)

		const splitManifest = await readLocalJSONFile<{ corpus_version: string; holdouts: Record<string, string[]> }>(
			join(outDir, "splits", "SPLIT_MANIFEST.json")
		)

		expect(splitManifest.corpus_version).toBe("0.1.0")
		expect(splitManifest.holdouts.US).toContain("Vermont")

		// At least one `.parquet` slice exists and round-trips through `ParquetReader`.
		const trainSlice = corpusManifest.slices.find((s) => s.split === "train")!
		expect(trainSlice).toBeDefined()
		expect(trainSlice.format).toBe("parquet")
		expect(trainSlice.path).toMatch(/\.parquet$/)
		await using reader = await ParquetReader.openFile<ParquetRow>(trainSlice.path)
		const cursor = reader.getCursor()
		const firstRow = (await cursor.next()) as ParquetRow | null
		expect(firstRow).not.toBeNull()
		expect(firstRow!.corpus_version).toBe("0.1.0")
		expect(firstRow!.tokens).toHaveLength(firstRow!.labels.length)
	})

	it("routes rows whose components.region is held out to val/test", async () => {
		const outDir = scratch.resolve("build")

		await buildCorpus({
			outputDir: outDir,
			corpusVersion: "0.1.0",
			adapters: [wofAdminAdapter],
			adapterInputs: { "wof-admin": { inputPath: fixtureRoot, country: "US" } },
			synthesize: false,
		})

		// Vermont-bearing rows after the refactor live in labeled-val.jsonl or labeled-test.jsonl,
		// never in labeled-train.jsonl. Scan all three for the Vermont component and assert the
		// train stream produced none.
		const readJsonl = (path: string) =>
			Array.fromAsync(JSONSpliterator.fromAsync<{ source_id: string; components: { region?: string } }>(path))

		const trainRows = await readJsonl(join(outDir, "intermediate", "labeled-train.jsonl"))
		const valRows = await readJsonl(join(outDir, "intermediate", "labeled-val.jsonl"))
		const testRows = await readJsonl(join(outDir, "intermediate", "labeled-test.jsonl"))

		const vermontHeldOut = [...valRows, ...testRows].filter((r) => r.components.region === "Vermont")
		expect(vermontHeldOut.length).toBeGreaterThan(0)
		expect(trainRows.filter((r) => r.components.region === "Vermont")).toEqual([])

		// The .txt manifests stay in lockstep with the per-split JSONL.
		const trainIDs = new Set(await Array.fromAsync(TextSpliterator.fromAsync(join(outDir, "splits", "train.txt"))))

		for (const r of vermontHeldOut) {
			expect(trainIDs.has(r.source_id)).toBe(false)
		}
	})

	it("synthesis fan-out increases row count over the non-synth path", async () => {
		const noSynth = await buildCorpus({
			outputDir: scratch.resolve("no-synth"),
			corpusVersion: "0.1.0",
			adapters: [wofAdminAdapter],
			adapterInputs: { "wof-admin": { inputPath: fixtureRoot } },
			synthesize: false,
		})

		const withSynth = await buildCorpus({
			outputDir: scratch.resolve("with-synth"),
			corpusVersion: "0.1.0",
			adapters: [wofAdminAdapter],
			adapterInputs: { "wof-admin": { inputPath: fixtureRoot } },
			synthesize: true,
		})

		expect(withSynth.total_aligned_rows).toBeGreaterThan(noSynth.total_aligned_rows)
	})

	it("notes skipped adapters when no inputs configured", async () => {
		const manifest = await buildCorpus({
			outputDir: scratch.resolve("build"),
			corpusVersion: "0.1.0",
			adapters: [wofAdminAdapter],
			adapterInputs: {}, // no input for wof-admin
		})

		expect(manifest.skipped_adapters).toContain("wof-admin")
		expect(manifest.adapters).toHaveLength(0)
		expect(manifest.total_aligned_rows).toBe(0)
	})
})
