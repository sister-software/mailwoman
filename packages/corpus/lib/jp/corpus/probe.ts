/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The v8 JP probe corpus: native, space-free Overture-JP rows with a municipality-held-out board.
 *
 *   Each row is rendered large to small, `[〒NNN-NNNN ]{prefecture}{municipality}{street}{number}`, with
 *   the spans recorded as the fields are concatenated. The 〒 mark stays outside the postcode span. A
 *   postcode is joined on a fraction of rows from KEN_ALL's first code for the municipality, because
 *   Overture-JP has no postcode. Each prefecture fills its own reservoir, and a round-robin draw takes one
 *   row per prefecture per pass. Municipalities whose bucket reaches the board range go to the board and
 *   never to train or val.
 *
 *   One seeded `SeededRandom` feeds every draw, in the Python builder's order: the two reservoirs as the rows
 *   arrive, the per-prefecture shuffles, the draw shuffle, the postcode coins of train then val, and the
 *   board's coins.
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { orderedJSON } from "@mailwoman/core/json"
import { SeededRandom } from "@mailwoman/core/random"
import { countInto } from "@mailwoman/core/stats"
import { compareByScalarValue } from "@mailwoman/core/strings/compare"
import { resolvePath } from "path-ts"

import {
	buildCharVocab,
	CJK_CORPUS_COLUMNS,
	labelTokensByFirstSpan,
	muniBucket,
	RowRenderer,
	saveCharVocab,
} from "#cjk/builder"
import { normalizeCJKText } from "#cjk/text"
import { loadKenAllPostcodes } from "#jp/corpus/sources"
import { JP_BOARD_BUCKET_MIN } from "#jp/registers"
import { JP_PREFECTURE_NAMES } from "#jp/text"
import { readParquetRows } from "#parquet/readers"
import { openParquetRowStream } from "#parquet/streams"
import { writeColumnParquetFile } from "#parquet/writers"
import { stampRowLicenses } from "#source-register/row-license"
import { pythonRepr } from "#training/config/python-yaml"

/**
 * The corpus source of every probe row.
 */
export const JP_PROBE_SOURCE = "overture-jp"

/**
 * The probe corpus's columns: the CJK corpus columns without `register`.
 */
export const JP_PROBE_COLUMNS = CJK_CORPUS_COLUMNS.filter(([name]) => name !== "register")

const PREFECTURE_COUNT = 47

/**
 * The reservoir holds multiple times a prefecture's even share of the target.
 */
const RESERVOIR_SHARE_MULTIPLE = 3

/**
 * One rendered probe row.
 */
export interface JPProbeRecord {
	raw: string
	tokens: string[]
	labels: string[]
	span_starts: number[]
	span_ends: number[]
	span_tags: string[]
	country: string
	source: string
}

/**
 * Renders the fields large to small, with a `〒NNN-NNNN ` lead when `postcode` is set.
 */
export function renderProbeRow(
	prefecture: string,
	municipality: string,
	street: string | null,
	number: string | null,
	postcode: string | null
): JPProbeRecord {
	const row = new RowRenderer()

	if (postcode) {
		row.glue("〒")
		row.put("postcode", `${postcode.slice(0, 3)}-${postcode.slice(3)}`)
		row.glue(" ")
	}

	row.put("region", prefecture)
	row.put("locality", municipality)

	if (street) {
		row.put("street", street)
	}

	if (number) {
		row.put("house_number", number)
	}

	return {
		raw: row.raw,
		...labelTokensByFirstSpan(row.raw, row.starts, row.ends, row.tags),
		span_starts: row.starts,
		span_ends: row.ends,
		span_tags: row.tags,
		country: "JP",
		source: JP_PROBE_SOURCE,
	}
}

/**
 * One Overture-JP address as the reservoirs keep it.
 */
export interface JPProbeSource {
	pref: string
	muni: string
	street: string | null
	number: string | null
	lon: number | null
	lat: number | null
}

interface OvertureRow {
	address_levels: Array<{ value: string | null }> | null
	street: string | null
	number: string | null
	lon: number | null
	lat: number | null
}

/**
 * Options for {@linkcode buildJPProbeCorpus}.
 */
export interface JPProbeOptions {
	parquet: string
	kenAll: string
	outDir: string
	trainRows: number
	valRows: number
	boardRows: number
	postcodeFraction: number
	seed: number
}

/**
 * The defaults the Python builder registered.
 */
