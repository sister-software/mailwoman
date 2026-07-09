/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { ParquetReader } from "./parquet-wrapper/index.ts"
import {
	LABELED_ROW_SCHEMA,
	PARQUET_COLUMNS,
	ROW_GROUP_SIZE,
	SHARD_COMPRESSION,
	rowToParquet,
	writeShards,
	type ParquetRow,
} from "./parquet.ts"
import type { LabeledRow } from "./types.ts"

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
	span_starts: [0],
	span_ends: [5],
	span_tags: ["locality"],
	...over,
})

async function* asyncFrom<T>(items: readonly T[]): AsyncIterable<T> {
	for (const item of items) {
		yield item
	}
}

/** Read every row from a `.parquet` file in on-disk order. */
async function readParquet(path: string): Promise<ParquetRow[]> {
	const reader = await ParquetReader.openFile<ParquetRow>(path)
	const cursor = reader.getCursor()
	const out: ParquetRow[] = []
	let row: ParquetRow | null

	while ((row = (await cursor.next()) as ParquetRow | null)) {
		out.push(row)
	}
	await reader.close()

	return out
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

	it("preserves the char-offset span triple (#519)", () => {
		const pq = rowToParquet(
			labeled({
				raw: "Paris, France",
				tokens: ["Paris", "France"],
				labels: ["B-locality", "B-country"],
				span_starts: [0, 7],
				span_ends: [5, 13],
				span_tags: ["locality", "country"],
			})
		)
		expect(pq.span_starts).toEqual([0, 7])
		expect(pq.span_ends).toEqual([5, 13])
		expect(pq.span_tags).toEqual(["locality", "country"])
	})

	it("throws loudly when the span triple is absent (un-migrated producer)", () => {
		expect(() => rowToParquet(labeled({ span_starts: undefined, span_ends: undefined, span_tags: undefined }))).toThrow(
			/missing the char-offset span triple/
		)
	})

	it("throws loudly on a partial span triple (corrupt row, never a silent fallback)", () => {
		expect(() => rowToParquet(labeled({ span_tags: undefined }))).toThrow(/missing the char-offset span triple/)
		expect(() => rowToParquet(labeled({ span_starts: undefined }))).toThrow(/missing the char-offset span triple/)
	})

	it("throws loudly when the span arrays are not parallel", () => {
		expect(() => rowToParquet(labeled({ span_starts: [0, 7] }))).toThrow(/not parallel/)
	})
})

describe("LABELED_ROW_SCHEMA", () => {
	it("covers every PARQUET_COLUMNS entry", () => {
		expect(Object.keys(LABELED_ROW_SCHEMA).sort()).toEqual([...PARQUET_COLUMNS].sort())
	})

	it("marks locale / synth_method / synth_base_id optional", () => {
		expect(LABELED_ROW_SCHEMA.locale.optional).toBe(true)
		expect(LABELED_ROW_SCHEMA.synth_method.optional).toBe(true)
		expect(LABELED_ROW_SCHEMA.synth_base_id.optional).toBe(true)
	})

	it("marks tokens / labels REPEATED", () => {
		expect(LABELED_ROW_SCHEMA.tokens.repeated).toBe(true)
		expect(LABELED_ROW_SCHEMA.labels.repeated).toBe(true)
	})

	it("marks the span triple REPEATED, offsets as INT32 (#519)", () => {
		expect(LABELED_ROW_SCHEMA.span_starts).toMatchObject({ type: "INT32", repeated: true })
		expect(LABELED_ROW_SCHEMA.span_ends).toMatchObject({ type: "INT32", repeated: true })
		expect(LABELED_ROW_SCHEMA.span_tags).toMatchObject({ type: "UTF8", repeated: true })
	})

	it("uses SHARD_COMPRESSION on every column", () => {
		for (const def of Object.values(LABELED_ROW_SCHEMA)) {
			expect(def.compression).toBe(SHARD_COMPRESSION)
		}
	})
})

