/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Builds the Korean label corpus from the road-name address register and the Korean registry corpus from
 *   the permit registry: four passes, two corpora, one shared generator.
 *
 *   Pass 1 counts eligible register rows per 시도 and builds the key index. Pass 2 measures permit alignment and
 *   averages each 시군구's permit points into a centroid. Pass 3 selects register rows and pass 4 aligned permit
 *   rows, both drawing from one {@linkcode SeededRandom} in the Python assembler's order
 *   (`countries/kr/corpora/assemble.py`), so hoisting one draw above another re-renders both corpora.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { directoryHasEntries } from "@mailwoman/core/fs/readers"
import { isDirectory, pathExists } from "@mailwoman/core/fs/readers/stat"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { orderedJSON } from "@mailwoman/core/json"
import { pySum } from "@mailwoman/core/numeric"
import { runFileSync } from "@mailwoman/core/process"
import { SeededRandom } from "@mailwoman/core/random"
import { countInto, mostCommon } from "@mailwoman/core/stats"
import { compareByScalarValue } from "@mailwoman/core/strings/compare"
import { splitLines, splitWhitespace } from "@mailwoman/core/strings/unicode"
import { type PathBuilderLike, resolvePath } from "path-ts"

import {
	type CJKRecord,
	type CJKSplitReport,
	CJKStatsSample,
	type CoverageStats,
	coverageStats,
	MAX_FIELD_CHARS,
	muniBucket,
	nextSelection,
	readLabelSetTags,
	sealCharVocab,
	selectExact,
	verifyCJKRecord,
	waterFillQuotas,
	writeCJKSplit,
} from "#cjk/builder"
import { type JusoLabelRow, parenthetical, readJusoLabelRows } from "#kr/adapters/juso/label-rows"
import { aliasKeyIndex, emptyKeyIndex, indexLabelRow, type KeyIndex } from "#kr/adapters/localdata/key-index"
import { type PermitRow, readPermitDirectory } from "#kr/adapters/localdata/permit-rows"
import {
	availableKRRegisters,
	chooseKRRegister,
	chooseShortRegion,
	KR_CORPUS_SOURCE,
	KR_LABEL_SET_NAME,
	KR_REGISTER_WEIGHTS,
	KR_REGISTRY_SOURCE,
	krHoldoutKey,
	krIneligibility,
	krPermitAlignment,
	krRegistryRecord,
	renderKRRow,
} from "#kr/corpus/rows"

/**
 * The hold-out bucket from which a 시군구 is a board unit: buckets 90 to 99 of 100.
 */
export const KR_BOARD_BUCKET_MIN = 90

/**
 * The monthly 주소DB edition the corpus reads.
 */
export function jusoZipPath() {
	return dataRootPath("corpus", "sources", "juso-kr", "202608ALLMTCHG00.zip")
}

/**
 * The directory of permit-registry CSVs.
 */
export function permitDirectoryPath() {
	return dataRootPath("corpus", "sources", "localdata-kr")
}

/**
 * The permit points projected in one `gdaltransform` process.
 */
const PROJECTION_BATCH = 200_000

const MAX_DROP_RATE = 0.02

/**
 * The bounds a projected permit point must fall in to count as Korean.
 */
const KOREA_BOUNDS = { lonMin: 124, lonMax: 132, latMin: 33, latMax: 39.5 } as const

/**
 * Planar EPSG:5174 points projected to EPSG:4326 by `gdaltransform`, each `null`
 * when it falls outside Korea.
 *
 * @throws When `gdaltransform` answers a different number of lines than it was given points.
 */
export function transformKRCoordinates(
	points: ReadonlyArray<readonly [number, number]>
): Array<readonly [number, number] | null> {
	if (!points.length) return []

	const stdout = runFileSync("gdaltransform", ["-s_srs", "EPSG:5174", "-t_srs", "EPSG:4326", "-output_xy"], {
		input: points.map(([x, y]) => `${x} ${y}`).join("\n") + "\n",
		maxBuffer: 1 << 30,
	})

	const out = splitLines(String(stdout)).map((line) => {
		const parts = splitWhitespace(line)

		if (parts.length < 2) return null

		const lon = Number(parts[0])
		const lat = Number(parts[1])

		const inside =
			lon >= KOREA_BOUNDS.lonMin &&
			lon <= KOREA_BOUNDS.lonMax &&
			lat >= KOREA_BOUNDS.latMin &&
			lat <= KOREA_BOUNDS.latMax

		return inside ? ([lon, lat] as const) : null
	})

	if (out.length !== points.length) {
		throw new Error(`gdaltransform answered ${out.length} lines for ${points.length} points`)
	}

	return out
}

