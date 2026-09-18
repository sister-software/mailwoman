/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pre-compute corpus-wide token + bigram label distributions for the corpus linter.
 *
 *   Reads one or more parquet files, builds per-(token, label) and per-(bigram, label-bigram)
 *   histograms, and serializes them as JSON. The output file is consumed by `lint/recipe-output/index.ts`
 *   as the baseline against which a new recipe output is compared.
 *
 *   Stats are cheap to compute (~5–30s per 100K rows) but expensive enough that we cache them between
 *   linter invocations. Re-run this whenever the corpus changes substantially (a new mainline
 *   recipe output added, a source-pool re-weighted, etc.).
 *
 *   Output schema (`slice_paths` is the stats file's own key. a stats file already on disk carries it,
 *   so the linter reads it under that spelling):
 *
 *   ```ts
 *   interface CorpusStats {
 *     row_count: number
 *     slice_paths: string[]
 *     tokens: { [token: string]: { [label: string]: number } }
 *     bigrams: { [token_bigram: string]: { [label_bigram: string]: number } }
 *     // token_bigram = "tok1tok2" (US sep), label_bigram = "lab1lab2"
 *     // For memory: only keep bigrams with count >= MIN_BIGRAM_COUNT (2).
 *   }
 * ```
 *
 *   Usage: mailwoman corpus stats\
 *   --parquet <parquet-file-or-dir>\
 *   --out <stats.json>
 *
 *   For a quick local-corpus baseline (limited but useful for linter testing): mailwoman corpus stats\
 *   --parquet $MAILWOMAN_DATA_ROOT/corpus/versioned/v0.4.0/corpus-v0.4.0/train/\
 *   --out /tmp/corpus-stats-local.json
 */

import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { statPath } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { join } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import { accumulateCooccurrences, createCooccurrenceStats, streamTokenLabelRows } from "#utils/cooccurrence-stats"

const MIN_BIGRAM_COUNT = 2

/**
 * Options for {@linkcode buildCorpusStats}.
 */
export interface CorpusStatsOptions {
	/**
	 * A directory of parquet files, one parquet file, or a literal path.
	 */
	parquetPath: string
	outputPath: string
	/**
	 * Read at most this many rows per parquet file.
	 */
	limitPerFile?: number
}

async function discoverParquetFiles(pathArg: string): Promise<string[]> {
	const stat = await statPath(pathArg)

	if (stat.isDirectory()) {
		const names = await Globerator.files("parquet", { cwd: pathArg, recursive: false }).toSorted()

		return names.map((name) => join(pathArg, name))
	}

	if (stat.isFile() && pathArg.endsWith(".parquet")) return [pathArg]

	// Otherwise treat as a literal path list (one per line if it's stdin-friendly).
	return [pathArg]
}

export async function buildCorpusStats(args: CorpusStatsOptions): Promise<void> {
	const parquetPaths = await discoverParquetFiles(args.parquetPath)

	console.error(`Discovered ${parquetPaths.length} parquet file(s)`)

	const stats = createCooccurrenceStats()
	const { tokens: tokenStats, bigrams: bigramStats } = stats
	let totalRows = 0

	for (const path of parquetPaths) {
		console.error(`Reading ${path}...`)

		const before = totalRows

		for await (const { tokens, labels } of streamTokenLabelRows(path, args.limitPerFile)) {
			totalRows++

			if (tokens.length !== labels.length) continue // skip malformed

			accumulateCooccurrences(stats, tokens, labels)
		}

		console.error(
			`  ${totalRows - before} rows; running totals: ${tokenStats.size} unique tokens, ${bigramStats.size} unique bigrams`
		)
	}

	// Prune bigrams below MIN_BIGRAM_COUNT to keep the output file size sane. Token stats
	// stay complete — they're cheap and we need accuracy at the long tail for label-vacuum
	// detection.
	let prunedBigrams = 0

	for (const [k, labelMap] of bigramStats) {
		let total = 0

		for (const v of labelMap.values()) {
			total += v
		}

		if (total < MIN_BIGRAM_COUNT) {
			bigramStats.delete(k)

			prunedBigrams++
		}
	}

	console.error(`Pruned ${prunedBigrams} singleton bigrams; ${bigramStats.size} remain`)

	const out = {
		row_count: totalRows,
		slice_paths: parquetPaths,
		tokens: {} as Record<string, Record<string, number>>,
		bigrams: {} as Record<string, Record<string, number>>,
	}

	for (const [tk, labelMap] of tokenStats) {
		out.tokens[tk] = Object.fromEntries(labelMap)
	}

	for (const [k, labelMap] of bigramStats) {
		out.bigrams[k] = Object.fromEntries(labelMap)
	}

	await writeLocalJSONFile(out, args.outputPath)
	const formattedSize = ByteFormatter.formatIEC(Buffer.byteLength(stringifyJSON(out)))

	console.error(
		`Wrote ${args.outputPath} (${formattedSize}) — ${totalRows} rows, ${tokenStats.size} tokens, ${bigramStats.size} bigrams`
	)
}
