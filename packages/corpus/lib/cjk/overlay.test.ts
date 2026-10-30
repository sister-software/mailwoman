/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The CJK overlay writes Chinese rows in the CJK schema, lists the JP and extra corpora by volume path,
 *   and seals one vocabulary over all of them in code-point order.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { compareByScalarValue } from "@mailwoman/core/strings/compare"
import { JSONSpliterator } from "spliterator"
import { describe, expect, it } from "vitest"

import { CJK_CORPUS_COLUMNS, readLabelSetTags, saveCharVocab, verifyCJKRecord } from "#cjk/builder"
import { buildCJKOverlay, type CNUnitsRow, mergeCharVocab, toCNRecord } from "#cjk/overlay"
import { readParquetRows } from "#parquet/readers"
import { writeColumnParquetFile } from "#parquet/writers"

const CN_ROW: CNUnitsRow = {
	raw: "赵光三分场二十九队, Inner Mongolia, China",
	tokens: ["赵", "光", "三", "分", "场", "二", "十", "九", "队", "Inner", "Mongolia", "China"],
	labels: [
		"B-dependent_locality",
		"I-dependent_locality",
		"B-locality_unit",
		"I-locality_unit",
		"I-locality_unit",
		"I-locality_unit",
		"I-locality_unit",
		"I-locality_unit",
		"I-locality_unit",
		"B-region",
		"I-region",
		"B-country",
	],
	span_starts: [0, 2, 11, 27],
	span_ends: [2, 9, 25, 32],
	span_tags: ["dependent_locality", "locality_unit", "region", "country"],
	source: "coarse-placer-cn-units",
}

const vocabOf = (characters: string) =>
	new Map([["<pad>", 0], ["<unk>", 1], ...[...characters].map((character, index) => [character, index + 2] as const)])

async function writeCorpus(
	directory: string,
	part: string,
	row: Record<string, unknown>,
	vocabName: string,
	characters: string
) {
	for (const split of ["train", "val"]) {
		await writeColumnParquetFile([row], CJK_CORPUS_COLUMNS, `${directory}/${split}/${part}`)
	}

	await saveCharVocab(vocabOf(characters), `${directory}/${vocabName}`)
}

const JP_ROW = {
	raw: "東京都千代田区丸の内1",
	tokens: ["東京都千代田区丸の内1"],
	labels: ["B-prefecture"],
	span_starts: [0, 3, 7],
	span_ends: [3, 7, 10],
	span_tags: ["prefecture", "municipality", "district"],
	country: "JP",
	source: "overture-jp",
	license: "CC-BY-4.0",
	register: "native",
}

const KR_ROW = {
	raw: "서울특별시 종로구 자하문로 94",
	tokens: ["서울특별시", "종로구", "자하문로", "94"],
	labels: ["B-region", "B-subregion", "B-street", "B-house_number"],
	span_starts: [0, 6, 10, 15],
	span_ends: [5, 9, 14, 17],
	span_tags: ["region", "subregion", "street", "house_number"],
	country: "KR",
	source: "juso-kr",
	license: "KOGL-Type1",
	register: "no_dong",
}

async function writeJSONL(path: string, rows: readonly CNUnitsRow[]) {
	await writeLocalTextFile(
		rows.map((row) => stringifyJSON(row)),
		path
	)

	return path
}

describe("toCNRecord", () => {
	it("takes country CN and register cn-units", () => {
		const record = toCNRecord(CN_ROW)

		expect(record.country).toBe("CN")
		expect(record.register).toBe("cn-units")
		expect(toCNRecord({ ...CN_ROW, source: null }).source).toBe("coarse-placer-cn-units")
	})

	it("passes the CJK record check with an inner space in a Latin region, and refuses a foreign tag", async () => {
		const tags = await readLabelSetTags("stage3-cjk")

		expect(() => verifyCJKRecord(toCNRecord(CN_ROW), tags)).not.toThrow()

		expect(() =>
			verifyCJKRecord(toCNRecord({ ...CN_ROW, span_tags: ["dependent_locality", "farm", "region", "country"] }), tags)
		).toThrow(/outside stage3-cjk/)
	})
})

describe("mergeCharVocab", () => {
	it("keeps every JP character and adds each Chinese character once, in code-point order", () => {
		const vocab = mergeCharVocab({ "<pad>": 0, "<unk>": 1, 丸: 2, 京: 3 }, ["赵光", "光"])

		expect(vocab.get("<pad>")).toBe(0)
		expect(vocab.get("<unk>")).toBe(1)
		expect([...vocab.keys()].slice(2)).toEqual(["丸", "京", "赵", "光"].toSorted(compareByScalarValue))
	})

	it("orders a supplementary-plane character after the fullwidth forms, as Python sorts it", () => {
		const vocab = mergeCharVocab({ "<pad>": 0, "<unk>": 1, "＆": 2 }, ["𨦻"])

		expect([...vocab.keys()].slice(2)).toEqual(["＆", "𨦻"])
	})
})