export const JP_PROBE_DEFAULTS = {
	trainRows: 200_000,
	valRows: 4000,
	boardRows: 2000,
	postcodeFraction: 0.3,
	seed: 42,
} as const

/**
 * One reservoir step: append while below `cap`, else replace a uniformly drawn slot.
 */
function offer<T>(reservoir: T[], cap: number, seen: number, item: T, rng: SeededRandom): void {
	if (reservoir.length < cap) {
		reservoir.push(item)

		return
	}

	const slot = rng.randrange(seen)

	if (slot < cap) {
		reservoir[slot] = item
	}
}

async function fillReservoirs(options: JPProbeOptions, rng: SeededRandom) {
	if (!(await pathExists(options.parquet))) throw new Error(`No Overture-JP parquet at ${options.parquet}`)

	const cap = RESERVOIR_SHARE_MULTIPLE * Math.floor((options.trainRows + options.valRows) / PREFECTURE_COUNT)
	const pool = new Map<string, JPProbeSource[]>()
	const poolSeen = new Map<string, number>()
	const board: JPProbeSource[] = []
	const dropped = new Map<string, number>()
	let boardSeen = 0

	for await (const row of openParquetRowStream<OvertureRow>(options.parquet, {
		columns: ["address_levels", "street", "number", "lon", "lat"],
	})) {
		const levels = row.address_levels

		if (!levels || levels.length < 2 || !levels[0]!.value || !levels[1]!.value) {
			countInto(dropped, "levels")

			continue
		}

		const pref = levels[0]!.value
		const muni = levels[1]!.value

		if (!JP_PREFECTURE_NAMES.has(pref)) {
			countInto(dropped, "junk_prefecture")

			continue
		}

		if (!row.street && !row.number) {
			countInto(dropped, "empty")

			continue
		}

		const source: JPProbeSource = { pref, muni, street: row.street, number: row.number, lon: row.lon, lat: row.lat }

		if (muniBucket(muni) >= JP_BOARD_BUCKET_MIN) {
			boardSeen++
			offer(board, options.boardRows, boardSeen, source, rng)
		} else {
			const seen = (poolSeen.get(pref) ?? 0) + 1

			poolSeen.set(pref, seen)

			let reservoir = pool.get(pref)

			if (!reservoir) {
				reservoir = []
				pool.set(pref, reservoir)
			}

			offer(reservoir, cap, seen, source, rng)
		}
	}

	console.log(`prefectures in pool: ${pool.size}; board reservoir: ${board.length} of ${boardSeen} seen`)
	console.log(`dropped: ${pythonRepr(dropped)}`)

	return { pool, board }
}

/**
 * Shuffles each prefecture's reservoir, takes one row per prefecture per pass in
 * code-point order of the prefecture names until the target fills or the pools run out,
 * shuffles the draw, and splits train from val.
 */
function drawSplits(options: JPProbeOptions, pool: ReadonlyMap<string, JPProbeSource[]>, rng: SeededRandom) {
	for (const reservoir of pool.values()) {
		rng.shuffle(reservoir)
	}

	const order = [...pool.keys()].toSorted(compareByScalarValue)
	const target = options.trainRows + options.valRows
	const next = new Map(order.map((pref) => [pref, 0]))
	const draw: JPProbeSource[] = []

	while (draw.length < target) {
		let progressed = false

		for (const pref of order) {
			const index = next.get(pref)!
			const reservoir = pool.get(pref)!

			if (index < reservoir.length && draw.length < target) {
				draw.push(reservoir[index]!)
				next.set(pref, index + 1)
				progressed = true
			}
		}

		if (!progressed) break
	}

	rng.shuffle(draw)

	return { train: draw.slice(0, options.trainRows), val: draw.slice(options.trainRows, target) }
}

/**
 * Each prefecture's train row count, and the board's normalized municipalities.
 *
 * @throws When train misses a prefecture, or a board municipality also appears in train or val.
 */
