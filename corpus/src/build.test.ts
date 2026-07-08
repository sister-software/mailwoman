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

import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { repoRootPath } from "@mailwoman/core/utils"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { wofAdminAdapter } from "./adapters/wof-admin-json/adapter.js"
import { buildCorpus, type BuildStage } from "./build.js"
import { ParquetReader } from "./parquet-wrapper/index.js"
import type { ParquetRow } from "./parquet.js"

const fixtureRoot = repoRootPath("corpus", "fixtures", "wof-admin-json")

let scratch: string

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "mailwoman-build-"))
})

afterEach(async () => {
	await rm(scratch, { recursive: true, force: true }).catch(() => {})
})

describe("buildCorpus end-to-end against wof-admin JSON-bundle fixture", () => {
	it("produces top-level MANIFEST.json + parquet shards + splits + quarantine pile", async () => {
		const outDir = join(scratch, "build")
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
		expect(stages).toEqual(expect.arrayContaining(["adapter-run", "align", "split", "shard", "manifest"]))

		expect(manifest.corpus_version).toBe("0.1.0")
		expect(manifest.adapters).toHaveLength(1)
		expect(manifest.adapters[0]!.adapter_id).toBe("wof-admin")
		expect(manifest.total_aligned_rows).toBeGreaterThan(0)
		expect(manifest.shards.total_rows).toBe(manifest.total_aligned_rows)
		expect(manifest.splits.counts.train).toBeGreaterThan(0)

		// Top-level manifest written
		const onDisk = JSON.parse(await readFile(join(outDir, "MANIFEST.json"), "utf8"))
		expect(onDisk.corpus_version).toBe("0.1.0")

		// Per-stage artifacts exist
		const corpusManifest = JSON.parse(await readFile(join(outDir, "corpus-v0.1.0", "MANIFEST.json"), "utf8"))
		expect(corpusManifest.total_rows).toBe(manifest.total_aligned_rows)
		expect(corpusManifest.shards.length).toBeGreaterThanOrEqual(1)

		const splitManifest = JSON.parse(await readFile(join(outDir, "splits", "SPLIT_MANIFEST.json"), "utf8"))
		expect(splitManifest.corpus_version).toBe("0.1.0")
		expect(splitManifest.holdouts.US).toContain("Vermont")

		// At least one `.parquet` shard exists and round-trips through `ParquetReader`.
		const trainShard = corpusManifest.shards.find((s: { split: string }) => s.split === "train")
		expect(trainShard).toBeDefined()
		expect(trainShard.format).toBe("parquet")
		expect(trainShard.path).toMatch(/\.parquet$/)
		const reader = await ParquetReader.openFile<ParquetRow>(trainShard.path)
		const cursor = reader.getCursor()
		const firstRow = (await cursor.next()) as ParquetRow | null
		await reader.close()
		expect(firstRow).not.toBeNull()
		expect(firstRow!.corpus_version).toBe("0.1.0")
		expect(firstRow!.tokens.length).toBe(firstRow!.labels.length)
	})

	it("routes rows whose components.region is held out to val/test", async () => {
		const outDir = join(scratch, "build")
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
		const readJsonl = async (path: string) =>
			(await readFile(path, "utf8"))
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as { source_id: string; components: { region?: string } })

		const trainRows = await readJsonl(join(outDir, "intermediate", "labeled-train.jsonl"))
		const valRows = await readJsonl(join(outDir, "intermediate", "labeled-val.jsonl"))
		const testRows = await readJsonl(join(outDir, "intermediate", "labeled-test.jsonl"))

		const vermontHeldOut = [...valRows, ...testRows].filter((r) => r.components.region === "Vermont")
		expect(vermontHeldOut.length).toBeGreaterThan(0)
		expect(trainRows.filter((r) => r.components.region === "Vermont")).toEqual([])

		// The .txt manifests stay in lockstep with the per-split JSONL.
		const trainIds = new Set(
			(await readFile(join(outDir, "splits", "train.txt"), "utf8")).trim().split("\n").filter(Boolean)
		)

		for (const r of vermontHeldOut) {
			expect(trainIds.has(r.source_id)).toBe(false)
		}
	})

	it("synthesis fan-out increases row count over the non-synth path", async () => {
		const noSynth = await buildCorpus({
			outputDir: join(scratch, "no-synth"),
			corpusVersion: "0.1.0",
			adapters: [wofAdminAdapter],
			adapterInputs: { "wof-admin": { inputPath: fixtureRoot } },
			synthesize: false,
		})
		const withSynth = await buildCorpus({
			outputDir: join(scratch, "with-synth"),
			corpusVersion: "0.1.0",
			adapters: [wofAdminAdapter],
			adapterInputs: { "wof-admin": { inputPath: fixtureRoot } },
			synthesize: true,
		})
		expect(withSynth.total_aligned_rows).toBeGreaterThan(noSynth.total_aligned_rows)
	})

	it("notes skipped adapters when no inputs configured", async () => {
		const manifest = await buildCorpus({
			outputDir: join(scratch, "build"),
			corpusVersion: "0.1.0",
			adapters: [wofAdminAdapter],
			adapterInputs: {}, // no input for wof-admin
		})
		expect(manifest.skipped_adapters).toContain("wof-admin")
		expect(manifest.adapters).toHaveLength(0)
		expect(manifest.total_aligned_rows).toBe(0)
	})
})
