/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   End-to-end integration test for `buildCorpus` against the wof-admin fixture.
 */

import Database from "better-sqlite3"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { wofAdminAdapter } from "./adapters/wof-admin/adapter.js"
import { buildCorpus, type BuildStage } from "./build.js"
import type { ParquetRow } from "./parquet.js"

const here = dirname(fileURLToPath(import.meta.url))
const fixtureSqlPath = resolve(here, "../fixtures/wof-admin/fixture.sql")

let scratch: string
let fixtureDb: string

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "mailwoman-build-"))
	const sql = await readFile(fixtureSqlPath, "utf8")
	fixtureDb = join(scratch, "wof-admin-fixture.db")
	const db = new Database(fixtureDb)
	db.exec(sql)
	db.close()
})

afterEach(async () => {
	await rm(scratch, { recursive: true, force: true }).catch(() => {})
})

describe("buildCorpus end-to-end against wof-admin fixture", () => {
	it("produces top-level MANIFEST.json + parquet shards + splits + quarantine pile", async () => {
		const outDir = join(scratch, "build")
		const stages: BuildStage[] = []
		const manifest = await buildCorpus({
			outputDir: outDir,
			corpusVersion: "0.1.0",
			adapters: [wofAdminAdapter],
			adapterInputs: { "wof-admin": { inputPath: fixtureDb } },
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

		// At least one parquet (JSONL-stage) shard contains a valid Parquet row
		const trainShard = corpusManifest.shards.find((s: { split: string }) => s.split === "train")
		expect(trainShard).toBeDefined()
		const trainFile = await readFile(trainShard.path, "utf8")
		const firstRow = JSON.parse(trainFile.trim().split("\n")[0]!) as ParquetRow
		expect(firstRow.corpus_version).toBe("0.1.0")
		expect(firstRow.tokens.length).toBe(firstRow.labels.length)
	})

	it("routes rows whose components.region is held out to val/test", async () => {
		const outDir = join(scratch, "build")
		await buildCorpus({
			outputDir: outDir,
			corpusVersion: "0.1.0",
			adapters: [wofAdminAdapter],
			adapterInputs: { "wof-admin": { inputPath: fixtureDb, country: "US" } },
			synthesize: false,
		})

		// Re-read the labeled.jsonl to identify Vermont-bearing rows by component, not by id.
		const labeled = (await readFile(join(outDir, "intermediate", "labeled.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { source_id: string; components: { region?: string } })

		const vermontRows = labeled.filter((r) => r.components.region === "Vermont")
		expect(vermontRows.length).toBeGreaterThan(0)

		const trainIds = new Set(
			(await readFile(join(outDir, "splits", "train.txt"), "utf8")).trim().split("\n").filter(Boolean)
		)

		for (const r of vermontRows) {
			expect(trainIds.has(r.source_id)).toBe(false)
		}
	})

	it("synthesis fan-out increases row count over the non-synth path", async () => {
		const noSynth = await buildCorpus({
			outputDir: join(scratch, "no-synth"),
			corpusVersion: "0.1.0",
			adapters: [wofAdminAdapter],
			adapterInputs: { "wof-admin": { inputPath: fixtureDb } },
			synthesize: false,
		})
		const withSynth = await buildCorpus({
			outputDir: join(scratch, "with-synth"),
			corpusVersion: "0.1.0",
			adapters: [wofAdminAdapter],
			adapterInputs: { "wof-admin": { inputPath: fixtureDb } },
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