describe("writeShards", () => {
	it("PARQUET_COLUMNS lists every emitted column in order", () => {
		const cols: string[] = [...PARQUET_COLUMNS]
		expect(cols).toEqual([
			"raw",
			"tokens",
			"labels",
			"span_starts",
			"span_ends",
			"span_tags",
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

	it("writes per-split .parquet shards readable by ParquetReader, with MANIFEST.json", async () => {
		// Pre-partitioned input shape: callers supply one AsyncIterable per split.
		const trainRows: LabeledRow[] = [
			labeled({ source_id: "t-3", raw: "Marseille" }),
			labeled({ source_id: "t-4", raw: "Nice" }),
		]
		const valRows: LabeledRow[] = [labeled({ source_id: "t-1", raw: "Paris", locale: "fr-FR" })]
		const testRows: LabeledRow[] = [labeled({ source_id: "t-2", raw: "Lyon" })]

		const m = await writeShards(
			{ train: asyncFrom(trainRows), val: asyncFrom(valRows), test: asyncFrom(testRows) },
			{ outputDir: scratch, corpusVersion: "0.1.0", rowsPerShard: 10 }
		)

		expect(m.total_rows).toBe(4)
		expect(m.counts).toEqual({ train: 2, val: 1, test: 1 })
		expect(m.shards).toHaveLength(3)
		expect(m.row_group_size).toBe(ROW_GROUP_SIZE)

		const trainShard = m.shards.find((s) => s.split === "train")!
		expect(trainShard.rows).toBe(2)
		expect(trainShard.format).toBe("parquet")
		expect(trainShard.compression).toBe(SHARD_COMPRESSION)
		expect(trainShard.first_source_id).toBe("t-3")
		expect(trainShard.last_source_id).toBe("t-4")
		expect(trainShard.sha256).toMatch(/^[0-9a-f]{64}$/)
		expect(trainShard.path).toMatch(/\.parquet$/)

		// Round-trip: read the train shard back and confirm row content.
		const trainBack = await readParquet(trainShard.path)
		expect(trainBack).toHaveLength(2)
		expect(trainBack[0]!.raw).toBe("Marseille")
		expect(trainBack[0]!.tokens).toEqual(["Paris"])
		expect(trainBack[0]!.labels).toEqual(["B-locality"])
		// `locale` is optional + absent on train rows — parquetjs may surface as null or undefined.
		expect(trainBack[0]!.locale ?? null).toBeNull()
		expect(trainBack[1]!.raw).toBe("Nice")

		// Round-trip the val shard with an explicit locale set.
		const valShard = m.shards.find((s) => s.split === "val")!
		const valBack = await readParquet(valShard.path)
		expect(valBack[0]!.locale).toBe("fr-FR")

		const manifestOnDisk = JSON.parse(await readFile(join(scratch, "corpus-v0.1.0", "MANIFEST.json"), "utf8"))
		expect(manifestOnDisk.total_rows).toBe(4)
		expect(manifestOnDisk.schema).toEqual([...PARQUET_COLUMNS])
		expect(manifestOnDisk.row_group_size).toBe(ROW_GROUP_SIZE)
	})

	it("round-trips the span triple: row → parquet → read back → spans identical (#519)", async () => {
		const rows: LabeledRow[] = [
			labeled({
				source_id: "t-multi",
				raw: "1600 Pennsylvania Ave NW, Washington, DC 20500",
				tokens: ["1600", "Pennsylvania", "Ave", "NW", "Washington", "DC", "20500"],
				labels: ["B-house_number", "B-street", "I-street", "I-street", "B-locality", "B-region", "B-postcode"],
				span_starts: [0, 5, 26, 38, 41],
				span_ends: [4, 24, 36, 40, 46],
				span_tags: ["house_number", "street", "locality", "region", "postcode"],
			}),
			// Intra-span punctuation — the offsets the token columns structurally cannot carry.
			labeled({
				source_id: "t-pobox",
				raw: "P.O. Box 19",
				tokens: ["P", "O", "Box", "19"],
				labels: ["B-po_box", "I-po_box", "I-po_box", "I-po_box"],
				span_starts: [0],
				span_ends: [11],
				span_tags: ["po_box"],
			}),
			// All-O row: a legitimately EMPTY span triple must survive (not become a missing column).
			labeled({
				source_id: "t-all-o",
				raw: "hello world",
				components: {},
				tokens: ["hello", "world"],
				labels: ["O", "O"],
				span_starts: [],
				span_ends: [],
				span_tags: [],
			}),
		]
		const m = await writeShards({ train: asyncFrom(rows) }, { outputDir: scratch, corpusVersion: "0.5.0" })
		const back = await readParquet(m.shards[0]!.path)
		expect(back).toHaveLength(3)

		const multi = back.find((r) => r.source_id === "t-multi")!
		expect(multi.span_starts).toEqual([0, 5, 26, 38, 41])
		expect(multi.span_ends).toEqual([4, 24, 36, 40, 46])
		expect(multi.span_tags).toEqual(["house_number", "street", "locality", "region", "postcode"])

		const pobox = back.find((r) => r.source_id === "t-pobox")!
		expect(pobox.span_starts).toEqual([0])
		expect(pobox.span_ends).toEqual([11])
		expect(pobox.span_tags).toEqual(["po_box"])

		// parquetjs reads an empty repeated field back as an absent key — normalize to [] and assert
		// the row carries no spurious spans.
		const allO = back.find((r) => r.source_id === "t-all-o")!
		expect(allO.span_starts ?? []).toEqual([])
		expect(allO.span_ends ?? []).toEqual([])
		expect(allO.span_tags ?? []).toEqual([])
	})

	it("refuses to shard rows missing the span triple (the silent-loss hazard, loudly)", async () => {
		const rows = [labeled({ source_id: "t-1", span_starts: undefined, span_ends: undefined, span_tags: undefined })]
		await expect(
			writeShards({ train: asyncFrom(rows) }, { outputDir: scratch, corpusVersion: "0.5.0" })
		).rejects.toThrow(/missing the char-offset span triple/)
	})

	it("rolls to a new shard at rowsPerShard rows", async () => {
		const rows: LabeledRow[] = Array.from({ length: 25 }, (_, i) => labeled({ source_id: `t-${i}`, raw: `row ${i}` }))
		const m = await writeShards(
			{ train: asyncFrom(rows) },
			{ outputDir: scratch, corpusVersion: "0.1.0", rowsPerShard: 10 }
		)

		const trainShards = m.shards.filter((s) => s.split === "train")
		expect(trainShards).toHaveLength(3) // 10 + 10 + 5
		expect(trainShards[0]!.rows).toBe(10)
		expect(trainShards[1]!.rows).toBe(10)
		expect(trainShards[2]!.rows).toBe(5)
		expect(m.total_rows).toBe(25)

		// Confirm each shard is a real readable .parquet
		for (const shard of trainShards) {
			const back = await readParquet(shard.path)
			expect(back.length).toBe(shard.rows)
		}
	})

	it("two runs over the same rows produce a byte-identical parquet file (deterministic sha256)", async () => {
		const rows = [labeled({ source_id: "t-1", raw: "A" }), labeled({ source_id: "t-2", raw: "B" })]
		const a = await writeShards({ train: asyncFrom(rows) }, { outputDir: scratch, corpusVersion: "0.1.0" })
		await rm(join(scratch, "corpus-v0.1.0"), { recursive: true, force: true })
		const b = await writeShards({ train: asyncFrom(rows) }, { outputDir: scratch, corpusVersion: "0.1.0" })
		expect(a.shards[0]!.sha256).toBe(b.shards[0]!.sha256)
	})

	it("rows projected through appendShape omit nulls so optional columns are absent on disk", async () => {
		// One row with locale set, one without. Both should round-trip the relevant value.
		const rows = [
			labeled({ source_id: "t-with", raw: "with locale", locale: "fr-FR" }),
			labeled({ source_id: "t-without", raw: "no locale" }),
		]
		const m = await writeShards({ train: asyncFrom(rows) }, { outputDir: scratch, corpusVersion: "0.1.0" })
		const back = await readParquet(m.shards[0]!.path)
		expect(back).toHaveLength(2)
		const withLocale = back.find((r) => r.source_id === "t-with")!
		const withoutLocale = back.find((r) => r.source_id === "t-without")!
		expect(withLocale.locale).toBe("fr-FR")
		expect(withoutLocale.locale ?? null).toBeNull()
	})

	it("skips splits not present in PerSplitRows (no empty shard files written)", async () => {
		// Only train provided; val + test omitted entirely.
		const m = await writeShards(
			{ train: asyncFrom([labeled({ source_id: "t-1" })]) },
			{ outputDir: scratch, corpusVersion: "0.1.0" }
		)
		expect(m.counts).toEqual({ train: 1, val: 0, test: 0 })
		expect(m.shards).toHaveLength(1)
		expect(m.shards[0]!.split).toBe("train")
	})
})
