/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file One seeded JP probe build over the fixture the Python parity test wrote, compared with the rows, board,
 *   report and vocabulary the Python builder wrote to `fixtures/builders/jp/jp-probe-reference.json`.
 *
 *   The fixture is rebuilt here: all 47 prefectures in code-point order, each with three pool municipalities and
 *   one board municipality found by bucket, five rows per pool municipality, and a cp932 KEN_ALL listing each.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalBuffer } from "@mailwoman/core/fs/writers"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { compareByScalarValue } from "@mailwoman/core/strings/compare"
import { JSONSpliterator } from "spliterator"
import { describe, expect, it } from "vitest"

import { muniBucket } from "#cjk/builder"
import { decodeCP932 } from "#cjk/text"
import { buildJPProbeCorpus, checkStratification, renderProbeRow } from "#jp/corpus/probe"
import { JP_BOARD_BUCKET_MIN } from "#jp/registers"
import { JP_PREFECTURE_NAMES } from "#jp/text"
import { escapeSQLString, openDuckDB } from "#parquet/duckdb"
import { readParquetRows } from "#parquet/readers"

const REFERENCE = resolvePackagePath("@mailwoman/corpus", "fixtures", "builders", "jp", "jp-probe-reference.json")

interface Reference {
	train: unknown[]
	val: unknown[]
	board: unknown[]
	report: Record<string, unknown>
	vocab: Record<string, number>
}

const ROWS_PER_POOL_MUNI = 5

const sqlString = (value: string) => `'${escapeSQLString(value)}'`

/**
 * Three pool municipalities and one board municipality for a prefecture, searched by bucket.
 */
function municipalityNames(prefecture: string): { pool: string[]; board: string } {
	const pool: string[] = []
	let board: string | null = null

	for (let index = 0; pool.length < 3 || !board; index++) {
		const name = `${prefecture[0]}${index}市`

		if (muniBucket(name) >= JP_BOARD_BUCKET_MIN) {
			board ??= name
		} else if (pool.length < 3) {
			pool.push(name)
		}
	}

	return { pool, board }
}

/**
 * Encodes text as cp932 from the decoder's own two-byte table, plus ASCII.
 */
function encodeCP932(text: string): Uint8Array {
	const table = new Map<string, readonly [number, number]>()

	for (let lead = 0x81; lead <= 0xfc; lead++) {
		for (let trail = 0x40; trail <= 0xfc; trail++) {
			const character = decodeCP932(new Uint8Array([lead, trail]))

			if ([...character].length === 1 && !table.has(character)) {
				table.set(character, [lead, trail])
			}
		}
	}

	return new Uint8Array(
		[...text].flatMap((character) => {
			const code = character.codePointAt(0)!

			if (code < 0x80) return [code]

			const pair = table.get(character)

			if (!pair) throw new Error(`no cp932 encoding for ${character}`)

			return [...pair]
		})
	)
}

async function writeFixture(parquet: string, kenAll: string): Promise<void> {
	const values: string[] = []
	const lines: string[] = []

	for (const [order, prefecture] of [...JP_PREFECTURE_NAMES].toSorted(compareByScalarValue).entries()) {
		const { pool, board } = municipalityNames(prefecture)

		for (const [muniIndex, muni] of [...pool, board].entries()) {
			const code = `${String(order + 1).padStart(3, "0")}${String(muniIndex).padStart(4, "0")}`

			lines.push([code, prefecture, muni, "", "", ""].map((cell) => `"${cell}"`).join(","))

			for (let repeat = 0; repeat < (muni === board ? 1 : ROWS_PER_POOL_MUNI); repeat++) {
				values.push(
					`([{'value': ${sqlString(prefecture)}}, {'value': ${sqlString(muni)}}], ` +
						`${sqlString(`${muniIndex + 1}丁目`)}, ${sqlString(`${repeat + 1}-${muniIndex + 1}`)}, ` +
						`'${135 + order / 100}'::DOUBLE, '${35 + repeat / 100}'::DOUBLE)`
				)
			}
		}
	}

	using db = await openDuckDB()

	await db.run(
		"CREATE TABLE source (address_levels STRUCT(value VARCHAR)[], street VARCHAR, number VARCHAR, lon DOUBLE, lat DOUBLE)"
	)

	await db.run(`INSERT INTO source VALUES ${values.join(", ")}`)
	await db.run(`COPY source TO ${sqlString(parquet)} (FORMAT parquet)`)
	await writeLocalBuffer(encodeCP932(lines.map((line) => `${line}\r\n`).join("")), kenAll)
}