/**
 * Options for {@linkcode buildKRCorpus}, named as the Python assembler's flags.
 */
export interface KRCorpusOptions {
	jusoZip: PathBuilderLike
	permitDir: PathBuilderLike
	outDir: PathBuilderLike
	registryOutDir: PathBuilderLike
	trainRows: number
	valRows: number
	boardRows: number
	registryRows: number
	registryValFraction: number
	registryBoardRows: number
	boardBucketMin: number
	rowsPerPart: number
	statsSamplePerPart: number
	countryFraction: number
	maxFieldChars: number
	maxRowsPerRegion?: number
	/**
	 * The permit category files to read.
	 *
	 * @defaultValue `*.csv`
	 */
	permitGlob?: string
	seed: number
	force: boolean
	/**
	 * Projects permit points.
	 *
	 * Tests pass a stub, because `gdaltransform` is a host binary.
	 *
	 * @defaultValue {@linkcode transformKRCoordinates}
	 */
	transform?: typeof transformKRCoordinates
}

/**
 * The defaults of the Python assembler's flags.
 */
export const KR_CORPUS_DEFAULTS = {
	trainRows: 2_000_000,
	valRows: 20_000,
	boardRows: 20_000,
	registryRows: 600_000,
	registryValFraction: 0.02,
	registryBoardRows: 20_000,
	boardBucketMin: KR_BOARD_BUCKET_MIN,
	rowsPerPart: 250_000,
	statsSamplePerPart: 50_000,
	countryFraction: 0.05,
	maxFieldChars: MAX_FIELD_CHARS,
	seed: 42,
} as const

/**
 * Pass 1: counts eligible register rows per 시도 and builds the key index, without a draw.
 *
 * @throws When the register drop rate exceeds 2%.
 */
async function surveyRegister(options: KRCorpusOptions, labelRows: () => AsyncIterable<JusoLabelRow>) {
	const index: KeyIndex = emptyKeyIndex()
	const poolCounts = new Map<string, number>()
	const dropped = new Map<string, number>()
	let boardCount = 0
	let scanned = 0

	for await (const row of labelRows()) {
		const reason = krIneligibility(row, options.maxFieldChars)

		if (reason) {
			countInto(dropped, reason)

			continue
		}

		scanned++
		indexLabelRow(index, row)

		if (muniBucket(krHoldoutKey(row.region, row.sigungu)) >= options.boardBucketMin) {
			boardCount++
		} else {
			countInto(poolCounts, row.region)
		}
	}

	aliasKeyIndex(index)

	const droppedTotal = pySum(dropped.values())
	const dropRate = droppedTotal / Math.max(scanned + droppedTotal, 1)

	if (dropRate > MAX_DROP_RATE) {
		throw new Error(
			`register drop rate ${dropRate.toFixed(4)} exceeds 2% — the eligibility filter no longer fits the data`
		)
	}

	console.log(`pass 1: ${scanned.toLocaleString("en-US")} eligible register rows · ${poolCounts.size} regions`)

	return { index, poolCounts, dropped, boardCount, scanned }
}

/**
 * Pass 2: measures permit alignment per form and category and averages each
 * 시군구's permit points, without a draw.
 */
