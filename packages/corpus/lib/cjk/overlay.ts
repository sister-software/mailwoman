/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Assembles a CJK overlay corpus: a JP corpus and further CJK corpora referenced by volume path,
 *   plus the Chinese organizational-unit rows written here, under the `stage3-cjk` head (#2034).
 *
 *   The loader reads a manifest path as written when the file exists, so the JP and extra corpora's
 *   parts are listed by their path under the volume root and never copied. The Chinese rows the
 *   `cn-organizational-units` recipe labels are checked against `stage3-cjk` and written as `train/`
 *   and `val/` parts with register `cn-units`. Its test rows become `cn-board.jsonl`, a held-out set
 *   for the per-tag read. The character vocabulary is the JP vocabulary, every Chinese train character
 *   at a minimum count of one, and each extra corpus's vocabulary, sealed in code-point order.
 *
 *   A span may hold whitespace: a Chinese row's Latin region (`Inner Mongolia`) has a real inner space,
 *   and in character mode the space is its own unit.
 */

import { directoryHasEntries, sortedGlob } from "@mailwoman/core/fs/readers"
import { isDirectory, pathExists } from "@mailwoman/core/fs/readers/stat"
import { makeDirectories, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { countInto, mostCommon } from "@mailwoman/core/stats"
import { pythonJSONDumps } from "@mailwoman/core/strings/python-json"
import { basename, resolvePath } from "path-ts"
import { JSONSpliterator } from "spliterator"

import {
	CJK_LABEL_SET_NAME,
	type CJKRecord,
	loadCharVocab,
	readLabelSetTags,
	saveCharVocab,
	sealCharacters,
	verifyCJKRecord,
	writeCJKCorpusParquet,
} from "#cjk/builder"

/**
 * The corpus source of a Chinese organizational-unit row that names none.
 */
export const CN_UNITS_SOURCE = "coarse-placer-cn-units"

/**
 * The register every Chinese organizational-unit row carries.
 */
export const CN_UNITS_REGISTER = "cn-units"

/**
 * The JP corpus version the first overlay referenced.
 */
export const OVERLAY_JP_VERSION = "v8-jp-full-2026-08-04"

/**
 * The corpus source the JP parts are listed under.
 */
export const OVERLAY_JP_SOURCE = "overture-jp"

const SPLITS = ["train", "val"] as const

/**
 * One row of the `cn-organizational-units` recipe output.
 */
export interface CNUnitsRow {
	raw: string
	tokens: string[]
	labels: string[]
	span_starts: number[]
	span_ends: number[]
	span_tags: string[]
	source?: string | null
}

/**
 * A recipe row as a CJK corpus record with country `CN` and register `cn-units`.
 */
export function toCNRecord(row: CNUnitsRow): CJKRecord {
	return {
		raw: row.raw,
		tokens: [...row.tokens],
		labels: [...row.labels],
		span_starts: row.span_starts.map(Number),
		span_ends: row.span_ends.map(Number),
		span_tags: [...row.span_tags],
		country: "CN",
		source: row.source || CN_UNITS_SOURCE,
		register: CN_UNITS_REGISTER,
	}
}

/**
 * The JP vocabulary's characters plus every character of `cnTexts`, sealed in code-point order.
 */
export function mergeCharVocab(
	jpVocab: Readonly<Record<string, number>>,
	cnTexts: Iterable<string>
): Map<string, number> {
	const characters = new Set(Object.keys(jpVocab))

	for (const text of cnTexts) {
		for (const character of text) {
			characters.add(character)
		}
	}

	return sealCharacters(characters)
}

/**
 * A corpus the overlay references by volume path.
 */
export interface OverlayExtraCorpus {
	directory: string
	source: string
}

/**
 * Options for {@linkcode buildCJKOverlay}.
 */
export interface CJKOverlayOptions {
	jpCorpus: string
	cnTrain: string
	cnVal: string
	cnTest: string
	outDir: string
	/**
	 * The directory the manifest's paths start from.
	 */
	volumeRoot: string
	/**
	 * @defaultValue {@linkcode OVERLAY_JP_VERSION}
	 */
	jpVersion?: string
	force?: boolean
	extraCorpora?: readonly OverlayExtraCorpus[]
}

async function readCNRows(path: string): Promise<CJKRecord[]> {
	if (!(await pathExists(path))) throw new Error(`No CN units JSONL file at ${path}`)

	return (await Array.fromAsync(JSONSpliterator.fromAsync<CNUnitsRow>(path))).map(toCNRecord)
}

async function splitParts(corpus: string, split: string): Promise<string[]> {
	const directory = resolvePath(corpus, split)

	if (!(await isDirectory(directory))) return []

	return (await sortedGlob(directory, "*.parquet")).map((path) => basename(path))
}

async function partNames(corpus: string): Promise<Record<(typeof SPLITS)[number], string[]>> {
	const train = await splitParts(corpus, "train")
	const val = await splitParts(corpus, "val")

	if (!train.length || !val.length) throw new Error(`${corpus} holds no train/val parquet parts`)

	return { train, val }
}

async function firstCharVocab(corpus: string): Promise<string> {
	const [path] = await sortedGlob(corpus, "char-vocab-*.json")

	if (!path) throw new Error(`${corpus} holds no char-vocab-*.json`)

	return path
}

/**
 * Writes the overlay's parts, board, vocabulary, manifest and build report, and returns the report.
 *
 * @throws When `outDir` holds a file and `force` is unset, an input is missing or empty,
 * a part list is empty, or a Chinese row fails the `stage3-cjk` record check.
 */
export async function buildCJKOverlay(options: CJKOverlayOptions): Promise<Map<string, unknown>> {
	const { jpCorpus, outDir, volumeRoot } = options
	const jpVersion = options.jpVersion ?? OVERLAY_JP_VERSION
	const extraCorpora = options.extraCorpora ?? []

	if (!options.force && (await directoryHasEntries(outDir))) {
		throw new Error(`${outDir} is not empty; pass --force to overwrite`)
	}

	for (const split of SPLITS) {
		await makeDirectories(resolvePath(outDir, split))
	}

	const tagSet = await readLabelSetTags(CJK_LABEL_SET_NAME)
	const jpParts = await partNames(jpCorpus)
	const counts = new Map<string, number>()
	const tagCounts = new Map<string, number>()
	const sources = { train: options.cnTrain, val: options.cnVal }
	const trainRaws: string[] = []

	for (const split of SPLITS) {
		const records = await readCNRows(sources[split])

		for (const record of records) {
			verifyCJKRecord(record, tagSet)

			for (const tag of record.span_tags) {
				countInto(tagCounts, tag)
			}
		}

		if (!records.length) throw new Error(`${sources[split]} holds no rows`)

		await writeCJKCorpusParquet(records, resolvePath(outDir, split, "cn-units-0000.parquet"), "CJK overlay build")
		counts.set(split, records.length)

		if (split === "train") {
			trainRaws.push(...records.map((record) => record.raw))
		}
	}

	const board = await readCNRows(options.cnTest)

	for (const record of board) {
		verifyCJKRecord(record, tagSet)
	}

	await writeLocalTextFile(
		board.map((record) => pythonJSONDumps(record, { ensureASCII: false })),
		resolvePath(outDir, "cn-board.jsonl")
	)

	const jpVocab = await loadCharVocab(await firstCharVocab(jpCorpus))
	let vocab = mergeCharVocab(jpVocab, trainRaws)
	const extraParts = new Map<string, { train: string[]; val: string[]; source: string }>()
	const extraVocabSizes = new Map<string, number>()

	for (const extra of extraCorpora) {
		const parts = await partNames(extra.directory)
		const extraVocab = await loadCharVocab(await firstCharVocab(extra.directory))

		extraVocabSizes.set(extra.source, Object.keys(extraVocab).length)
		vocab = sealCharacters([...vocab.keys(), ...Object.keys(extraVocab)])
		extraParts.set(basename(extra.directory), { ...parts, source: extra.source })
	}

	await saveCharVocab(vocab, resolvePath(outDir, "char-vocab-cjk.json"))

	const corpusName = basename(outDir)

	const entry = (path: string, split: string, source: string) =>
		new Map([
			["path", path],
			["split", split],
			["source", source],
		])

	const entries = [
		...SPLITS.flatMap((split) =>
			jpParts[split].map((name) => entry(`${volumeRoot}/${jpVersion}/${split}/${name}`, split, OVERLAY_JP_SOURCE))
		),
		...SPLITS.map((split) =>
			entry(`${volumeRoot}/${corpusName}/${split}/cn-units-0000.parquet`, split, CN_UNITS_SOURCE)
		),
		...[...extraParts].flatMap(([version, parts]) =>
			SPLITS.flatMap((split) =>
				parts[split].map((name) => entry(`${volumeRoot}/${version}/${split}/${name}`, split, parts.source))
			)
		),
	]

	const manifest = new Map<string, unknown>([
		["corpus_version", corpusName],
		["base_corpus_version", jpVersion],
		["label_set", CJK_LABEL_SET_NAME],
		[
			"note",
			"Overlay: the full JP corpus referenced by volume path plus the CN organizational-unit parts written here. " +
				"The loader takes each path as-is when it exists; on the volume both do.",
		],
		["files", entries],
	])

	await writeLocalTextFile(
		pythonJSONDumps(manifest, { indent: 2, ensureASCII: false }) + "\n",
		resolvePath(outDir, "MANIFEST.json")
	)

	const report = new Map<string, unknown>([
		["label_set", CJK_LABEL_SET_NAME],
		["base_corpus", jpCorpus],
		["base_version", jpVersion],
		["jp_parts", jpParts],
		[
			"cn_rows",
			new Map([
				["train", counts.get("train")],
				["val", counts.get("val")],
				["board", board.length],
			]),
		],
		["cn_span_tags", new Map(mostCommon(tagCounts))],
		["char_vocab", new Map([["jp", Object.keys(jpVocab).length], ...extraVocabSizes, ["cjk", vocab.size]])],
		["extra_corpora", new Map([...extraParts].map(([version, parts]) => [version, parts.source]))],
		["cn_sources", [options.cnTrain, options.cnVal, options.cnTest]],
	])

	await writeLocalTextFile(
		pythonJSONDumps(report, { indent: 2, ensureASCII: false }) + "\n",
		resolvePath(outDir, "build-report.json")
	)

	return report
}
