/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pre-compute corpus-wide token + bigram label distributions for the corpus linter.
 *
 *   Reads one or more Parquet slices, builds per-(token, label) and per-(bigram, label-bigram)
 *   histograms, and serializes them as JSON. The output file is consumed by `lint-corpus-slice.ts`
 *   as the baseline against which a new slice is compared.
 *
 *   Stats are cheap to compute (~5–30s per 100K rows) but expensive enough that we cache them between
 *   linter invocations. Re-run this script whenever the corpus changes substantially (a new
 *   mainline slice added, a source-pool re-weighted, etc.).
 *
 *   Output schema:
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
 *   Usage: node scripts/build-corpus-stats.ts\
 *   --slices <glob-pattern-or-dir>\
 *   --output <stats.json>
 *
 *   For a quick local-corpus baseline (limited but useful for linter testing): node
 *   scripts/build-corpus-stats.ts\
 *   --slices $MAILWOMAN_DATA_ROOT/corpus/versioned/v0.4.0/corpus-v0.4.0/train/\
 *   --output /tmp/corpus-stats-local.json
 */

import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { readDirectory, statPath } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { join } from "path-ts"

import { accumulateCooccurrences, createCooccurrenceStats, streamTokenLabelRows } from "#utils/slice-stats"

const MIN_BIGRAM_COUNT = 2

export interface CorpusStatsOptions {
	slicesArg: string
	outputPath: string
	limitPerSlice?: number
}

async function discoverSlices(slicesArg: string): Promise<string[]> {
	const stat = await statPath(slicesArg)

	if (stat.isDirectory()) {
		return (await readDirectory(slicesArg)).filter((f) => f.endsWith(".parquet")).map((f) => join(slicesArg, f))
	}

	if (stat.isFile() && slicesArg.endsWith(".parquet")) return [slicesArg]

	// Otherwise treat as a literal path list (one per line if it's stdin-friendly).
	return [slicesArg]
}

export async function buildCorpusStats(args: CorpusStatsOptions): Promise<void> {
	const slicePaths = await discoverSlices(args.slicesArg)

	console.error(`Discovered ${slicePaths.length} parquet slice(s)`)

	const stats = createCooccurrenceStats()
	const { tokens: tokenStats, bigrams: bigramStats } = stats
	let totalRows = 0

	for (const path of slicePaths) {
		console.error(`Reading ${path}...`)

		const before = totalRows

		for await (const { tokens, labels } of streamTokenLabelRows(path, args.limitPerSlice)) {
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
		slice_paths: slicePaths,
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
	const formattedSize = ByteFormatter.formatIEC(Buffer.byteLength(JSON.stringify(out)))

	console.error(
		`Wrote ${args.outputPath} (${formattedSize}) — ${totalRows} rows, ${tokenStats.size} tokens, ${bigramStats.size} bigrams`
	)
}