async function surveyPermits(
	options: KRCorpusOptions,
	permitRows: () => AsyncIterable<PermitRow>,
	index: KeyIndex,
	transform: typeof transformKRCoordinates
) {
	const censusForm = new Map<string, number>()
	const censusCategory = new Map<string, Map<string, number>>()
	const centroidSums = new Map<string, [number, number, number]>()
	const points: Array<readonly [number, number]> = []
	const units: string[] = []
	let registryPool = 0
	let registryBoardPool = 0
	let unalignedPool = 0

	const flushPoints = () => {
		for (const [position, point] of transform(points).entries()) {
			if (!point) continue

			const key = units[position]!
			const sums = centroidSums.get(key) ?? [0, 0, 0]

			sums[0] += point[0]
			sums[1] += point[1]
			sums[2] += 1
			centroidSums.set(key, sums)
		}

		points.length = 0
		units.length = 0
	}

	for await (const permit of permitRows()) {
		const bucket = censusCategory.get(permit.category) ?? new Map<string, number>()

		censusCategory.set(permit.category, bucket)

		const aligned = krPermitAlignment(permit, index)
		const registers = new Set(aligned.map((item) => item.register))

		for (const [form, text] of [
			["road", permit.roadAddress],
			["lot", permit.lotAddress],
		] as const) {
			const key = !text ? "empty" : registers.has(`registry_${form}`) ? "aligned" : "unaligned"

			countInto(censusForm, `${form}_${key}`)
			countInto(bucket, `${form}_${key}`)
		}

		if (aligned.length) {
			const unit = krHoldoutKey(aligned[0]!.region, aligned[0]!.sigungu)

			if (permit.x !== null && permit.y !== null) {
				points.push([permit.x, permit.y])
				units.push(unit)

				if (points.length >= PROJECTION_BATCH) {
					flushPoints()
				}
			}

			if (muniBucket(unit) >= options.boardBucketMin) {
				registryBoardPool += aligned.length
			} else {
				registryPool += aligned.length
			}
		} else if (permit.roadAddress || permit.lotAddress) {
			unalignedPool++
		}
	}

	flushPoints()

	const centroids = new Map(
		[...centroidSums].filter(([, sums]) => sums[2]).map(([key, [lon, lat, n]]) => [key, [lon / n, lat / n] as const])
	)

	return { censusForm, censusCategory, centroids, registryPool, registryBoardPool, unalignedPool }
}

/**
 * The KR registry corpus's build report, which its `build-report.json` serializes in this key order.
 */
export interface KRRegistryReport {
	alignment_census: {
		per_form: ReadonlyMap<string, number>
		per_category: ReadonlyMap<string, ReadonlyMap<string, number>>
	}
	pool: { aligned: number; held_out: number; unaligned: number }
	registers: ReadonlyMap<string, number>
	splits: ReadonlyMap<string, CJKSplitReport>
	board_rows: number
	char_vocab_size: number
}

/**
 * The KR label corpus's build report, which `build-report.json` serializes in this key order.
 */
export interface KRCorpusReport {
	seed: number
	juso_zip: string
	permit_dir: string
	label_set: string
	source: string
	registry_source: string
	eligible_rows_scanned: number
	dropped_at_source: ReadonlyMap<string, number>
	per_region_cap: number
	regions_train: number
	board_bucket_min: number
	board_sigungu: number
	board_rows: number
	board_rows_without_centroid: number
	registers: ReadonlyMap<string, number>
	char_vocab_size: number
	centroid_units: number
	fractions: { country: number }
	register_weights: ReadonlyMap<string, number>
	splits: ReadonlyMap<string, CJKSplitReport>
	board_coverage: CoverageStats
	registry: KRRegistryReport
}

/**
 * Builds both corpora and returns the label corpus's build report,
 * which holds the registry's under `registry`.
 *
 * @throws When an output directory holds files and `force` is unset, an input is missing,
 * the register drop rate exceeds 2%, or a board 시군구 reaches train or val.
 */
