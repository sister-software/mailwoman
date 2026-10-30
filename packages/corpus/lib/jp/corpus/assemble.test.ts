/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file One seeded Japan build over the synthetic fixture the Python parity test wrote, compared with the rows, board
 *   and report the Python assembler wrote to `fixtures/builders/jp/jp-build-reference.json`. Every draw shares one generator, so the
 *   order of the rows is the assertion: one moved draw re-renders the corpus.
 */

import { readLocalJSONFile, sortedGlob } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalBuffer } from "@mailwoman/core/fs/writers"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { JSONSpliterator } from "spliterator"
import { describe, expect, it } from "vitest"

import { buildJPCorpus } from "#jp/corpus/assemble"
import { iterJPSourceRows, loadKenAllPostcodes } from "#jp/corpus/sources"
import { municipalityKanaFromAdminDB } from "#jp/kana"
import { escapeSQLString, openDuckDB } from "#parquet/duckdb"
import { readParquetRows } from "#parquet/readers"
import { expectReportBytes, expectSpanInvariants } from "#test-kit"

const REFERENCE = resolvePackagePath("@mailwoman/corpus", "fixtures", "builders", "jp", "jp-build-reference.json")

type Pinned = Pick<Record<string, unknown>, "raw" | "register" | "span_starts" | "span_ends" | "span_tags">

interface Reference {
	train: Pinned[]
	val: Pinned[]
	board: Pinned[]
	report: Record<string, unknown>
}

/**
 * The fixture's source rows: prefecture, municipality, street, number. 神戸市
 * and 宮崎市 both hash to bucket 98, so they are the held-out board.
 */
const SOURCE_ROWS = [
	["東京都", "八王子市", "八島町二丁目", "3-16"],
	["東京都", "八王子市", "字崎枝", "12-4"],
	["東京都", "町田市", "大字上田", "362B-2"],
	["北海道", "札幌市", "大通東一丁目", "5-7"],
	["北海道", "函館市", "本町", "1-2"],
	["沖縄県", "那覇市", "久茂地三丁目", "1-1"],
	["沖縄県", "石垣市", "字大川", "9"],
	["京都府", "京都市", "烏丸通二丁目", "4-5"],
	["京都府", "宇治市", "宇治", "10-20"],
	["大阪府", "大阪市", "梅田一丁目", "2-3"],
	["大阪府", "堺市", "中区深井", "77"],
	["愛知県", "名古屋市", "栄三丁目", "6-8"],
	["兵庫県", "神戸市", "中央区元町通四丁目", "2-8"],
	["宮崎県", "宮崎市", "橘通東一丁目", "9-3"],
] as const

/**
 * The fixture's KEN_ALL_ROME file in cp932, as `write_fixture` wrote it.
 */
const KENALL_CP932 =
	"IjE5MjAwMDAiLCKTjIuek3MiLCKUqomkjnGOcyIsIojIibqCyYxmjdqCqoLIgqKP6o2HIiwiIiwiIg0KIjE5MjAwNjIiLCKTjIuek3MiLCKUqomkjnGOcyIsIpSqk4eSrCIsIiIsIiINCiIxOTQwMDAwIiwik4yLnpNzIiwikqyTY45zIiwiiMiJuoLJjGaN2oKqgsiCoo/qjYciLCIiLCIiDQoiMTk0MDIxMSIsIpOMi56TcyIsIpKsk2OOcyIsIo/jk2MiLCIiLCIiDQoiMDYwMDAwMCIsIpZrikOTuSIsIo5ElnmOcyIsIojIibqCyYxmjdqCqoLIgqKP6o2HIiwiIiwiIg0KIjA2MDAwNDEiLCKWa4pDk7kiLCKORJZ5jnMiLCKR5ZLKk4yBaYJQgWCCUIJSkpqW2oFqIiwiIiwiIg0KIjA0MDAwMDAiLCKWa4pDk7kiLCKUn4rZjnMiLCKIyIm6gsmMZo3agqqCyIKij+qNhyIsIiIsIiINCiI5MDAwMDAwIiwiiauT6oynIiwik9+UZY5zIiwiiMiJuoLJjGaN2oKqgsiCoo/qjYciLCIiLCIiDQoiOTAwMDAxNSIsIomrk+qMpyIsIpPflGWOcyIsIot2ls6SbiIsIiIsIiINCiI5MDcwMDAwIiwiiauT6oynIiwikM6KX45zIiwiiMiJuoLJjGaN2oKqgsiCoo/qjYciLCIiLCIiDQoiOTA3MDAyMiIsIomrk+qMpyIsIpDOil+OcyIsIpHlkOwiLCIiLCIiDQoiNjA0MDAwMCIsIouek3OVeyIsIouek3OOcyIsIojIibqCyYxmjdqCqoLIgqKP6o2HIiwiIiwiIg0KIjYxMTAwMDAiLCKLnpNzlXsiLCKJRo6hjnMiLCKIyIm6gsmMZo3agqqCyIKij+qNhyIsIiIsIiINCiI1MzAwMDAwIiwikeWN45V7IiwikeWN445zIiwiiMiJuoLJjGaN2oKqgsiCoo/qjYciLCIiLCIiDQoiNTkwMDAwMCIsIpHljeOVeyIsIo3kjnMiLCKIyIm6gsmMZo3agqqCyIKij+qNhyIsIiIsIiINCiI0NjAwMDAwIiwiiKSSbYynIiwilryMw4mujnMiLCKIyIm6gsmMZo3agqqCyIKij+qNhyIsIiIsIiINCiI2NTAwMDAwIiwilbqMyYynIiwikF+My45zIiwiiMiJuoLJjGaN2oKqgsiCoo/qjYciLCIiLCIiDQoiODgwMDAwMCIsIot7jeiMpyIsIot7jeiOcyIsIojIibqCyYxmjdqCqoLIgqKP6o2HIiwiIiwiIg0KIjg4MDA4MDUiLCKLe43ojKciLCKLe43ojnMiLCKLa5LKk4wiLCIiLCIi"