describe("buildCJKOverlay", () => {
	it("writes the overlay with the JP and extra corpora referenced by volume path", async () => {
		await using scratch = await temporaryDirectory("mailwoman-cjk-overlay-")
		const jp = scratch.path("v8-jp-full-2026-08-04").toString()
		const kr = scratch.path("v8-kr-2026-09-06").toString()
		const outDir = scratch.path("v8-cjk-test").toString()

		await writeCorpus(jp, "part-0000.parquet", JP_ROW, "char-vocab-jp-full.json", "1丸京内区千代田東都の")
		await writeCorpus(kr, "kr-part-0000.parquet", KR_ROW, "char-vocab-kr.json", " 49구로문별서시울자종특하")

		const report = await buildCJKOverlay({
			jpCorpus: jp,
			cnTrain: await writeJSONL(scratch.path("train.jsonl").toString(), [CN_ROW]),
			cnVal: await writeJSONL(scratch.path("val.jsonl").toString(), [CN_ROW]),
			cnTest: await writeJSONL(scratch.path("test.jsonl").toString(), [CN_ROW, CN_ROW]),
			outDir,
			volumeRoot: "/data/corpus/versioned",
			extraCorpora: [{ directory: kr, source: "juso-kr" }],
		})

		const manifest = await readLocalJSONFile<{
			base_corpus_version: string
			label_set: string
			files: { path: string; split: string; source: string }[]
		}>(`${outDir}/MANIFEST.json`)

		expect(manifest.files.map((entry) => entry.path)).toEqual([
			"/data/corpus/versioned/v8-jp-full-2026-08-04/train/part-0000.parquet",
			"/data/corpus/versioned/v8-jp-full-2026-08-04/val/part-0000.parquet",
			"/data/corpus/versioned/v8-cjk-test/train/cn-units-0000.parquet",
			"/data/corpus/versioned/v8-cjk-test/val/cn-units-0000.parquet",
			"/data/corpus/versioned/v8-kr-2026-09-06/train/kr-part-0000.parquet",
			"/data/corpus/versioned/v8-kr-2026-09-06/val/kr-part-0000.parquet",
		])

		expect(manifest.base_corpus_version).toBe("v8-jp-full-2026-08-04")
		expect(manifest.label_set).toBe("stage3-cjk")

		const [cn] = await readParquetRows<{ register: string; country: string; license: string }>(
			`${outDir}/train/cn-units-0000.parquet`
		)

		expect(cn).toMatchObject({ register: "cn-units", country: "CN" })
		expect(cn!.license).toBeTruthy()

		expect(report.get("cn_rows")).toEqual(
			new Map([
				["train", 1],
				["val", 1],
				["board", 2],
			])
		)

		expect((report.get("cn_span_tags") as Map<string, number>).get("locality_unit")).toBe(2)
		expect((report.get("char_vocab") as Map<string, number>).get("juso-kr")).toBe(16)

		// The merged vocabulary adds the Chinese and extra corpora's characters to the JP one, so it is larger.
		expect((report.get("char_vocab") as Map<string, number>).get("cjk")).toBeGreaterThan(
			(report.get("char_vocab") as Map<string, number>).get("jp")!
		)

		expect(await Array.fromAsync(JSONSpliterator.fromAsync(`${outDir}/cn-board.jsonl`))).toHaveLength(2)

		const vocab = await readLocalJSONFile<Record<string, number>>(`${outDir}/char-vocab-cjk.json`)

		expect(vocab).toHaveProperty("서")
		expect(vocab).toHaveProperty("東")
		expect(Object.values(vocab).toSorted((a, b) => a - b)).toEqual([...Object.keys(vocab).keys()])
	})

	it("refuses a missing Chinese input, naming its path", async () => {
		await using scratch = await temporaryDirectory("mailwoman-cjk-overlay-")
		const jp = scratch.path("v8-jp-full-2026-08-04").toString()
		const missing = scratch.path("absent-train.jsonl").toString()

		await writeCorpus(jp, "part-0000.parquet", JP_ROW, "char-vocab-jp-full.json", "東")

		await expect(
			buildCJKOverlay({
				jpCorpus: jp,
				cnTrain: missing,
				cnVal: missing,
				cnTest: missing,
				outDir: scratch.path("out").toString(),
				volumeRoot: "/data",
			})
		).rejects.toThrow(missing)
	})

	it("refuses a JP corpus with no parts, naming it", async () => {
		await using scratch = await temporaryDirectory("mailwoman-cjk-overlay-")
		const jp = scratch.path("empty-jp").toString()

		await expect(
			buildCJKOverlay({
				jpCorpus: jp,
				cnTrain: "a",
				cnVal: "b",
				cnTest: "c",
				outDir: scratch.path("out").toString(),
				volumeRoot: "/data",
			})
		).rejects.toThrow(`${jp} holds no train/val parquet parts`)
	})
})
