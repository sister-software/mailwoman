/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file One seeded Korea build over the fixture the Python parity test wrote (a CP949 주소DB archive and a CP949
 *   permit CSV), compared with the rows, boards, centroids and report the Python assembler wrote to
 *   `fixtures/builders/kr/kr-build-reference.json`. `gdaltransform` is replaced by the Python test's stub.
 */

import { readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalBuffer } from "@mailwoman/core/fs/writers"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { pyRound } from "@mailwoman/core/numeric"
import { compareByCodePoint } from "@mailwoman/core/strings/compare"
import { JSONSpliterator } from "spliterator"
import { Globerator } from "spliterator/node/fs"
import { describe, expect, it } from "vitest"

import { buildKRCorpus } from "#kr/corpus/assemble"
import { readParquetRows } from "#parquet/readers"

const fixture = (name: string) => resolvePackagePath("@mailwoman/corpus", "fixtures", "builders", "kr", name)

interface Reference {
	label: unknown[]
	board: unknown[]
	registry: unknown[]
	registry_board: unknown[]
	centroids: Record<string, number[]>
	report: Record<string, unknown>
}

/**
 * The Python test's stand-in for `gdaltransform`, mapping the fixture's planar grid into Korea.
 */
const stubTransform = (points: ReadonlyArray<readonly [number, number]>) =>
	points.map(
		([x, y]) =>
			[pyRound(124 + ((x % 100_000) / 100_000) * 8, 6), pyRound(33 + ((y % 100_000) / 100_000) * 6.5, 6)] as const
	)

async function rendered(directory: string): Promise<unknown[]> {
	const rows: unknown[] = []

	for (const split of ["train", "val"]) {
		const paths = (await Globerator.from("*.parquet", { cwd: `${directory}/${split}`, absolute: true }).toArray())
			.map(String)
			.toSorted(compareByCodePoint)

		for (const path of paths) {
			const read = await readParquetRows<Record<string, unknown>>(path, {
				columns: ["raw", "register", "span_starts", "span_ends", "span_tags"],
			})

			rows.push(...read.map((row) => ({ split, ...row })))
		}
	}

	return rows
}

describe("the Korea corpus assembler", async () => {
	const reference = await readLocalJSONFile<Reference>(fixture("kr-build-reference.json"))

	it("writes the Python assembler's corpora, boards, centroids and report from the same fixture and seed", async () => {
		await using scratch = await temporaryDirectory("mailwoman-kr-corpus-")
		const jusoZip = scratch.path("202608ALLMTCHG00.zip").toString()
		const permitDir = scratch.path("localdata-kr").toString()
		const outDir = scratch.path("corpus").toString()
		const registryOutDir = scratch.path("registry").toString()

		await writeLocalBuffer(
			Buffer.from((await readLocalTextFile(fixture("juso-fixture.zip.b64"))).trim(), "base64"),
			jusoZip
		)

		await writeLocalBuffer(
			Buffer.from((await readLocalTextFile(fixture("permits-fixture.csv.b64"))).trim(), "base64"),
			`${permitDir}/일반음식점.csv`
		)

		await buildKRCorpus({
			jusoZip,
			permitDir,
			permitGlob: "*.csv",
			outDir,
			registryOutDir,
			trainRows: 6,
			valRows: 2,
			boardRows: 3,
			registryRows: 6,
			registryBoardRows: 3,
			registryValFraction: 0.25,
			rowsPerPart: 4,
			statsSamplePerPart: 8,
			countryFraction: 0.4,
			maxFieldChars: 64,
			boardBucketMin: 90,
			seed: 42,
			force: true,
			transform: stubTransform,
		})

		expect(await rendered(outDir)).toEqual(reference.label)
		expect(await Array.fromAsync(JSONSpliterator.fromAsync(`${outDir}/kr-board.jsonl`))).toEqual(reference.board)
		expect(await rendered(registryOutDir)).toEqual(reference.registry)

		expect(await Array.fromAsync(JSONSpliterator.fromAsync(`${registryOutDir}/kr-registry-board.jsonl`))).toEqual(
			reference.registry_board
		)

		expect(await readLocalJSONFile(`${outDir}/kr-sigungu-centroids.json`)).toEqual(reference.centroids)

		const report = await readLocalJSONFile<Record<string, unknown>>(`${outDir}/build-report.json`)

		delete report["juso_zip"]
		delete report["permit_dir"]

		expect(report).toEqual(reference.report)
	})

	it("names a missing register archive", async () => {
		await using scratch = await temporaryDirectory("mailwoman-kr-corpus-")
		const jusoZip = scratch.path("absent.zip").toString()

		await expect(
			buildKRCorpus({
				jusoZip,
				permitDir: scratch.path().toString(),
				outDir: scratch.path("corpus").toString(),
				registryOutDir: scratch.path("registry").toString(),
				trainRows: 1,
				valRows: 1,
				boardRows: 1,
				registryRows: 1,
				registryBoardRows: 1,
				registryValFraction: 0.5,
				rowsPerPart: 1,
				statsSamplePerPart: 1,
				countryFraction: 0,
				maxFieldChars: 64,
				boardBucketMin: 90,
				seed: 1,
				force: false,
			})
		).rejects.toThrow(jusoZip)
	})
})