const sqlString = (value: string) => `'${escapeSQLString(value)}'`

/**
 * Eight copies of the source rows, with a third part appended to every third copy's
 * two-part number, in one row group, as `write_fixture` wrote them.
 */
async function writeFixtureParquet(path: string): Promise<void> {
	const values: string[] = []

	for (let index = 0; index < 8; index++) {
		for (const [prefecture, municipality, street, number] of SOURCE_ROWS) {
			const numbered = number.split("-").length === 2 && index % 3 === 0 ? `${number}-${index}` : number

			values.push(
				`([{'value': ${sqlString(prefecture)}}, {'value': ${sqlString(municipality)}}], ${sqlString(street)}, ` +
					`${sqlString(numbered)}, ${139 + index / 100}, ${35 + index / 100})`
			)
		}
	}

	using db = await openDuckDB()

	await db.run(
		"CREATE TABLE source (address_levels STRUCT(value VARCHAR)[], street VARCHAR, number VARCHAR, lon DOUBLE, lat DOUBLE)"
	)

	await db.run(`INSERT INTO source VALUES ${values.join(", ")}`)
	await db.run(`COPY source TO ${sqlString(path)} (FORMAT parquet, ROW_GROUP_SIZE 1000000)`)
}

const pin = (row: Record<string, unknown>): Pinned => ({
	raw: row["raw"],
	register: row["register"],
	span_starts: row["span_starts"],
	span_ends: row["span_ends"],
	span_tags: row["span_tags"],
})

async function rendered(directory: string): Promise<Pinned[]> {
	const paths = await sortedGlob(directory, "*.parquet")

	const rows: Pinned[] = []

	for (const path of paths) {
		rows.push(...(await readParquetRows<Record<string, unknown>>(path)).map(pin))
	}

	return rows
}

describe("the Japan corpus assembler", async () => {
	const reference = await readLocalJSONFile<Reference>(REFERENCE)

	it("writes the Python assembler's rows, board and report from the same fixture and seed", async () => {
		await using scratch = await temporaryDirectory("mailwoman-jp-corpus-")
		const parquet = scratch.path("addresses-jp.parquet").toString()
		const kenall = scratch.path("KEN_ALL_ROME.CSV").toString()
		const outDir = scratch.path("corpus").toString()

		await writeFixtureParquet(parquet)
		await writeLocalBuffer(Buffer.from(KENALL_CP932, "base64"), kenall)

		await buildJPCorpus({
			parquet,
			kenall,
			adminDB: null,
			outDir,
			trainRows: 40,
			valRows: 8,
			boardRows: 8,
			rowsPerPart: 16,
			statsSamplePerPart: 16,
			postcodeFraction: 0.5,
			countryFraction: 0.3,
			spacedFraction: 0.4,
			variantHyphenFraction: 0.25,
			maxFieldChars: 64,
			maxRowGroups: 1,
			upweightPattern: "市$:2",
			seed: 42,
			force: true,
		})

		expect(await rendered(`${outDir}/train`)).toEqual(reference.train)
		expect(await rendered(`${outDir}/val`)).toEqual(reference.val)
		expectSpanInvariants([...(await rendered(`${outDir}/train`)), ...(await rendered(`${outDir}/val`))])

		const board = (
			await Array.fromAsync(JSONSpliterator.fromAsync<Record<string, unknown>>(`${outDir}/jp-board.jsonl`))
		).map(pin)

		expect(board).toEqual(reference.board)

		const report = await readLocalJSONFile<Record<string, unknown>>(`${outDir}/build-report.json`)

		delete report["source_parquet"]
		delete report["kenall"]

		expectReportBytes(report, reference.report)
	})

	it("names each missing input", async () => {
		await using scratch = await temporaryDirectory("mailwoman-jp-corpus-")
		const missing = (name: string) => scratch.path(name).toString()

		await expect(loadKenAllPostcodes(missing("KEN_ALL.CSV"))).rejects.toThrow(missing("KEN_ALL.CSV"))
		await expect(iterJPSourceRows(missing("jp.parquet")).next()).rejects.toThrow(missing("jp.parquet"))
		await expect(municipalityKanaFromAdminDB(missing("admin.db"))).rejects.toThrow(missing("admin.db"))
	})
})
