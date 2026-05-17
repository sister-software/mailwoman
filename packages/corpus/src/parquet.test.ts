/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { PARQUET_COLUMNS, rowToParquet, writeShards, type ParquetRow } from "./parquet.js"
import type { SplitName } from "./split.js"
import type { LabeledRow } from "./types.js"

const labeled = (over: Partial<LabeledRow>): LabeledRow => ({
	raw: "Paris",
	components: { locality: "Paris" },
	country: "FR",
	source: "test",
	source_id: "t-1",
	corpus_version: "0.1.0",
	license: "CC0-1.0",
	tokens: ["Paris"],
	labels: ["B-locality"],
	...over,
})

async function* asyncFrom<T>(items: readonly T[]): AsyncIterable<T> {
	for (const item of items) yield item
}

let scratch: string
beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "mailwoman-parquet-"))
})
afterEach(async () => {
	await rm(scratch, { recursive: true, force: true }).catch(() => {})
})

describe("rowToParquet", () => {
	it("flattens synth + locale onto top-level columns", () => {
		const row = labeled({
			locale: "fr-FR",
			synth: { method: "case-upper", base_source_id: "t-1" },
			source_id: "t-1+case-upper",
		})
		const pq = rowToParquet(row)
		expect(pq.locale).toBe("fr-FR")
		expect(pq.synth_method).toBe("case-upper")
		expect(pq.synth_base_id).toBe("t-1")
		expect(pq.source_id).toBe("t-1+case-upper")
	})

	it("emits null for missing optional fields", () => {
		const pq = rowToParquet(labeled({ locale: undefined, synth: undefined }))
		expect(pq.locale).toBeNull()
		expect(pq.synth_method).toBeNull()
		expect(pq.synth_base_id).toBeNull()
	})

	it("preserves tokens + labels array shape", () => {
		const pq = rowToParquet(labeled({ tokens: ["Paris", "France"], labels: ["B-locality", "B-country"] }))
		expect(pq.tokens).toEqual(["Paris", "France"])
		expect(pq.labels).toEqual(["B-locality", "B-country"])
	})
})

describe("writeShards", () => {
	it("PARQUET_COLUMNS lists every emitted column in order", () => {
		const cols: string[] = [...PARQUET_COLUMNS]
		expect(cols).toEqual([
			"raw",
			"tokens",
			"labels",
			"country",
			"locale",
			"source",
			"source_id",
			"corpus_version",
			"license",
			"synth_method",
			"synth_base_id",
		])
	})

	it("writes per-split JSONL shards + MANIFEST.json", async () => {
		const splitFor = (id: string): SplitName => {
			if (id === "t-1") return "val"
			if (id === "t-2") return "test"
			return "train"
		}

		const rows: LabeledRow[] = [
			labeled({ source_id: "t-1", raw: "Paris" }),
			labeled({ source_id: "t-2", raw: "Lyon" }),
			labeled({ source_id: "t-3", raw: "Marseille" }),
			labeled({ source_id: "t-4", raw: "Nice" }),
		]

		const m = await writeShards(asyncFrom(rows), {
			outputDir: scratch,
			corpusVersion: "0.1.0",
			rowsPerShard: 10,
			splitFor,
		})

		expect(m.total_rows).toBe(4)
		expect(m.counts).toEqual({ train: 2, val: 1, test: 1 })
		expect(m.shards).toHaveLength(3)

		const trainShard = m.shards.find((s) => s.split === "train")!
		expect(trainShard.rows).toBe(2)
		expect(trainShard.first_source_id).toBe("t-3")
		expect(trainShard.last_source_id).toBe("t-4")
		expect(trainShard.sha256).toMatch(/^[0-9a-f]{64}$/)

		const trainFile = await readFile(trainShard.path, "utf8")
		const trainRows = trainFile
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as ParquetRow)
		expect(trainRows).toHaveLength(2)
		expect(trainRows[0]!.raw).toBe("Marseille")
		expect(trainRows[0]!.tokens).toEqual(["Paris"])

		const manifestOnDisk = JSON.parse(await readFile(join(scratch, "corpus-v0.1.0", "MANIFEST.json"), "utf8"))
		expect(manifestOnDisk.total_rows).toBe(4)
		expect(manifestOnDisk.schema).toEqual([...PARQUET_COLUMNS])
	})

	it("rolls to a new shard at rowsPerShard rows", async () => {
		const rows: LabeledRow[] = Array.from({ length: 25 }, (_, i) => labeled({ source_id: `t-${i}`, raw: `row ${i}` }))
		const m = await writeShards(asyncFrom(rows), {
			outputDir: scratch,
			corpusVersion: "0.1.0",
			rowsPerShard: 10,
			splitFor: () => "train",
		})

		const trainShards = m.shards.filter((s) => s.split === "train")
		expect(trainShards).toHaveLength(3) // 10 + 10 + 5
		expect(trainShards[0]!.rows).toBe(10)
		expect(trainShards[1]!.rows).toBe(10)
		expect(trainShards[2]!.rows).toBe(5)
		expect(m.total_rows).toBe(25)
	})

	it("two runs over the same rows produce identical sha256 per shard", async () => {
		const rows = [labeled({ source_id: "t-1", raw: "A" }), labeled({ source_id: "t-2", raw: "B" })]
		const a = await writeShards(asyncFrom(rows), {
			outputDir: scratch,
			corpusVersion: "0.1.0",
			splitFor: () => "train",
		})
		await rm(join(scratch, "corpus-v0.1.0"), { recursive: true, force: true })
		const b = await writeShards(asyncFrom(rows), {
			outputDir: scratch,
			corpusVersion: "0.1.0",
			splitFor: () => "train",
		})
		expect(a.shards[0]!.sha256).toBe(b.shards[0]!.sha256)
	})
})