describe("the JP probe corpus", async () => {
	const reference = await readLocalJSONFile<Reference>(REFERENCE)

	it("writes the Python builder's rows, board, report and vocabulary from the same fixture and seed", async () => {
		await using scratch = await temporaryDirectory("mailwoman-jp-probe-")
		const parquet = scratch.path("addresses-jp.parquet").toString()
		const kenAll = scratch.path("KEN_ALL_ROME.CSV").toString()
		const outDir = scratch.path("out").toString()

		await writeFixture(parquet, kenAll)

		const report = await buildJPProbeCorpus({
			parquet,
			kenAll,
			outDir,
			trainRows: 470,
			valRows: 47,
			boardRows: 20,
			postcodeFraction: 0.3,
			seed: 42,
		})

		for (const split of ["train", "val"] as const) {
			expect(
				await readParquetRows(`${outDir}/${split}/part-0000.parquet`, {
					columns: ["raw", "span_tags", "span_starts"],
				}),
				split
			).toEqual(reference[split])
		}

		expect(await Array.fromAsync(JSONSpliterator.fromAsync(`${outDir}/jp-probe-board.jsonl`))).toEqual(reference.board)

		const written = await readLocalJSONFile<Record<string, unknown>>(`${outDir}/build-report.json`)

		delete written["source_parquet"]
		expect(written).toEqual(reference.report)
		expect(report.get("source_parquet")).toBe(parquet)
		expect(await readLocalJSONFile(`${outDir}/char-vocab-jp-v1.json`)).toEqual(reference.vocab)
	})

	it("refuses a missing parquet file, naming its path", async () => {
		await using scratch = await temporaryDirectory("mailwoman-jp-probe-")
		const parquet = scratch.path("absent.parquet").toString()
		const kenAll = scratch.path("KEN_ALL_ROME.CSV").toString()

		await writeLocalBuffer(encodeCP932('"0010000","北海道","札幌市","","",""\r\n'), kenAll)

		await expect(
			buildJPProbeCorpus({
				parquet,
				kenAll,
				outDir: scratch.path("out").toString(),
				trainRows: 1,
				valRows: 0,
				boardRows: 0,
				postcodeFraction: 0,
				seed: 1,
			})
		).rejects.toThrow(parquet)
	})

	it("refuses a missing KEN_ALL file, naming its path", async () => {
		await using scratch = await temporaryDirectory("mailwoman-jp-probe-")
		const kenAll = scratch.path("absent.CSV").toString()

		await expect(
			buildJPProbeCorpus({
				parquet: "x",
				kenAll,
				outDir: scratch.path("out").toString(),
				trainRows: 1,
				valRows: 0,
				boardRows: 0,
				postcodeFraction: 0,
				seed: 1,
			})
		).rejects.toThrow(kenAll)
	})
})

describe("renderProbeRow", () => {
	it("keeps the 〒 mark and the following space outside the postcode span", () => {
		const row = renderProbeRow("東京都", "千代田区", "丸の内", "1-1", "1000005")

		expect(row.raw).toBe("〒100-0005 東京都千代田区丸の内1-1")
		expect(row.span_starts).toEqual([1, 10, 13, 17, 20])
		expect(row.tokens).toEqual(["〒100-0005", "東京都千代田区丸の内1-1"])
		// A token is labeled by its first character, and 〒 is outside every span.
		expect(row.labels).toEqual(["O", "B-region"])
	})
})

describe("checkStratification", () => {
	it("refuses a board municipality that also appears in train", () => {
		const row = { pref: "", muni: "札幌市", street: null, number: null, lon: null, lat: null }
		const train = [...JP_PREFECTURE_NAMES].map((pref) => ({ ...row, pref }))

		expect(() => checkStratification(train, [], [row])).toThrow("board municipalities leak into train/val: ['札幌市']")
		expect(() => checkStratification(train.slice(1), [], [])).toThrow("train covers 46 prefectures")
	})
})