export async function buildKRCorpus(options: KRCorpusOptions): Promise<KRCorpusReport> {
	const rng = new SeededRandom(options.seed)
	const tagSet = await readLabelSetTags(KR_LABEL_SET_NAME)
	const transform = options.transform ?? transformKRCoordinates
	const outDir = resolvePath(options.outDir)
	const registryDir = resolvePath(options.registryOutDir)

	for (const directory of [outDir, registryDir]) {
		if ((await directoryHasEntries(directory)) && !options.force) {
			throw new Error(
				`${directory.toString()} exists and is non-empty — pass --force to overwrite (a built corpus is a read-only artifact)`
			)
		}
	}

	if (!(await pathExists(options.jusoZip))) throw new Error(`No 주소DB zip at ${options.jusoZip.toString()}`)

	if (!(await isDirectory(options.permitDir))) {
		throw new Error(`No permit-registry directory at ${options.permitDir.toString()}`)
	}

	const labelRows = () => readJusoLabelRows(options.jusoZip, { maxRowsPerRegion: options.maxRowsPerRegion })
	const permitRows = () => readPermitDirectory(options.permitDir, { pattern: options.permitGlob })

	const { index, poolCounts, dropped, boardCount, scanned } = await surveyRegister(options, labelRows)
	const { cap, quotas } = waterFillQuotas(poolCounts, options.trainRows + options.valRows)
	const permits = await surveyPermits(options, permitRows, index, transform)
	const { centroids, registryPool, registryBoardPool, unalignedPool } = permits

	// Pass 3: the register selection.
	const selectors = new Map(
		[...poolCounts].map(([region, count]) => [region, selectExact(count, quotas.get(region)!, rng)])
	)

	const boardSelector = selectExact(boardCount, options.boardRows, rng)
	const selected: JusoLabelRow[] = []
	const board: JusoLabelRow[] = []

	for await (const row of labelRows()) {
		if (krIneligibility(row, options.maxFieldChars)) continue

		if (muniBucket(krHoldoutKey(row.region, row.sigungu)) >= options.boardBucketMin) {
			if (nextSelection(boardSelector)) {
				board.push(row)
			}
		} else if (nextSelection(selectors.get(row.region)!)) {
			selected.push(row)
		}
	}

	rng.shuffle(selected)

	const train = selected.slice(0, options.trainRows)
	const val = selected.slice(options.trainRows, options.trainRows + options.valRows)
	const registerCounts = new Map<string, number>()

	const encode = (row: JusoLabelRow): CJKRecord => {
		const register = chooseKRRegister(rng, availableKRRegisters(row))

		countInto(registerCounts, register)

		const country = rng.random() < options.countryFraction
		const shortRegion = chooseShortRegion(rng, row.region)
		const record = renderKRRow(row, { register, country, shortRegion })

		verifyCJKRecord(record, tagSet)

		return record
	}

	const splits = new Map<string, CJKSplitReport>()

	for (const [split, sourceRows] of [
		["train", train],
		["val", val],
	] as const) {
		splits.set(
			split,
			await writeCJKSplit({
				directory: resolvePath(outDir, split),
				rows: sourceRows,
				rowsPerPart: options.rowsPerPart,
				encodePart: (rows) => rows.map(encode),
				partPrefix: "kr-part",
				context: "KR corpus assembly",
				statsSample: { kind: CJKStatsSample.FirstOfEachPart, rows: options.statsSamplePerPart },
			})
		)
	}

	const boardRecords: CJKRecord[] = []
	const boardLines: string[] = []
	let withoutCentroid = 0

	for (const row of board) {
		const record = encode(row)
		const centroid = centroids.get(krHoldoutKey(row.region, row.sigungu))

		if (!centroid) {
			withoutCentroid++

			continue
		}

		boardRecords.push(record)

		boardLines.push(
			orderedJSON({
				raw: record.raw,
				span_starts: record.span_starts,
				span_ends: record.span_ends,
				span_tags: record.span_tags,
				register: record.register,
				region: row.region,
				city: row.sigungu,
				district: parenthetical(row),
				street: row.road,
				number: row.number,
				postcode: row.postcode,
				lon: centroid[0],
				lat: centroid[1],
			})
		)
	}

	await writeLocalTextFile(boardLines, resolvePath(outDir, "kr-board.jsonl"))

	await writeLocalTextFile(
		orderedJSON(new Map([...centroids].map(([key, [lon, lat]]) => [key, [lon, lat]]))) + "\n",
		resolvePath(outDir, "kr-sigungu-centroids.json")
	)

	const poolUnits = new Set([...train, ...val].map((row) => krHoldoutKey(row.region, row.sigungu)))
	const boardUnits = new Set(board.map((row) => krHoldoutKey(row.region, row.sigungu)))
	const overlap = [...boardUnits].filter((unit) => poolUnits.has(unit)).toSorted(compareByScalarValue)

	if (overlap.length) throw new Error(`board 시군구 leak into train/val: ${overlap.slice(0, 5).join(", ")}`)

	// Pass 4: the registry selection.
	const registrySelector = selectExact(registryPool, options.registryRows, rng)
	const registryBoardSelector = selectExact(registryBoardPool + unalignedPool, options.registryBoardRows, rng)
	const registryRows: CJKRecord[] = []
	const registryBoard: Array<Map<string, unknown>> = []
	const registryRegisters = new Map<string, number>()
	const boardPoints: Array<readonly [number, number] | null> = []

	for await (const permit of permitRows()) {
		const aligned = krPermitAlignment(permit, index)
		const point = permit.x !== null && permit.y !== null ? ([permit.x, permit.y] as const) : null

		if (aligned.length) {
			const heldOut = muniBucket(krHoldoutKey(aligned[0]!.region, aligned[0]!.sigungu)) >= options.boardBucketMin

			for (const item of aligned) {
				if (heldOut) {
					if (nextSelection(registryBoardSelector)) {
						registryBoard.push(
							new Map<string, unknown>([
								["raw", item.raw],
								["span_starts", item.spanStarts],
								["span_ends", item.spanEnds],
								["span_tags", item.spanTags],
								["register", item.register],
								["aligned", true],
								["category", permit.category],
							])
						)

						boardPoints.push(point)
					}
				} else if (nextSelection(registrySelector)) {
					const record = krRegistryRecord(item)

					verifyCJKRecord(record, tagSet)
					countInto(registryRegisters, item.register)
					registryRows.push(record)
				}
			}
		} else if ((permit.roadAddress || permit.lotAddress) && nextSelection(registryBoardSelector)) {
			// The selector draws only for a permit with an address, as the Python nesting did.
			registryBoard.push(
				new Map<string, unknown>([
					["raw", permit.roadAddress || permit.lotAddress],
					["lot_raw", permit.lotAddress],
					["aligned", false],
					["category", permit.category],
				])
			)

			boardPoints.push(point)
		}
	}

	rng.shuffle(registryRows)

	const registryVal = Math.max(1, Math.trunc(registryRows.length * options.registryValFraction))
	const registrySplits = new Map<string, CJKSplitReport>()

	for (const [split, splitRows] of [
		["train", registryRows.slice(registryVal)],
		["val", registryRows.slice(0, registryVal)],
	] as const) {
		registrySplits.set(
			split,
			await writeCJKSplit({
				directory: resolvePath(registryDir, split),
				rows: splitRows,
				rowsPerPart: options.rowsPerPart,
				encodePart: (rows) => [...rows],
				partPrefix: "kr-registry",
				context: "KR registry assembly",
				statsSample: { kind: CJKStatsSample.FirstOfSplit, rows: options.statsSamplePerPart },
			})
		)
	}

	const projected = transform(boardPoints.filter((point) => point !== null))
	let cursor = 0

	for (const [position, entry] of registryBoard.entries()) {
		if (!boardPoints[position]) continue

		const point = projected[cursor++]

		entry.set("lon", point ? point[0] : null)
		entry.set("lat", point ? point[1] : null)
	}

	await writeLocalTextFile(
		registryBoard.map((entry) => orderedJSON(entry)),
		resolvePath(registryDir, "kr-registry-board.jsonl")
	)

	const vocab = await sealCharVocab(outDir, "char-vocab-kr.json")
	const registryVocab = await sealCharVocab(registryDir, "char-vocab-kr-registry.json")

	const registry: KRRegistryReport = {
		alignment_census: { per_form: permits.censusForm, per_category: permits.censusCategory },
		pool: { aligned: registryPool, held_out: registryBoardPool, unaligned: unalignedPool },
		registers: new Map(mostCommon(registryRegisters)),
		splits: registrySplits,
		board_rows: registryBoard.length,
		char_vocab_size: registryVocab.size,
	}

	const report: KRCorpusReport = {
		seed: options.seed,
		juso_zip: options.jusoZip.toString(),
		permit_dir: options.permitDir.toString(),
		label_set: KR_LABEL_SET_NAME,
		source: KR_CORPUS_SOURCE,
		registry_source: KR_REGISTRY_SOURCE,
		eligible_rows_scanned: scanned,
		dropped_at_source: new Map(mostCommon(dropped)),
		per_region_cap: cap,
		regions_train: new Set(train.map((row) => row.region)).size,
		board_bucket_min: options.boardBucketMin,
		board_sigungu: boardUnits.size,
		board_rows: boardRecords.length,
		board_rows_without_centroid: withoutCentroid,
		registers: new Map(mostCommon(registerCounts)),
		char_vocab_size: vocab.size,
		centroid_units: centroids.size,
		fractions: { country: options.countryFraction },
		register_weights: new Map([...KR_REGISTER_WEIGHTS].map(([name, weight]) => [name, weight])),
		splits,
		board_coverage: coverageStats(boardRecords),
		registry,
	}

	await writeLocalTextFile(orderedJSON(report, { indent: "\t" }) + "\n", resolvePath(outDir, "build-report.json"))

	await writeLocalTextFile(
		orderedJSON(registry, { indent: "\t" }) + "\n",
		resolvePath(registryDir, "build-report.json")
	)

	return report
}
