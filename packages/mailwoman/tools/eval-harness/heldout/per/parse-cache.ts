/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Parses held-out rows with one weights cache on a pool of worker threads, and keeps the parses so that scoring the
 *   same rows with the same weights at the same commit reads them back rather than parsing again.
 *
 *   A cached parse file is keyed by four values: the inference rule, the rows (identity, text and country of each), a
 *   digest of every file in the weights packages the rows are parsed with, and the commit. A working tree with any
 *   change under `packages/` neither reads nor writes the cache, because the parse depends on source the commit does
 *   not then describe. Inputs outside the weights cache, such as the gazetteer under the data root, are not keyed.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { sortedGlob } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { gitHead, workingTreeStatus } from "@mailwoman/core/git"
import { sha256File, sha256Hex } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { weightsCachePackageDir } from "@mailwoman/neural/weights"
import type { PathBuilderLike } from "path-ts"
import { JSONSpliterator } from "spliterator"

import type { BatterySpan } from "#tools/eval-harness/battery/classify"
import { parseRowsWithWorkers, type ParseRow } from "#tools/eval-harness/battery/parse/rows"
import {
	HELDOUT_INFERENCE_RULE,
	type HeldoutRow,
	heldoutRowID,
	heldoutWeightsLocale,
} from "#tools/eval-harness/heldout/per/country"

/**
 * What a cached parse file was produced from, written beside it as `<key>.key.json`.
 */
export interface HeldoutParseCacheKey {
	inferenceRule: string
	/**
	 * sha256 over each row's identity, text and country, in row order.
	 */
	rows: string
	/**
	 * {@linkcode weightsCacheDigest} of the weights packages the rows are parsed with.
	 */
	weights: string
	commit: string
}

/**
 * The sha256 of every file in each of `locales`' packages under `cacheRoot`,
 * listed by path relative to the package.
 *
 * @throws When a package directory holds no files.
 */
export async function weightsCacheDigest(cacheRoot: PathBuilderLike, locales: Iterable<string>): Promise<string> {
	const lines: string[] = []

	for (const locale of [...new Set(locales)].toSorted()) {
		const directory = weightsCachePackageDir(cacheRoot, locale).toString()
		const files = (await pathExists(directory)) ? await sortedGlob(directory, "**/*") : []

		if (!files.length) throw new Error(`${directory} holds no files`)

		for (const file of files) {
			lines.push(`${locale}\t${file.slice(directory.length + 1)}\t${await sha256File(file)}`)
		}
	}

	return sha256Hex(lines.join("\n"))
}

/**
 * The parse-worker rows for `rows`, each identified by its {@linkcode heldoutRowID}.
 */
export function heldoutParseRows(rows: readonly HeldoutRow[]): ParseRow[] {
	return rows.map((row) => ({ id: heldoutRowID(row), raw: row.raw, country: row.country }))
}

/**
 * Reads a parse file into a map from row identity to spans.
 *
 * @throws When the file lacks a row of `rows`, holds a row twice, or holds a row `rows` lacks.
 */
export async function readHeldoutParses(
	path: string,
	rows: readonly ParseRow[]
): Promise<Map<string, readonly BatterySpan[]>> {
	const parses = new Map<string, readonly BatterySpan[]>()

	for await (const line of JSONSpliterator.fromAsync<{ id: string; spans: BatterySpan[] }>(path)) {
		if (parses.has(line.id)) throw new Error(`${path} holds row ${line.id} twice`)

		parses.set(line.id, line.spans)
	}

	const missing = rows.filter((row) => !parses.has(row.id))

	if (missing.length) {
		throw new Error(`${path} lacks ${missing.length} of ${rows.length} rows, first ${missing[0]!.id}`)
	}

	if (parses.size !== rows.length) {
		throw new Error(`${path} holds ${parses.size} rows; the dataset holds ${rows.length}`)
	}

	return parses
}

export interface HeldoutParseOptions {
	/**
	 * Country to weights locale, as `readHeldoutLocalePackages` reads the release configuration.
	 */
	packages: ReadonlyMap<string, string>
	workers: number
	/**
	 * ONNX intra-op threads per worker.
	 */
	threads: number
	/**
	 * Where cached parse files live, or `null` to parse without the cache.
	 */
	cacheDirectory?: PathBuilderLike | null
}

/**
 * Where the parses came from: the cache file read or written, or `null` with
 * the reason the cache was left unused.
 */
export type HeldoutParseSource =
	| { cache: string; reused: boolean; key: HeldoutParseCacheKey }
	| { cache: null; reason: string }

/**
 * Parses every row with the weights cache at `cacheRoot` and returns each row's spans by row identity.
 */
export async function parseHeldoutRows(
	rows: readonly HeldoutRow[],
	cacheRoot: string,
	options: HeldoutParseOptions
): Promise<{ parses: Map<string, readonly BatterySpan[]>; source: HeldoutParseSource }> {
	const parseRows = heldoutParseRows(rows)
	const pool = { cacheRoot, workers: options.workers, threads: options.threads }

	const cacheDirectory =
		options.cacheDirectory === undefined ? dataRootPath("models", "arms", "heldout-parses") : options.cacheDirectory

	const changed = cacheDirectory ? await workingTreeStatus(undefined, ["packages"]) : []

	if (!cacheDirectory || changed.length) {
		const reason = cacheDirectory
			? `the working tree has ${changed.length} changed paths under packages/, first ${changed[0]!.trim()}`
			: "the cache is turned off"

		await using scratch = await temporaryDirectory("mw-heldout-parse-")
		const out = scratch.path("parses.jsonl").toString()

		console.error(`parsing without the parse cache: ${reason}`)

		await parseRowsWithWorkers(parseRows, out, pool)

		return { parses: await readHeldoutParses(out, parseRows), source: { cache: null, reason } }
	}

	const key: HeldoutParseCacheKey = {
		inferenceRule: HELDOUT_INFERENCE_RULE,
		rows: sha256Hex(parseRows.map((row) => stringifyJSON([row.id, row.raw, row.country])).join("\n")),
		weights: await weightsCacheDigest(
			cacheRoot,
			rows.map((row) => heldoutWeightsLocale(row.country, options.packages))
		),
		commit: await gitHead(),
	}

	const name = sha256Hex(stringifyJSON(key)).slice(0, 16)
	const cache = `${cacheDirectory}/${name}.jsonl`

	if (await pathExists(cache)) {
		console.error(`reading cached parses ${cache}`)

		return { parses: await readHeldoutParses(cache, parseRows), source: { cache, reused: true, key } }
	}

	await makeDirectories(cacheDirectory)
	await parseRowsWithWorkers(parseRows, cache, pool)
	await writeLocalJSONFile({ ...key, cacheRoot }, `${cacheDirectory}/${name}.key.json`)

	return { parses: await readHeldoutParses(cache, parseRows), source: { cache, reused: false, key } }
}
