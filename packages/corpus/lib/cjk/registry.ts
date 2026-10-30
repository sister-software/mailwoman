/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Builds a noisy registry corpus for Taiwan (GCIS) or Japan (法人番号) from the typed addresses of a company
 *   register, aligned against the label corpus's key sets and kept only where the whole key matches (#2204 §5).
 *
 *   The alignment rate is measured over every string and written to the build report. A string that does not align
 *   is a board row, never a training row. Hold-out follows the label corpus of the same locale: Taiwan holds out a
 *   (縣市, 鄉鎮市區) unit by its hash bucket, Japan a municipality.
 *
 *   Ported from the Python builders' `corpora/registry.py`. The draws are its draws: one {@linkcode PyRandom} seeded
 *   with the seed runs the two exact selectors and the shuffle, and Japan's postcode coin draws from a second one
 *   seeded `<seed>-postcode`, one draw per register row.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { directoryHasEntries } from "@mailwoman/core/fs/readers"
import { makeDirectories, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { orderedJSON } from "@mailwoman/core/json"
import { countInto, mostCommon } from "@mailwoman/core/stats"
import { type PathBuilderLike, resolvePath } from "path-ts"

import {
	CJK_LABEL_SET_NAME,
	type CJKRecord,
	coverageStats,
	muniBucket,
	nextSelection,
	readLabelSetTags,
	sealCharVocab,
	selectExact,
	verifyCJKRecord,
	writeCJKCorpusParquet,
} from "#cjk/builder"
import { normalizeCJKText } from "#cjk/text"
import {
	alignCorporateRow,
	iterCorporateRows,
	JP_BOARD_BUCKET_MIN,
	JP_REGISTRY_SOURCE,
	JPKeyIndex,
	jpRegistryRecord,
} from "#jp/registers"
import { PyRandom } from "#training/pyrandom"
import {
	alignRegisterAddress,
	iterTWRegisterRows,
	TW_BOARD_BUCKET_MIN,
	TW_REGISTRY_SOURCE,
	TWKeyIndex,
	twRegistryRecord,
} from "#tw/registers"

/**
 * The Overture release the key indexes are built from.
 */
const OVERTURE_RELEASE = "2026-06-17.0"

/**
 * One aligned string with its hold-out unit, or `null` for a string that did
 * not align, beside the typed text.
 */
type Candidate = readonly [aligned: readonly [record: CJKRecord, unit: string] | null, text: string]

/**
 * Options for {@linkcode buildRegistryCorpus}, named as the Python builder's flags.
 */
export interface RegistryCorpusOptions {
	locale: RegistryLocale
	outDir: PathBuilderLike
	rows: number
	valFraction: number
	boardRows: number
	/**
	 * Japan: the share of rows rendered with a 〒 prefix.
	 */
	postcodeFraction: number
	rowsPerPart: number
	statsSample: number
	/**
	 * A smoke build's key index reads only this many row groups.
	 */
	maxRowGroups?: number
	seed: number
	force: boolean
}

interface RegistryLocaleSpec {
	source: string
	bucketMin: number
	part: string
	board: string
	vocab: string
	candidates: (options: RegistryCorpusOptions) => Promise<() => AsyncGenerator<Candidate>>
}

async function* twCandidates(index: TWKeyIndex): AsyncGenerator<Candidate> {
	for await (const row of iterTWRegisterRows(dataRootPath("corpus", "sources", TW_REGISTRY_SOURCE))) {
		for (const text of [row.address, row.taxAddress]) {
			if (!text) continue

			const aligned = alignRegisterAddress(text, index)

			yield aligned
				? [[twRegistryRecord(aligned), normalizeCJKText(`${aligned.region}|${aligned.district}`)], text]
				: [null, text]
		}
	}
}

/**
 * The nationwide corporate-number file the Japanese registry corpus reads.
 */
export function houjinZipPath() {
	return dataRootPath("corpus", "sources", JP_REGISTRY_SOURCE, "00_zenkoku_all_20260831.zip")
}

async function* jpCandidates(index: JPKeyIndex, rng: PyRandom, postcodeFraction: number): AsyncGenerator<Candidate> {
	for await (const row of iterCorporateRows(houjinZipPath())) {
		const aligned = alignCorporateRow(row, index, rng.random() < postcodeFraction)
		const text = `${row.prefecture}${row.municipality}${row.street}`

		yield aligned ? [[jpRegistryRecord(aligned), aligned.municipality], text] : [null, text]
	}
}

/**
 * Each locale's source, hold-out bucket, output names and candidate stream.
 */
export const REGISTRY_LOCALES = {
	jp: {
		source: JP_REGISTRY_SOURCE,
		bucketMin: JP_BOARD_BUCKET_MIN,
		part: "jp-registry",
		board: "jp-registry-board.jsonl",
		vocab: "char-vocab-jp-registry.json",
		candidates: async (options) => {
			const index = await JPKeyIndex.fromParquet(
				dataRootPath("overture", OVERTURE_RELEASE, "addresses-jp.parquet"),
				options.maxRowGroups
			)

			// A separate stream for the postcode coin: drawn in lockstep with the selector,
			// a selected row (draw < 0.12) would always be a postcode row (draw < 0.3).
			return () => jpCandidates(index, new PyRandom(`${options.seed}-postcode`), options.postcodeFraction)
		},
	},
	tw: {
		source: TW_REGISTRY_SOURCE,
		bucketMin: TW_BOARD_BUCKET_MIN,
		part: "tw-registry",
		board: "tw-registry-board.jsonl",
		vocab: "char-vocab-tw-registry.json",
		candidates: async (options) => {
			const index = await TWKeyIndex.fromParquet(
				dataRootPath("overture", OVERTURE_RELEASE, "addresses-tw.parquet"),
				options.maxRowGroups
			)

			return () => twCandidates(index)
		},
	},
} as const satisfies Record<string, RegistryLocaleSpec>

/**
 * A locale the registry builder reads.
 */
export type RegistryLocale = keyof typeof REGISTRY_LOCALES

/**
 * Builds the corpus, its board and its character vocabulary under `outDir`, and returns the build report.
 *
 * @throws When `outDir` holds files and `force` is unset, or a register input is missing.
 */
export async function buildRegistryCorpus(options: RegistryCorpusOptions): Promise<Map<string, unknown>> {
	const rng = new PyRandom(options.seed)
	const tagSet = await readLabelSetTags(CJK_LABEL_SET_NAME)
	const locale: RegistryLocaleSpec = REGISTRY_LOCALES[options.locale]
	const outDir = resolvePath(options.outDir)

	if ((await directoryHasEntries(outDir)) && !options.force) {
		throw new Error(`${outDir.toString()} exists and is non-empty — pass --force to overwrite`)
	}

	const candidates = await locale.candidates(options)

	console.log(`index built for ${options.locale}`)

	// Pass 1 is the census.
	// Pass 2 draws the exact selection against the counts pass 1 measured.
	const counts = new Map<string, number>()

	for await (const [aligned] of candidates()) {
		if (!aligned) {
			countInto(counts, "unaligned")
		} else if (muniBucket(aligned[1]) >= locale.bucketMin) {
			countInto(counts, "held_out")
		} else {
			countInto(counts, "aligned")
		}
	}

	const count = (key: string) => counts.get(key) ?? 0
	let total = 0

	for (const n of counts.values()) {
		total += n
	}

	const alignmentRate = (count("aligned") + count("held_out")) / Math.max(total, 1)

	console.log(`pass 1: ${total.toLocaleString("en-US")} strings · alignment ${alignmentRate.toFixed(4)}`)

	const trainSelector = selectExact(count("aligned"), options.rows, rng)
	const boardSelector = selectExact(count("held_out") + count("unaligned"), options.boardRows, rng)
	const rows: CJKRecord[] = []
	const board: Array<Record<string, unknown>> = []
	const tags = new Map<string, number>()

	for await (const [aligned, text] of candidates()) {
		if (!aligned) {
			if (nextSelection(boardSelector)) {
				board.push({ raw: text, aligned: false })
			}

			continue
		}

		const [record, unit] = aligned

		if (muniBucket(unit) >= locale.bucketMin) {
			if (nextSelection(boardSelector)) {
				board.push({
					raw: record.raw,
					span_starts: record.span_starts,
					span_ends: record.span_ends,
					span_tags: record.span_tags,
					aligned: true,
					unit,
				})
			}
		} else if (nextSelection(trainSelector)) {
			verifyCJKRecord(record, tagSet)

			for (const tag of record.span_tags) {
				countInto(tags, tag)
			}

			rows.push(record)
		}
	}

	rng.shuffle(rows)

	const valRows = Math.max(1, Math.trunc(rows.length * options.valFraction))
	const splits = new Map<string, unknown>()

	for (const [split, subset] of [
		["train", rows.slice(valRows)],
		["val", rows.slice(0, valRows)],
	] as const) {
		await makeDirectories(resolvePath(outDir, split))

		let part = 0

		for (let start = 0; start < subset.length; start += options.rowsPerPart) {
			const name = `${locale.part}-${String(part).padStart(4, "0")}.parquet`

			await writeCJKCorpusParquet(
				subset.slice(start, start + options.rowsPerPart),
				resolvePath(outDir, split, name),
				"registry corpus build"
			)

			part++
		}

		splits.set(split, {
			rows: subset.length,
			parts: part,
			coverage: coverageStats(subset.slice(0, options.statsSample)),
		})

		console.log(`${split}: ${subset.length.toLocaleString("en-US")} rows in ${part} parts`)
	}

	await writeLocalTextFile(
		board.map((entry) => orderedJSON(entry)),
		resolvePath(outDir, locale.board)
	)

	const vocab = await sealCharVocab(outDir, locale.vocab)

	const report = new Map<string, unknown>([
		["locale", options.locale],
		["source", locale.source],
		["label_set", CJK_LABEL_SET_NAME],
		["seed", options.seed],
		["alignment_census", counts],
		["alignment_rate", alignmentRate],
		["board_bucket_min", locale.bucketMin],
		["span_tags", new Map(mostCommon(tags))],
		["splits", splits],
		["board_rows", board.length],
		["char_vocab_size", vocab.size],
	])

	await writeLocalTextFile(orderedJSON(report, { indent: "\t" }) + "\n", resolvePath(outDir, "build-report.json"))

	return report
}
