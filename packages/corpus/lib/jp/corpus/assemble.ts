/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Assembles the Japan corpus through survey, selection, rendering, writing and reporting.
 *
 *   One {@linkcode PyRandom} runs through every stage: the exact-selection masks, the shuffles, the register draw
 *   and each per-row fraction. The order of the stages and of the draws inside them decides what the corpus holds,
 *   and `jp-build-reference.json` pins the emitted rows. Pass 1 counts eligible rows so the per-prefecture cap can
 *   be water-filled against the target, and pass 2 streams the selection under that cap.
 *
 *   Ported from the Python builders' `countries/jp/corpora/assemble.py`, draw for draw.
 */

import { makeDirectories, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { pySum } from "@mailwoman/core/numeric"
import { countInto, mostCommon } from "@mailwoman/core/stats"
import { asPythonFloat, pythonJSONDumps } from "@mailwoman/core/strings/python-json"
import { type PathBuilderLike, resolvePath } from "path-ts"

import {
	type CJKRecord,
	coverageStats,
	directoryHasEntries,
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
import {
	availableJPRegisters,
	chooseJPRegister,
	JP_CORPUS_SOURCE,
	JP_LABEL_SET_NAME,
	JP_REGISTER_WEIGHTS,
	renderJPRow,
	verifyJPRecord,
} from "#jp/corpus/rows"
import { iterJPSourceRows, type JPSourceRow, type KenAllIndex, loadKenAllPostcodes } from "#jp/corpus/sources"
import { municipalityKanaFromAdminDB, municipalityKanaLookup } from "#jp/kana"
import { JP_BOARD_BUCKET_MIN } from "#jp/registers"
import { splitJPStreet, VARIANT_HYPHENS } from "#jp/text"
import { PyRandom } from "#training/pyrandom"

/**
 * The prefectures a full build's train split must cover.
 */
const PREFECTURE_COUNT = 47

/**
 * The source drop rate beyond which the eligibility filter no longer fits the data.
 */
const MAX_DROP_RATE = 0.02

/**
 * Options for {@linkcode buildJPCorpus}, named as the Python assembler's flags.
 */
export interface JPCorpusOptions {
	parquet: PathBuilderLike
	kenall: PathBuilderLike
	/**
	 * The WOF admin database for the kana readings, or `null` to decline the `kana_municipality` register.
	 */
	adminDB: PathBuilderLike | null
	outDir: PathBuilderLike
	trainRows: number
	valRows: number
	boardRows: number
	rowsPerPart: number
	statsSamplePerPart: number
	postcodeFraction: number
	countryFraction: number
	spacedFraction: number
	variantHyphenFraction: number
	maxFieldChars: number
	/**
	 * A smoke build reads only this many row groups and skips the 47-prefecture check.
	 */
	maxRowGroups?: number
	/**
	 * `REGEX:K` appends K−1 copies of every selected train row whose municipality matches (#2178).
	 */
	upweightPattern?: string | null
	seed: number
	force: boolean
}

/**
 * The defaults of the Python assembler's flags.
 */
export const JP_CORPUS_DEFAULTS = {
	trainRows: 2_000_000,
	valRows: 20_000,
	boardRows: 20_000,
	rowsPerPart: 250_000,
	statsSamplePerPart: 50_000,
	postcodeFraction: 0.3,
	countryFraction: 0.1,
	spacedFraction: 0.12,
	variantHyphenFraction: 0.05,
	maxFieldChars: MAX_FIELD_CHARS,
	seed: 42,
} as const

interface SourceSurvey {
	scanned: number
	dropped: Map<string, number>
	poolCounts: Map<string, number>
	boardCount: number
	cap: number
	quotas: Map<string, number>
}

interface Selection {
	train: JPSourceRow[]
	val: JPSourceRow[]
	board: JPSourceRow[]
	upweighted: number
}

async function surveySource(options: JPCorpusOptions): Promise<SourceSurvey> {
	const poolCounts = new Map<string, number>()
	const dropped = new Map<string, number>()
	let boardCount = 0
	let scanned = 0

	for await (const [prefecture, municipality] of iterJPSourceRows(options.parquet, {
		maxRowGroups: options.maxRowGroups,
		maxFieldChars: options.maxFieldChars,
		dropped,
	})) {
		scanned++

		if (muniBucket(municipality) >= JP_BOARD_BUCKET_MIN) {
			boardCount++
		} else {
			countInto(poolCounts, prefecture)
		}
	}

	console.log(
		`pass 1: ${scanned.toLocaleString("en-US")} eligible rows · ${poolCounts.size} prefectures · board pool ${boardCount.toLocaleString("en-US")}`
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

	console.log(
		`pass 1: per-prefecture cap ${cap.toLocaleString("en-US")}; quota total ${pySum(quotas.values()).toLocaleString("en-US")} of target ${target.toLocaleString("en-US")}`
	)

	return { scanned, dropped, poolCounts, boardCount, cap, quotas }
}

async function selectRows(options: JPCorpusOptions, rng: PyRandom, survey: SourceSurvey): Promise<Selection> {
	const selectors = new Map(
		[...survey.poolCounts].map(([prefecture, count]) => [
			prefecture,
			selectExact(count, survey.quotas.get(prefecture)!, rng),
		])
	)

	const boardSelector = selectExact(survey.boardCount, options.boardRows, rng)
	const selected: JPSourceRow[] = []
	const board: JPSourceRow[] = []

	for await (const row of iterJPSourceRows(options.parquet, {
		maxRowGroups: options.maxRowGroups,
		maxFieldChars: options.maxFieldChars,
	})) {
		if (muniBucket(row[1]) >= JP_BOARD_BUCKET_MIN) {
			if (nextSelection(boardSelector)) {
				board.push(row)
			}
		} else if (nextSelection(selectors.get(row[0])!)) {
			selected.push(row)
		}
	}

	console.log(
		`pass 2: selected ${selected.length.toLocaleString("en-US")} pool rows · ${board.length.toLocaleString("en-US")} board rows`
	)

	rng.shuffle(selected)

	const train = selected.slice(0, options.trainRows)
	const val = selected.slice(options.trainRows, options.trainRows + options.valRows)
	let upweighted = 0

	if (options.upweightPattern) {
		const at = options.upweightPattern.lastIndexOf(":")
		const pattern = new RegExp(options.upweightPattern.slice(0, Math.max(at, 0)), "u")
		const factor = Number.parseInt(options.upweightPattern.slice(at + 1), 10)
		const matching = train.filter((row) => pattern.test(row[1]))

		for (let copy = 0; copy < factor - 1; copy++) {
			train.push(...matching)
		}

		upweighted = matching.length * (factor - 1)
		rng.shuffle(train)

		console.log(
			`upweight ${pattern.source} ×${factor}: ${matching.length} matching train rows, ${upweighted} copies appended`
		)
	}

	return { train, val, board, upweighted }
}

/**
 * Renders selected source rows, drawing every per-row choice from the shared generator,
 * and counts the KEN_ALL tiers and the register availability the build report records.
 */
class JPRowEncoder {
	readonly kenallTiers = new Map<string, number>()
	readonly registerAvailability = new Map<string, number>()
	readonly #options: JPCorpusOptions
	readonly #rng: PyRandom
	readonly #kenall: KenAllIndex
	readonly #tagSet: ReadonlySet<string>
	readonly #kana: ReadonlyMap<string, string>

	constructor(
		options: JPCorpusOptions,
		rng: PyRandom,
		kenall: KenAllIndex,
		tagSet: ReadonlySet<string>,
		kana: ReadonlyMap<string, string>
	) {
		this.#options = options
		this.#rng = rng
		this.#kenall = kenall
		this.#tagSet = tagSet
		this.#kana = kana
	}

	#postcode(prefecture: string, municipality: string, district: string): string | null {
		if (this.#rng.random() >= this.#options.postcodeFraction) return null

		const [postcode, tier] = this.#kenall.lookup(prefecture, municipality, district)

		countInto(this.kenallTiers, tier)

		return postcode
	}

	/**
	 * Every row rendered in a drawn register, with the variant-hyphen draw the board omits.
	 */
	encode(rows: readonly JPSourceRow[]): CJKRecord[] {
		return rows.map(([prefecture, municipality, street, number]) => {
			const [district, chome] = splitJPStreet(street)
			const municipalityKana = municipalityKanaLookup(this.#kana, municipality)
			const options = availableJPRegisters(chome, number, municipalityKana !== null)

			countInto(this.registerAvailability, options.length === JP_REGISTER_WEIGHTS.size ? "full" : "reduced")

			const register = chooseJPRegister(this.#rng, options)
			const postcode = this.#postcode(prefecture, municipality, district)

			const hyphen = this.#rng.random() < this.#options.variantHyphenFraction ? this.#rng.choice(VARIANT_HYPHENS) : "-"

			const spaced = this.#rng.random() < this.#options.spacedFraction
			const country = this.#rng.random() < this.#options.countryFraction

			const record = renderJPRow({
				prefecture,
				municipality,
				district,
				chome,
				number,
				postcode,
				register,
				spaced,
				country,
				hyphen,
				municipalityKana,
			})

			verifyJPRecord(record, this.#tagSet)

			return record
		})
	}

	/**
	 * One held-out row, with no variant hyphen, because the board reads the canonical surface.
	 */
	boardRecord([prefecture, municipality, street, number]: JPSourceRow): CJKRecord {
		const [district, chome] = splitJPStreet(street)
		const municipalityKana = municipalityKanaLookup(this.#kana, municipality)
		const register = chooseJPRegister(this.#rng, availableJPRegisters(chome, number, municipalityKana !== null))
		const postcode = this.#postcode(prefecture, municipality, district)
		const spaced = this.#rng.random() < this.#options.spacedFraction
		const country = this.#rng.random() < this.#options.countryFraction

		const record = renderJPRow({
			prefecture,
			municipality,
			district,
			chome,
			number,
			postcode,
			register,
			spaced,
			country,
			municipalityKana,
		})

		verifyJPRecord(record, this.#tagSet)

		return record
	}
}

const pythonNumber = (value: number | null) => (value === null ? null : asPythonFloat(value))

/**
 * Builds the corpus, its board and its character vocabulary under `outDir`, and returns the build report.
 *
 * @throws When `outDir` holds files and `force` is unset, an input is missing, the drop rate exceeds 2%,
 * a full build's train split misses a prefecture, or a board municipality reaches train or val.
 */
export async function buildJPCorpus(options: JPCorpusOptions): Promise<Map<string, unknown>> {
	const rng = new PyRandom(options.seed)
	const tagSet = await readLabelSetTags(JP_LABEL_SET_NAME)
	const kenall = await loadKenAllPostcodes(options.kenall)
	const survey = await surveySource(options)
	const selection = await selectRows(options, rng, survey)
	const kana = options.adminDB ? await municipalityKanaFromAdminDB(options.adminDB) : new Map<string, string>()

	console.error(`[jp] kana readings for ${kana.size.toLocaleString("en-US")} municipalities (#2165)`)

	const encoder = new JPRowEncoder(options, rng, kenall, tagSet, kana)
	const outDir = resolvePath(options.outDir)

	if ((await directoryHasEntries(outDir)) && !options.force) {
		throw new Error(
			`${outDir.toString()} exists and is non-empty — pass --force to overwrite (a built corpus is a read-only artifact)`
		)
	}

	const splits = new Map<string, unknown>()

	for (const [split, sourceRows] of [
		["train", selection.train],
		["val", selection.val],
	] as const) {
		await makeDirectories(resolvePath(outDir, split))

		const statsInput: CJKRecord[] = []
		let part = 0
		let written = 0

		for (let start = 0; start < sourceRows.length; start += options.rowsPerPart) {
			const chunk = encoder.encode(sourceRows.slice(start, start + options.rowsPerPart))
			const name = `part-${String(part).padStart(4, "0")}.parquet`

			await writeCJKCorpusParquet(chunk, resolvePath(outDir, split, name), "JP corpus assembly")

			part++
			written += chunk.length
			statsInput.push(...chunk.slice(0, options.statsSamplePerPart))
		}

		const coverage = coverageStats(statsInput)

		splits.set(split, { rows: written, parts: part, coverage })

		console.log(
			`${split}: ${written.toLocaleString("en-US")} rows in ${part} parts; BIO char coverage ${coverage.bio_char_coverage_significant.value.toFixed(4)}`
		)
	}

	const boardRecords: CJKRecord[] = []
	const boardLines: string[] = []

	for (const row of selection.board) {
		const [prefecture, municipality, street, number, lon, lat] = row
		const record = encoder.boardRecord(row)

		boardRecords.push(record)

		boardLines.push(
			pythonJSONDumps(
				{
					raw: record.raw,
					span_starts: record.span_starts,
					span_ends: record.span_ends,
					span_tags: record.span_tags,
					register: record.register,
					pref: prefecture,
					muni: municipality,
					street,
					number,
					lon: pythonNumber(lon),
					lat: pythonNumber(lat),
				},
				{ ensureASCII: false }
			)
		)
	}

	await writeLocalTextFile(boardLines, resolvePath(outDir, "jp-board.jsonl"))

	const trainPrefectures = new Set(selection.train.map((row) => row[0]))

	if (options.maxRowGroups === undefined && trainPrefectures.size !== PREFECTURE_COUNT) {
		throw new Error(`train covers ${trainPrefectures.size} prefectures, expected 47 — stratification broken`)
	}

	const trainMunicipalities = new Set([...selection.train, ...selection.val].map((row) => normalizeCJKText(row[1])))
	const boardMunicipalities = new Set(selection.board.map((row) => normalizeCJKText(row[1])))
	const overlap = [...boardMunicipalities].filter((name) => trainMunicipalities.has(name)).toSorted()

	if (overlap.length) throw new Error(`board municipalities leak into train/val: ${overlap.slice(0, 5).join(", ")}`)

	const vocab = await sealCharVocab(outDir, "char-vocab-jp-full.json")

	const report = new Map<string, unknown>([
		["seed", options.seed],
		["source_parquet", options.parquet.toString()],
		["kenall", options.kenall.toString()],
		["label_set", JP_LABEL_SET_NAME],
		["source", JP_CORPUS_SOURCE],
		["eligible_rows_scanned", survey.scanned],
		["dropped_at_source", new Map(mostCommon(survey.dropped))],
		["max_field_chars", options.maxFieldChars],
		["per_prefecture_cap", survey.cap],
		["prefectures_train", trainPrefectures.size],
		["board_municipalities", boardMunicipalities.size],
		["board_rows", boardRecords.length],
		["kenall_join_tiers", new Map(mostCommon(encoder.kenallTiers))],
		["register_availability", encoder.registerAvailability],
		["char_vocab_size", vocab.size],
		[
			"fractions",
			new Map([
				["postcode", asPythonFloat(options.postcodeFraction)],
				["country", asPythonFloat(options.countryFraction)],
				["spaced", asPythonFloat(options.spacedFraction)],
				["variant_hyphen", asPythonFloat(options.variantHyphenFraction)],
			]),
		],
		["register_weights", new Map([...JP_REGISTER_WEIGHTS].map(([name, weight]) => [name, asPythonFloat(weight)]))],
		[
			"upweight",
			new Map<string, unknown>([
				["pattern", options.upweightPattern ?? null],
				["copies_appended", selection.upweighted],
			]),
		],
		["splits", splits],
		["board_coverage", coverageStats(boardRecords)],
	])

	const text = pythonJSONDumps(report, { indent: 2, ensureASCII: false })

	await writeLocalTextFile(text + "\n", resolvePath(outDir, "build-report.json"))

	console.log(text)

	return report
}
