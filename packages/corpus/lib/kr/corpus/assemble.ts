/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Builds the Korean label corpus from the road-name address register and the Korean registry corpus from
 *   the permit registry: four passes, two corpora, one shared generator.
 *
 *   Pass 1 counts eligible register rows per 시도 and builds the key index. Pass 2 measures permit alignment and
 *   averages each 시군구's permit points into a centroid. Pass 3 selects register rows and pass 4 aligned permit
 *   rows, both drawing from one {@linkcode PyRandom} in the Python assembler's order
 *   (`countries/kr/corpora/assemble.py`), so hoisting one draw above another re-renders both corpora.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { isDirectory, pathExists } from "@mailwoman/core/fs/readers/stat"
import { makeDirectories, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { pySum } from "@mailwoman/core/numeric"
import { runFileSync } from "@mailwoman/core/process"
import { countInto, mostCommon } from "@mailwoman/core/stats"
import { compareByCodePoint } from "@mailwoman/core/strings/compare"
import { asPythonFloat, pythonJSONDumps } from "@mailwoman/core/strings/python-json"
import { pythonSplitLines, pythonSplitWhitespace } from "@mailwoman/core/strings/python-text"
import { type PathBuilderLike, resolvePath } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import {
	buildCharVocab,
	type CJKRecord,
	coverageStats,
	MAX_FIELD_CHARS,
	muniBucket,
	nextSelection,
	readLabelSetTags,
	saveCharVocab,
	selectExact,
	verifyCJKRecord,
	waterFill,
	writeCJKCorpusParquet,
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
import { readParquetRows } from "#parquet/readers"
import { PyRandom } from "#training/pyrandom"

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

	const out = pythonSplitLines(String(stdout)).map((line) => {
		const parts = pythonSplitWhitespace(line)

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

const quotasFor = (poolCounts: Map<string, number>, target: number) => {
	const cap = waterFill(poolCounts, target)
	const quotas = new Map([...poolCounts].map(([region, count]) => [region, Math.min(cap, count)]))
	let shortfall = target - pySum(quotas.values())

	if (shortfall > 0) {
		const headroom = (region: string) => poolCounts.get(region)! - quotas.get(region)!

		for (const region of [...poolCounts.keys()].toSorted((a, b) => headroom(b) - headroom(a))) {
			const grant = Math.min(headroom(region), shortfall)

			quotas.set(region, quotas.get(region)! + grant)
			shortfall -= grant

			if (shortfall <= 0) break
		}
	}

	return { cap, quotas }
}

const occupied = async (directory: PathBuilderLike) =>
	(await isDirectory(directory)) &&
	(await Globerator.from("*", { cwd: directory.toString(), onlyFiles: false, dot: true }).toArray()).length > 0

async function sealedVocab(directory: PathBuilderLike, name: string): Promise<Map<string, number>> {
	const paths = (
		await Globerator.from("*.parquet", { cwd: resolvePath(directory, "train").toString(), absolute: true }).toArray()
	)
		.map(String)
		.toSorted(compareByCodePoint)

	const raws: string[] = []

	for (const path of paths) {
		for (const row of await readParquetRows<{ raw: string }>(path, { columns: ["raw"] })) {
			raws.push(row.raw)
		}
	}

	const vocab = buildCharVocab(raws, 2)

	await saveCharVocab(vocab, resolvePath(directory, name))

	return vocab
}

const partName = (prefix: string, part: number) => `${prefix}-${String(part).padStart(4, "0")}.parquet`

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
 * Builds both corpora and returns the label corpus's build report,
 * which holds the registry's under `registry`.
 *
 * @throws When an output directory holds files and `force` is unset, an input is missing,
 * the register drop rate exceeds 2%, or a board 시군구 reaches train or val.
 */
export async function buildKRCorpus(options: KRCorpusOptions): Promise<Map<string, unknown>> {
	const rng = new PyRandom(options.seed)
	const tagSet = await readLabelSetTags(KR_LABEL_SET_NAME)
	const transform = options.transform ?? transformKRCoordinates
	const outDir = resolvePath(options.outDir)
	const registryDir = resolvePath(options.registryOutDir)

	for (const directory of [outDir, registryDir]) {
		if ((await occupied(directory)) && !options.force) {
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
	const { cap, quotas } = quotasFor(poolCounts, options.trainRows + options.valRows)
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

			await writeCJKCorpusParquet(chunk, resolvePath(outDir, split, partName("kr-part", part)), "KR corpus assembly")

			part++
			written += chunk.length
			statsInput.push(...chunk.slice(0, options.statsSamplePerPart))
		}

		splits.set(split, { rows: written, parts: part, coverage: coverageStats(statsInput) })
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
			pythonJSONDumps(
				{
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
					lon: asPythonFloat(centroid[0]),
					lat: asPythonFloat(centroid[1]),
				},
				{ ensureASCII: false }
			)
		)
	}

	await writeLocalTextFile(boardLines, resolvePath(outDir, "kr-board.jsonl"))

	await writeLocalTextFile(
		pythonJSONDumps(
			new Map([...centroids].map(([key, [lon, lat]]) => [key, [asPythonFloat(lon), asPythonFloat(lat)]])),
			{ ensureASCII: false }
		) + "\n",
		resolvePath(outDir, "kr-sigungu-centroids.json")
	)

	const poolUnits = new Set([...train, ...val].map((row) => krHoldoutKey(row.region, row.sigungu)))
	const boardUnits = new Set(board.map((row) => krHoldoutKey(row.region, row.sigungu)))
	const overlap = [...boardUnits].filter((unit) => poolUnits.has(unit)).toSorted()

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
	const registrySplits = new Map<string, unknown>()

	for (const [split, splitRows] of [
		["train", registryRows.slice(registryVal)],
		["val", registryRows.slice(0, registryVal)],
	] as const) {
		await makeDirectories(resolvePath(registryDir, split))

		let part = 0

		for (let start = 0; start < splitRows.length; start += options.rowsPerPart) {
			await writeCJKCorpusParquet(
				splitRows.slice(start, start + options.rowsPerPart),
				resolvePath(registryDir, split, partName("kr-registry", part)),
				"KR registry assembly"
			)

			part++
		}

		registrySplits.set(split, {
			rows: splitRows.length,
			parts: part,
			coverage: coverageStats(splitRows.slice(0, options.statsSamplePerPart)),
		})
	}

	const projected = transform(boardPoints.filter((point) => point !== null))
	let cursor = 0

	for (const [position, entry] of registryBoard.entries()) {
		if (!boardPoints[position]) continue

		const point = projected[cursor++]

		entry.set("lon", point ? asPythonFloat(point[0]) : null)
		entry.set("lat", point ? asPythonFloat(point[1]) : null)
	}

	await writeLocalTextFile(
		registryBoard.map((entry) => pythonJSONDumps(entry, { ensureASCII: false })),
		resolvePath(registryDir, "kr-registry-board.jsonl")
	)

	const vocab = await sealedVocab(outDir, "char-vocab-kr.json")
	const registryVocab = await sealedVocab(registryDir, "char-vocab-kr-registry.json")

	const registry = new Map<string, unknown>([
		[
			"alignment_census",
			new Map<string, unknown>([
				["per_form", permits.censusForm],
				["per_category", permits.censusCategory],
			]),
		],
		[
			"pool",
			new Map([
				["aligned", registryPool],
				["held_out", registryBoardPool],
				["unaligned", unalignedPool],
			]),
		],
		["registers", new Map(mostCommon(registryRegisters))],
		["splits", registrySplits],
		["board_rows", registryBoard.length],
		["char_vocab_size", registryVocab.size],
	])

	const report = new Map<string, unknown>([
		["seed", options.seed],
		["juso_zip", options.jusoZip.toString()],
		["permit_dir", options.permitDir.toString()],
		["label_set", KR_LABEL_SET_NAME],
		["source", KR_CORPUS_SOURCE],
		["registry_source", KR_REGISTRY_SOURCE],
		["eligible_rows_scanned", scanned],
		["dropped_at_source", new Map(mostCommon(dropped))],
		["per_region_cap", cap],
		["regions_train", new Set(train.map((row) => row.region)).size],
		["board_bucket_min", options.boardBucketMin],
		["board_sigungu", boardUnits.size],
		["board_rows", boardRecords.length],
		["board_rows_without_centroid", withoutCentroid],
		["registers", new Map(mostCommon(registerCounts))],
		["char_vocab_size", vocab.size],
		["centroid_units", centroids.size],
		["fractions", new Map([["country", asPythonFloat(options.countryFraction)]])],
		["register_weights", new Map([...KR_REGISTER_WEIGHTS].map(([name, weight]) => [name, asPythonFloat(weight)]))],
		["splits", splits],
		["board_coverage", coverageStats(boardRecords)],
		["registry", registry],
	])

	await writeLocalTextFile(
		pythonJSONDumps(report, { indent: 2, ensureASCII: false }) + "\n",
		resolvePath(outDir, "build-report.json")
	)

	await writeLocalTextFile(
		pythonJSONDumps(registry, { indent: 2, ensureASCII: false }) + "\n",
		resolvePath(registryDir, "build-report.json")
	)

	return report
}
