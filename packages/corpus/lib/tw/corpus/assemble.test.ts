/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file One seeded Taiwan build over the synthetic fixture the Python parity test wrote, compared with the rows,
 *   board, centroids and report the Python assembler wrote to `fixtures/builders/tw/tw-build-reference.json`.
 */

import { readLocalJSONFile, sortedGlob } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { JSONSpliterator } from "spliterator"
import { describe, expect, it } from "vitest"

import { escapeSQLString, openDuckDB } from "#parquet/duckdb"
import { readParquetRows } from "#parquet/readers"
import { expectSpanInvariants } from "#test-kit"
import { buildTWCorpus } from "#tw/corpus/assemble"
import { iterTWSourceRows, splitNumberUnit } from "#tw/corpus/rows"

const REFERENCE = resolvePackagePath("@mailwoman/corpus", "fixtures", "builders", "tw", "tw-build-reference.json")

interface Reference {
	train: unknown[]
	val: unknown[]
	board: unknown[]
	centroids: Record<string, number[]>
	report: Record<string, unknown>
}

/**
 * Region, district, village, street, number, unit: the shapes the renderers branch on.
 */
const SOURCE_ROWS = [
	["臺北市", "中正區", "黎明里", "重慶南路一段", "122號", "3樓"],
	["臺北市", "中正區", "", "館前路", "8號", ""],
	["臺北市", "大安區", "龍泉里", "新生南路三段", "之2號", "5樓"],
	["新北市", "板橋區", "留侯里", "文化路一段", "266號", ""],
	["新北市", "三重區", "五谷里", "重新路五段", "609號", "12樓"],
	["臺中市", "西屯區", "何厝里", "臺灣大道三段", "301號", ""],
	["臺中市", "北區", "賴明里", "三民路三段", "129號", "2樓"],
	["高雄市", "前金區", "自強里", "中正四路", "211號", ""],
	["高雄市", "苓雅區", "五權里", "四維三路", "6號", "8樓"],
	["臺南市", "中西區", "赤崁里", "民權路二段", "30號", ""],
	["桃園市", "桃園區", "中路里", "復興路", "195號", "4樓"],
	["新竹市", "東區", "光復里", "光復路一段", "89號", ""],
	["新北市", "中和區", "安平里", "中和路", "100號", "6樓"],
	["臺中市", "豐原區", "北陽里", "中正路", "45號", ""],
] as const

const sqlString = (value: string) => `'${escapeSQLString(value)}'`

/**
 * Six copies of the source rows in one row group, with the coordinates `write_fixture` computed.
 */
async function writeFixtureParquet(path: string): Promise<void> {
	const values: string[] = []

	for (let index = 0; index < 6; index++) {
		for (const [region, district, village, street, number, unit] of SOURCE_ROWS) {
			const lon = 120 + index / 100 + district.length / 1000
			const lat = 23 + index / 100 + street.length / 1000

			values.push(
				`([{'value': ${sqlString(region)}}, {'value': ${sqlString(district)}}, {'value': ${sqlString(village)}}], ` +
					`${sqlString(street)}, ${sqlString(number)}, ${sqlString(unit)}, ${lon}, ${lat}, ` +
					"[{'dataset': 'tw-civil-affairs'}])"
			)
		}
	}

	using db = await openDuckDB()

	await db.run(
		"CREATE TABLE source (address_levels STRUCT(value VARCHAR)[], street VARCHAR, number VARCHAR, unit VARCHAR, " +
			"lon DOUBLE, lat DOUBLE, sources STRUCT(dataset VARCHAR)[])"
	)

	await db.run(`INSERT INTO source VALUES ${values.join(", ")}`)
	await db.run(`COPY source TO ${sqlString(path)} (FORMAT parquet, ROW_GROUP_SIZE 1000000)`)
}

async function rendered(directory: string): Promise<unknown[]> {
	const paths = await sortedGlob(directory, "*.parquet")

	const rows: unknown[] = []

	for (const path of paths) {
		rows.push(
			...(await readParquetRows(path, { columns: ["raw", "register", "span_starts", "span_ends", "span_tags"] }))
		)
	}

	return rows
}

describe("the Taiwan corpus assembler", async () => {
	const reference = await readLocalJSONFile<Reference>(REFERENCE)

	it("writes the Python assembler's rows, board, centroids and report from the same fixture and seed", async () => {
		await using scratch = await temporaryDirectory("mailwoman-tw-corpus-")
		const parquet = scratch.path("addresses-tw.parquet").toString()
		const outDir = scratch.path("corpus").toString()

		await writeFixtureParquet(parquet)

		await buildTWCorpus({
			parquet,
			outDir,
			trainRows: 30,
			valRows: 6,
			boardRows: 6,
			boardBucketMin: 90,
			rowsPerPart: 12,
			statsSamplePerPart: 12,
			countryFraction: 0.4,
			maxFieldChars: 64,
			maxRowGroups: 1,
			seed: 42,
			force: true,
		})

		expect(await rendered(`${outDir}/train`)).toEqual(reference.train)
		expect(await rendered(`${outDir}/val`)).toEqual(reference.val)
		expectSpanInvariants([...(await rendered(`${outDir}/train`)), ...(await rendered(`${outDir}/val`))])
		expect(await Array.fromAsync(JSONSpliterator.fromAsync(`${outDir}/tw-board.jsonl`))).toEqual(reference.board)
		expect(await readLocalJSONFile(`${outDir}/tw-district-centroids.json`)).toEqual(reference.centroids)

		const report = await readLocalJSONFile<Record<string, unknown>>(`${outDir}/build-report.json`)

		delete report["parquet"]

		expect(report).toEqual(reference.report)
	})

	it("moves a sub-number from the unit onto the number", () => {
		expect(splitNumberUnit("298", "之1號四樓")).toEqual(["298之1號", "四樓"])
		expect(splitNumberUnit("298號", "之1號")).toEqual(["298號之1號", ""])
		expect(splitNumberUnit("298號", "之1號四樓")).toEqual(["298號", "之1號四樓"])
		expect(splitNumberUnit("298號", "四樓")).toEqual(["298號", "四樓"])
	})

	it("names a missing parquet file", async () => {
		await using scratch = await temporaryDirectory("mailwoman-tw-corpus-")
		const missing = scratch.path("addresses-tw.parquet").toString()

		await expect(iterTWSourceRows(missing).next()).rejects.toThrow(missing)
	})

	it("refuses a row with no longitude rather than placing it at the origin", async () => {
		await using scratch = await temporaryDirectory("mailwoman-tw-corpus-")
		const path = scratch.path("addresses-tw.parquet").toString()

		using db = await openDuckDB()

		await db.run(
			"CREATE TABLE source (address_levels STRUCT(value VARCHAR)[], street VARCHAR, number VARCHAR, unit VARCHAR, " +
				"lon DOUBLE, lat DOUBLE, sources STRUCT(dataset VARCHAR)[])"
		)

		await db.run(
			"INSERT INTO source VALUES ([{'value': '臺北市'}, {'value': '中正區'}, {'value': '黎明里'}], " +
				"'重慶南路一段', '122號', '', NULL, 25.04, [])"
		)

		await db.run(`COPY source TO ${sqlString(path)} (FORMAT parquet)`)

		await expect(iterTWSourceRows(path).next()).rejects.toThrow(/lon is null, not a finite number/u)
	})
})
