/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/* oxlint-disable unicorn/text-encoding-identifier-case -- these assertions mirror ParquetType enum
   members (`"UTF8"`), not text-encoding identifiers. see the note in parquet/schema.ts. */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { removePathIfPresent } from "@mailwoman/core/fs/writers"
import {
	countParquetRows,
	parquetColumnNames,
	readParquetRows,
	tryReadParquetRows,
} from "@mailwoman/corpus/parquet/readers"
import {
	LABELED_ROW_SCHEMA,
	PARQUET_COLUMNS,
	PARQUET_COMPRESSION,
	type ParquetRow,
	ROW_GROUP_SIZE,
	rowToParquet,
} from "@mailwoman/corpus/parquet/schema"
import { openParquetRowStream } from "@mailwoman/corpus/parquet/streams"
import { writeParquetSplits } from "@mailwoman/corpus/parquet/writers"
import { SurfaceOrigin } from "@mailwoman/corpus/types"
import type { LabeledRow } from "@mailwoman/corpus/types"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const labeled = (over: Partial<LabeledRow>): LabeledRow => ({
	raw: "Paris",
	components: { locality: "Paris" },
	country: "FR",
	source: "test",
	source_id: "t-1",
	corpus_version: "0.1.0",
	license: "CC0-1.0",
	register: "whos-on-first",
	surface: SurfaceOrigin.Attested,
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

/**
 * Read every row from a `.parquet` file in on-disk order.
 */
const readParquet = (path: string): Promise<ParquetRow[]> => readParquetRows<ParquetRow>(path)

let scratch: TemporaryDirectory

beforeEach(async () => {
	scratch = await temporaryDirectory("mailwoman-parquet-")
})

afterEach(async () => {
	scratch[Symbol.asyncDispose]()
})

describe("rowToParquet", () => {
	it("flattens synth + locale onto top-level columns", () => {
		const row = labeled({
			locale: "fr-FR",
			recipe: { recipe: "case-upper", base_source_id: "t-1" },
			source_id: "t-1+case-upper",
		})

		const pq = rowToParquet(row)
		expect(pq.locale).toBe("fr-FR")
		expect(pq.recipe).toBe("case-upper")
		expect(pq.base_source_id).toBe("t-1")
		expect(pq.source_id).toBe("t-1+case-upper")
	})

	it("emits null for missing optional fields", () => {
		const pq = rowToParquet(labeled({ locale: undefined, recipe: undefined }))
		expect(pq.locale).toBeNull()
		expect(pq.recipe).toBeNull()
		expect(pq.base_source_id).toBeNull()
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
		expect(Object.keys(LABELED_ROW_SCHEMA).toSorted()).toEqual([...PARQUET_COLUMNS].toSorted())
	})

	it("marks locale / register / recipe / base_source_id optional and surface required", () => {
		expect(LABELED_ROW_SCHEMA.locale!.optional).toBe(true)
		expect(LABELED_ROW_SCHEMA.register!.optional).toBe(true)
		expect(LABELED_ROW_SCHEMA.recipe!.optional).toBe(true)
		expect(LABELED_ROW_SCHEMA.base_source_id!.optional).toBe(true)
		// A null register states that the row names no published record, which is an answer.
		// A null surface would mean nobody said how the text was produced, so every row carries one.
		expect(LABELED_ROW_SCHEMA.surface!.optional).toBeUndefined()
	})

	it("marks tokens / labels REPEATED", () => {
		expect(LABELED_ROW_SCHEMA.tokens!.repeated).toBe(true)
		expect(LABELED_ROW_SCHEMA.labels!.repeated).toBe(true)
	})

	it("marks the span triple REPEATED, offsets as INT32 (#519)", () => {
		expect(LABELED_ROW_SCHEMA.span_starts).toMatchObject({ type: "INT32", repeated: true })
		expect(LABELED_ROW_SCHEMA.span_ends).toMatchObject({ type: "INT32", repeated: true })
		expect(LABELED_ROW_SCHEMA.span_tags).toMatchObject({ type: "UTF8", repeated: true })
	})

	it("uses PARQUET_COMPRESSION on every column", () => {
		for (const def of Object.values(LABELED_ROW_SCHEMA)) {
			expect(def.compression).toBe(PARQUET_COMPRESSION)
		}
	})
})

describe("readers", () => {
	/**
	 * One parquet file with `rows` rows, at a path the caller owns.
	 */
	async function written(rows: readonly LabeledRow[]): Promise<string> {
		const manifest = await writeParquetSplits(
			{ train: asyncFrom(rows) },
			{ outputDir: scratch.path, corpusVersion: "0.1.0" }
		)

		return manifest.slices[0]!.path
	}

	it("readParquetRows returns every row, and honours a projection", async () => {
		const path = await written([labeled({ source_id: "r-1" }), labeled({ source_id: "r-2" })])

		expect(await readParquetRows<ParquetRow>(path)).toHaveLength(2)

		const projected = await readParquetRows<Pick<ParquetRow, "country">>(path, { columns: ["country"] })
		expect(projected.map((row) => row.country)).toEqual(["FR", "FR"])
	})

	it("readParquetRows raises on a file nobody wrote, where tryReadParquetRows answers null", async () => {
		// The whole reason the two names exist.
		// A caller that wants "no corpus yet" to read as an empty list must ASK for that, because
		// `?? []` over the raising one produces the silent zero this package exists to prevent.
		const absent = scratch.resolve("nothing-here.parquet")

		await expect(readParquetRows(absent)).rejects.toThrow(/No parquet file at/)
		expect(await tryReadParquetRows(absent)).toBeNull()
	})

	it("tryReadParquetRows forgives ONLY the missing file — a bad projection still raises", async () => {
		const path = await written([labeled({ source_id: "r-3" })])

		await expect(tryReadParquetRows(path, { columns: ["no_such_column"] })).rejects.toThrow(
			/absent from the file schema: no_such_column/
		)
	})

	it("countParquetRows counts without reading, and raises rather than answering zero for an absent file", async () => {
		// `0` from a file nobody wrote and `0` from a file holding no rows are different
		// statements, and a count is a measurement.
		// So absence raises here rather than returning the number that reads like data.
		expect(await countParquetRows(await written([labeled({ source_id: "r-4" }), labeled({ source_id: "r-5" })]))).toBe(
			2
		)

		await expect(countParquetRows(scratch.resolve("nothing-here.parquet"))).rejects.toThrow(/No parquet file at/)
	})

	it("parquetColumnNames answers the file's own schema, in PARQUET_COLUMNS order", async () => {
		expect(await parquetColumnNames(await written([labeled({ source_id: "r-6" })]))).toEqual([...PARQUET_COLUMNS])
	})
})

describe("writeParquetSplits", () => {
	it("refuses a projection that requests a column absent from the file schema", async () => {
		const m = await writeParquetSplits(
			{ train: asyncFrom([labeled({ source_id: "t-projection" })]) },
			{ outputDir: scratch.path, corpusVersion: "0.1.0" }
		)

		const consume = async () => {
			for await (const _row of openParquetRowStream<ParquetRow & { missing_measurement_column: string }>(
				m.slices[0]!.path,
				{ columns: ["country", "missing_measurement_column"] }
			)) {
			}
		}

		await expect(consume()).rejects.toThrow(/absent from the file schema: missing_measurement_column/)
	})

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
			"register",
			"surface",
			"recipe",
			"base_source_id",
		])
	})

	it("writes per-split .parquet files readable by DuckDB, with MANIFEST.json", async () => {
		// Pre-partitioned input shape: callers supply one AsyncIterable per split.
		const trainRows: LabeledRow[] = [
			labeled({ source_id: "t-3", raw: "Marseille" }),
			labeled({ source_id: "t-4", raw: "Nice" }),
		]

		const valRows: LabeledRow[] = [labeled({ source_id: "t-1", raw: "Paris", locale: "fr-FR" })]
		const testRows: LabeledRow[] = [labeled({ source_id: "t-2", raw: "Lyon" })]

		const m = await writeParquetSplits(
			{ train: asyncFrom(trainRows), val: asyncFrom(valRows), test: asyncFrom(testRows) },
			{ outputDir: scratch.path, corpusVersion: "0.1.0", rowsPerFile: 10 }
		)

		expect(m.total_rows).toBe(4)
		expect(m.counts).toEqual({ train: 2, val: 1, test: 1 })
		expect(m.slices).toHaveLength(3)
		expect(m.row_group_size).toBe(ROW_GROUP_SIZE)

		const trainFile = m.slices.find((s) => s.split === "train")!
		expect(trainFile.rows).toBe(2)
		expect(trainFile.format).toBe("parquet")
		expect(trainFile.compression).toBe(PARQUET_COMPRESSION)
		expect(trainFile.first_source_id).toBe("t-3")
		expect(trainFile.last_source_id).toBe("t-4")
		expect(trainFile.sha256).toMatch(/^[0-9a-f]{64}$/)
		expect(trainFile.path).toMatch(/\.parquet$/)

		// Round-trip: read the train file back and confirm row content.
		const trainBack = await readParquet(trainFile.path)
		expect(trainBack).toHaveLength(2)
		expect(trainBack[0]!.raw).toBe("Marseille")
		expect(trainBack[0]!.tokens).toEqual(["Paris"])
		expect(trainBack[0]!.labels).toEqual(["B-locality"])
		// `locale` is optional and absent on train rows.
		expect(trainBack[0]!.locale ?? null).toBeNull()
		expect(trainBack[1]!.raw).toBe("Nice")

		// Round-trip the val file with an explicit locale set.
		const valFile = m.slices.find((s) => s.split === "val")!
		const valBack = await readParquet(valFile.path)
		expect(valBack[0]!.locale).toBe("fr-FR")

		const manifestOnDisk = await readLocalJSONFile<{ total_rows: number; schema: string[]; row_group_size: number }>(
			scratch.resolve("corpus-v0.1.0", "MANIFEST.json")
		)

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
			// All-O row: a legitimately empty span triple must survive (not become a missing column).
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

		const m = await writeParquetSplits({ train: asyncFrom(rows) }, { outputDir: scratch.path, corpusVersion: "0.5.0" })
		const back = await readParquet(m.slices[0]!.path)
		expect(back).toHaveLength(3)

		const multi = back.find((r) => r.source_id === "t-multi")!
		expect(multi.span_starts).toEqual([0, 5, 26, 38, 41])
		expect(multi.span_ends).toEqual([4, 24, 36, 40, 46])
		expect(multi.span_tags).toEqual(["house_number", "street", "locality", "region", "postcode"])

		const pobox = back.find((r) => r.source_id === "t-pobox")!
		expect(pobox.span_starts).toEqual([0])
		expect(pobox.span_ends).toEqual([11])
		expect(pobox.span_tags).toEqual(["po_box"])

		// Normalize an empty repeated field to [] and assert the row carries no spurious spans.
		const allO = back.find((r) => r.source_id === "t-all-o")!
		expect(allO.span_starts ?? []).toEqual([])
		expect(allO.span_ends ?? []).toEqual([])
		expect(allO.span_tags ?? []).toEqual([])
	})

	it("refuses to write rows missing the span triple (the silent-loss hazard, loudly)", async () => {
		const rows = [labeled({ source_id: "t-1", span_starts: undefined, span_ends: undefined, span_tags: undefined })]

		await expect(
			writeParquetSplits({ train: asyncFrom(rows) }, { outputDir: scratch.path, corpusVersion: "0.5.0" })
		).rejects.toThrow(/missing the char-offset span triple/)
	})

	it("rolls to a new parquet file at rowsPerFile rows", async () => {
		const rows: LabeledRow[] = Array.from({ length: 25 }, (_, i) => labeled({ source_id: `t-${i}`, raw: `row ${i}` }))

		const m = await writeParquetSplits(
			{ train: asyncFrom(rows) },
			{ outputDir: scratch.path, corpusVersion: "0.1.0", rowsPerFile: 10 }
		)

		const trainFiles = m.slices.filter((s) => s.split === "train")
		expect(trainFiles).toHaveLength(3) // 10 + 10 + 5
		expect(trainFiles[0]!.rows).toBe(10)
		expect(trainFiles[1]!.rows).toBe(10)
		expect(trainFiles[2]!.rows).toBe(5)
		expect(m.total_rows).toBe(25)

		// Confirm each file is a real readable .parquet
		for (const file of trainFiles) {
			const back = await readParquet(file.path)
			expect(back).toHaveLength(file.rows)
		}
	})

	it("two runs over the same rows produce a byte-identical parquet file (deterministic sha256)", async () => {
		const rows = [labeled({ source_id: "t-1", raw: "A" }), labeled({ source_id: "t-2", raw: "B" })]
		const a = await writeParquetSplits({ train: asyncFrom(rows) }, { outputDir: scratch.path, corpusVersion: "0.1.0" })
		await removePathIfPresent(scratch.resolve("corpus-v0.1.0"))
		const b = await writeParquetSplits({ train: asyncFrom(rows) }, { outputDir: scratch.path, corpusVersion: "0.1.0" })
		expect(a.slices[0]!.sha256).toBe(b.slices[0]!.sha256)
	})

	it("rows with optional null columns round-trip through Parquet", async () => {
		// One row with locale set, one without.
		// Both should round-trip the relevant value.
		const rows = [
			labeled({ source_id: "t-with", raw: "with locale", locale: "fr-FR" }),
			labeled({ source_id: "t-without", raw: "no locale" }),
		]

		const m = await writeParquetSplits({ train: asyncFrom(rows) }, { outputDir: scratch.path, corpusVersion: "0.1.0" })
		const back = await readParquet(m.slices[0]!.path)
		expect(back).toHaveLength(2)
		const withLocale = back.find((r) => r.source_id === "t-with")!
		const withoutLocale = back.find((r) => r.source_id === "t-without")!
		expect(withLocale.locale).toBe("fr-FR")
		expect(withoutLocale.locale ?? null).toBeNull()
	})

	it("streams projected rows without materializing the file", async () => {
		const rows = Array.from({ length: 5 }, (_, index) => labeled({ source_id: `t-${index}` }))
		const m = await writeParquetSplits({ train: asyncFrom(rows) }, { outputDir: scratch.path, corpusVersion: "0.1.0" })

		const streamed = []

		for await (const row of openParquetRowStream<{ country: string; labels: string[] }>(m.slices[0]!.path, {
			columns: ["country", "labels"],
		})) {
			streamed.push(row)
		}

		expect(streamed).toHaveLength(5)
		expect(streamed[0]).toEqual({ country: "FR", labels: ["B-locality"] })
	})

	it("skips splits not present in PerSplitRows (no empty parquet files written)", async () => {
		// Only train provided.
		// Val + test omitted entirely.
		const m = await writeParquetSplits(
			{ train: asyncFrom([labeled({ source_id: "t-1" })]) },
			{ outputDir: scratch.path, corpusVersion: "0.1.0" }
		)

		expect(m.counts).toEqual({ train: 1, val: 0, test: 0 })
		expect(m.slices).toHaveLength(1)
		expect(m.slices[0]!.split).toBe("train")
	})
})