export function checkStratification(
	train: readonly JPProbeSource[],
	val: readonly JPProbeSource[],
	board: readonly JPProbeSource[]
): { prefectures: Map<string, number>; boardMunicipalities: Set<string> } {
	const prefectures = new Map<string, number>()

	for (const row of train) {
		countInto(prefectures, row.pref)
	}

	if (prefectures.size !== PREFECTURE_COUNT) {
		throw new Error(
			`train covers ${prefectures.size} prefectures, expected exactly ${PREFECTURE_COUNT} — stratification broken`
		)
	}

	const seen = new Set([...train, ...val].map((row) => normalizeCJKText(row.muni)))
	const boardMunicipalities = new Set(board.map((row) => normalizeCJKText(row.muni)))
	const overlap = [...boardMunicipalities].filter((muni) => seen.has(muni)).toSorted(compareByScalarValue)

	if (overlap.length) {
		throw new Error(`board municipalities leak into train/val: ${pythonRepr(overlap.slice(0, 5))}`)
	}

	return { prefectures, boardMunicipalities }
}

/**
 * Writes the probe corpus's train and val parts, board, vocabulary and build report, and returns the report.
 *
 * @throws When an input is missing, a split holds an all-O row, or {@linkcode checkStratification} refuses.
 */
export async function buildJPProbeCorpus(options: JPProbeOptions): Promise<Map<string, unknown>> {
	const rng = new SeededRandom(options.seed)
	const kenAll = (await loadKenAllPostcodes(options.kenAll)).municipality

	console.log(`KEN_ALL municipalities: ${kenAll.size}`)

	const { pool, board } = await fillReservoirs(options, rng)
	const splits = drawSplits(options, pool, rng)
	const join = { hit: 0, miss: 0 }
	const postcodeOf = (row: JPProbeSource) => kenAll.get(normalizeCJKText(row.pref + row.muni)) ?? null

	for (const [split, rows] of Object.entries(splits)) {
		const encoded = rows.map((row) => {
			let postcode: string | null = null

			if (rng.random() < options.postcodeFraction) {
				postcode = postcodeOf(row)

				if (postcode) {
					join.hit++
				} else {
					join.miss++
				}
			}

			return renderProbeRow(row.pref, row.muni, row.street, row.number, postcode)
		})

		await writeColumnParquetFile(
			await stampRowLicenses(encoded, "JP probe corpus"),
			JP_PROBE_COLUMNS,
			resolvePath(options.outDir, split, "part-0000.parquet")
		)

		const allO = encoded.filter((record) => !record.span_tags.length).length

		if (allO) throw new Error(`${split}: ${allO} all-O rows — corpus build broken`)

		console.log(`${split}: ${encoded.length} rows`)
	}

	const { prefectures, boardMunicipalities } = checkStratification(splits.train, splits.val, board)

	await writeLocalTextFile(
		board.map((row) => {
			const postcode = postcodeOf(row)

			const rendered = renderProbeRow(
				row.pref,
				row.muni,
				row.street,
				row.number,
				rng.random() < options.postcodeFraction ? postcode : null
			)

			return orderedJSON(
				new Map<string, unknown>([
					["raw", rendered.raw],
					["span_starts", rendered.span_starts],
					["span_ends", rendered.span_ends],
					["span_tags", rendered.span_tags],
					["pref", row.pref],
					["muni", row.muni],
					["street", row.street],
					["number", row.number],
					["lon", row.lon],
					["lat", row.lat],
				])
			)
		}),
		resolvePath(options.outDir, "jp-probe-board.jsonl")
	)

	// Sealed from the train part as written, so no id goes to a character only val or the board holds.
	const trainRows = await readParquetRows<{ raw: string }>(resolvePath(options.outDir, "train", "part-0000.parquet"), {
		columns: ["raw"],
	})

	const vocab = buildCharVocab(
		trainRows.map((row) => row.raw),
		2
	)

	await saveCharVocab(vocab, resolvePath(options.outDir, "char-vocab-jp-v1.json"))

	const counts = [...prefectures.values()]

	const report = new Map<string, unknown>([
		["seed", options.seed],
		["train_rows", splits.train.length],
		["val_rows", splits.val.length],
		["board_rows", board.length],
		["prefectures_train", prefectures.size],
		["prefecture_min_max", [Math.min(...counts), Math.max(...counts)]],
		["board_municipalities", boardMunicipalities.size],
		[
			"kenall_join",
			new Map([
				["hit", join.hit],
				["miss", join.miss],
			]),
		],
		["char_vocab_size", vocab.size],
		["postcode_fraction", options.postcodeFraction],
		["source_parquet", options.parquet],
	])

	await writeLocalTextFile(
		orderedJSON(report, { indent: "\t" }) + "\n",
		resolvePath(options.outDir, "build-report.json")
	)

	return report
}
