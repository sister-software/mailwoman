/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The two passes that turn eligible Overture-TW rows into a corpus.
 *
 *   Pass 1 counts eligible rows per 縣市, sums each district's coordinates and lists the source agencies, without a
 *   draw. Pass 2 selects under the quotas pass 1 set. One {@linkcode PyRandom} feeds the selectors, then the
 *   shuffle, then each row's register and country prefix, in that order, as the Python assembler drew them
 *   (`countries/tw/corpora/assemble.py`). The Taiwanese license voids its grant on a missing attribution, so the
 *   report lists the datasets the rows came from.
 */

import { directoryHasEntries } from "@mailwoman/core/fs/readers"
import { makeDirectories, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { pySum } from "@mailwoman/core/numeric"
import { countInto, mostCommon } from "@mailwoman/core/stats"
import { compareByScalarValue } from "@mailwoman/core/strings/compare"
import { asPythonFloat, pythonJSONDumps } from "@mailwoman/core/strings/python-json"
import { type PathBuilderLike, resolvePath } from "path-ts"

import {
	type CJKRecord,
	coverageStats,
	MAX_FIELD_CHARS,
	muniBucket,
	nextSelection,
	readLabelSetTags,
	sealCharVocab,
	selectExact,
	waterFillQuotas,
	writeCJKCorpusParquet,
} from "#cjk/builder"
import { normalizeCJKText } from "#cjk/text"
import { PyRandom } from "#training/pyrandom"
import {
	availableTWRegisters,
	chooseTWRegister,
	iterTWSourceRows,
	renderTWRow,
	TW_CORPUS_SOURCE,
	TW_LABEL_SET_NAME,
	TW_REGISTER_WEIGHTS,
	type TWSourceRow,
	verifyTWRecord,
} from "#tw/corpus/rows"
import { TW_BOARD_BUCKET_MIN } from "#tw/registers"

/**
 * The source drop rate beyond which the eligibility filter no longer fits the data.
 */
const MAX_DROP_RATE = 0.02

/**
 * The license statement the build report records.
 */
const TW_LICENSE_STATEMENT =
	"CDLA-Permissive-2.0 (Overture) over CC BY 4.0 per civil-affairs bureau; 政府資料開放授權條款 attribution required"

/**
 * Options for {@linkcode buildTWCorpus}, named as the Python assembler's flags.
 */
export interface TWCorpusOptions {
	parquet: PathBuilderLike
	outDir: PathBuilderLike
	trainRows: number
	valRows: number
	boardRows: number
	boardBucketMin: number
	rowsPerPart: number
	statsSamplePerPart: number
	countryFraction: number
	maxFieldChars: number
	maxRowGroups?: number
	seed: number
	force: boolean
}

/**
 * The defaults of the Python assembler's flags.
 */
export const TW_CORPUS_DEFAULTS = {
	trainRows: 2_000_000,
	valRows: 20_000,
	boardRows: 20_000,
	boardBucketMin: TW_BOARD_BUCKET_MIN,
	rowsPerPart: 250_000,
	statsSamplePerPart: 50_000,
	countryFraction: 0.05,
	maxFieldChars: MAX_FIELD_CHARS,
	seed: 42,
} as const

const unitOf = (row: TWSourceRow) => `${row[0]}|${row[1]}`

/**
 * Builds the corpus, its board, the district centroids and the character vocabulary
 * under `outDir`, and returns the build report.
 *
 * @throws When `outDir` holds files and `force` is unset, the parquet is missing,
 * the drop rate exceeds 2%, or a board district reaches train or val.
 */
export async function buildTWCorpus(options: TWCorpusOptions): Promise<Map<string, unknown>> {
	const rng = new PyRandom(options.seed)
	const tagSet = await readLabelSetTags(TW_LABEL_SET_NAME)
	const rowOptions = { maxRowGroups: options.maxRowGroups, maxFieldChars: options.maxFieldChars }

	// Pass 1.
	const poolCounts = new Map<string, number>()
	const dropped = new Map<string, number>()
	const agencies = new Map<string, number>()
	const centroidSums = new Map<string, [number, number, number]>()
	let boardCount = 0
	let scanned = 0

	for await (const row of iterTWSourceRows(options.parquet, { ...rowOptions, dropped, agencies })) {
		scanned++

		const key = normalizeCJKText(unitOf(row))
		const sums = centroidSums.get(key) ?? [0, 0, 0]

		sums[0] += row[6]
		sums[1] += row[7]
		sums[2] += 1
		centroidSums.set(key, sums)

		if (muniBucket(unitOf(row)) >= options.boardBucketMin) {
			boardCount++
		} else {
			countInto(poolCounts, row[0])
		}
	}

	console.log(
		`pass 1: ${scanned.toLocaleString("en-US")} eligible rows · ${poolCounts.size} regions · board pool ${boardCount.toLocaleString("en-US")}`
	)

	const droppedTotal = pySum(dropped.values())
	const dropRate = droppedTotal / Math.max(scanned + droppedTotal, 1)

	if (dropRate > MAX_DROP_RATE) {
		throw new Error(
			`source drop rate ${dropRate.toFixed(4)} exceeds 2% — the eligibility filter no longer fits the data`
		)
	}

	const target = options.trainRows + options.valRows
	const { cap, quotas } = waterFillQuotas(poolCounts, target)

	// Pass 2.
	const selectors = new Map(
		[...poolCounts].map(([region, count]) => [region, selectExact(count, quotas.get(region)!, rng)])
	)

	const boardSelector = selectExact(boardCount, options.boardRows, rng)
	const selected: TWSourceRow[] = []
	const board: TWSourceRow[] = []

	for await (const row of iterTWSourceRows(options.parquet, rowOptions)) {
		if (muniBucket(unitOf(row)) >= options.boardBucketMin) {
			if (nextSelection(boardSelector)) {
				board.push(row)
			}
		} else if (nextSelection(selectors.get(row[0])!)) {
			selected.push(row)
		}
	}

	rng.shuffle(selected)

	const train = selected.slice(0, options.trainRows)
	const val = selected.slice(options.trainRows, options.trainRows + options.valRows)
	const registerCounts = new Map<string, number>()

	const encode = (row: TWSourceRow): CJKRecord => {
		const [region, district, village, street, houseNumber, unit] = row
		const register = chooseTWRegister(rng, availableTWRegisters(village, unit))

		countInto(registerCounts, register)

		const country = rng.random() < options.countryFraction
		const record = renderTWRow({ region, district, village, street, houseNumber, unit, register, country })

		verifyTWRecord(record, tagSet)

		return record
	}

	const outDir = resolvePath(options.outDir)

	if ((await directoryHasEntries(outDir)) && !options.force) {
		throw new Error(
			`${outDir.toString()} exists and is non-empty — pass --force to overwrite (a built corpus is a read-only artifact)`
		)
	}

	const splits = new Map<string, unknown>()

	for (const [split, sourceRows] of [
		["train", train],
		["val", val],
	] as const) {
		await makeDirectories(resolvePath(outDir, split))

		const statsInput: CJKRecord[] = []
		let part = 0
		let written = 0

		for (let start = 0; start < sourceRows.length; start += options.rowsPerPart) {
			const chunk = sourceRows.slice(start, start + options.rowsPerPart).map(encode)
			const name = `tw-part-${String(part).padStart(4, "0")}.parquet`

			await writeCJKCorpusParquet(chunk, resolvePath(outDir, split, name), "TW corpus assembly")

			part++
			written += chunk.length
			statsInput.push(...chunk.slice(0, options.statsSamplePerPart))
		}

		splits.set(split, { rows: written, parts: part, coverage: coverageStats(statsInput) })

		console.log(`${split}: ${written.toLocaleString("en-US")} rows in ${part} parts`)
	}

	const boardRecords: CJKRecord[] = []
	const boardLines: string[] = []

	for (const row of board) {
		const [region, district, village, street, houseNumber, unit, lon, lat] = row
		const record = encode(row)

		boardRecords.push(record)

		boardLines.push(
			pythonJSONDumps(
				{
					raw: record.raw,
					span_starts: record.span_starts,
					span_ends: record.span_ends,
					span_tags: record.span_tags,
					register: record.register,
					region,
					city: district,
					district: village,
					street,
					number: houseNumber,
					unit,
					lon: asPythonFloat(lon),
					lat: asPythonFloat(lat),
				},
				{ ensureASCII: false }
			)
		)
	}

	await writeLocalTextFile(boardLines, resolvePath(outDir, "tw-board.jsonl"))

	const poolUnits = new Set([...train, ...val].map((row) => normalizeCJKText(unitOf(row))))
	const boardUnits = new Set(board.map((row) => normalizeCJKText(unitOf(row))))
	const overlap = [...boardUnits].filter((unit) => poolUnits.has(unit)).toSorted(compareByScalarValue)

	if (overlap.length) throw new Error(`board 鄉鎮市區 leak into train/val: ${overlap.slice(0, 5).join(", ")}`)

	const centroids = new Map(
		[...centroidSums]
			.filter(([, sums]) => sums[2])
			.map(([key, [lon, lat, n]]) => [key, [asPythonFloat(lon / n), asPythonFloat(lat / n)]])
	)

	await writeLocalTextFile(
		pythonJSONDumps(centroids, { ensureASCII: false }) + "\n",
		resolvePath(outDir, "tw-district-centroids.json")
	)

	const vocab = await sealCharVocab(outDir, "char-vocab-tw.json")

	const report = new Map<string, unknown>([
		["seed", options.seed],
		["parquet", options.parquet.toString()],
		["label_set", TW_LABEL_SET_NAME],
		["source", TW_CORPUS_SOURCE],
		["license", TW_LICENSE_STATEMENT],
		["attribution", new Map(mostCommon(agencies))],
		["eligible_rows_scanned", scanned],
		["dropped_at_source", new Map(mostCommon(dropped))],
		["per_region_cap", cap],
		["regions_train", new Set(train.map((row) => row[0])).size],
		["board_bucket_min", options.boardBucketMin],
		["board_districts", boardUnits.size],
		["board_rows", boardRecords.length],
		["registers", new Map(mostCommon(registerCounts))],
		["char_vocab_size", vocab.size],
		["centroid_units", centroids.size],
		["fractions", new Map([["country", asPythonFloat(options.countryFraction)]])],
		["register_weights", new Map([...TW_REGISTER_WEIGHTS].map(([name, weight]) => [name, asPythonFloat(weight)]))],
		["splits", splits],
		["board_coverage", coverageStats(boardRecords)],
	])

	await writeLocalTextFile(
		pythonJSONDumps(report, { indent: 2, ensureASCII: false }) + "\n",
		resolvePath(outDir, "build-report.json")
	)

	return report
}
