/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pre-compute corpus-wide token + bigram label distributions for the corpus linter.
 *
 *   Reads one or more Parquet shards, builds per-(token, label) and per-(bigram, label-bigram)
 *   histograms, and serializes them as JSON. The output file is consumed by `lint-corpus-shard.ts`
 *   as the baseline against which a new shard is compared.
 *
 *   Stats are cheap to compute (~5–30s per 100K rows) but expensive enough that we cache them between
 *   linter invocations. Re-run this script whenever the corpus changes substantially (a new
 *   mainline shard added, a source-pool re-weighted, etc.).
 *
 *   Output schema:
 *
 *   ```ts
 *   interface CorpusStats {
 *     row_count: number
 *     shard_paths: string[]
 *     tokens: { [token: string]: { [label: string]: number } }
 *     bigrams: { [token_bigram: string]: { [label_bigram: string]: number } }
 *     // token_bigram = "tok1tok2" (US sep), label_bigram = "lab1lab2"
 *     // For memory: only keep bigrams with count >= MIN_BIGRAM_COUNT (2).
 *   }
 * ```
 *
 *   Usage: node --experimental-strip-types scripts/build-corpus-stats.ts\
 *   --shards <glob-pattern-or-dir>\
 *   --output <stats.json>
 *
 *   For a quick local-corpus baseline (limited but useful for linter testing): node
 *   --experimental-strip-types scripts/build-corpus-stats.ts\
 *   --shards /mnt/playpen/mailwoman-data/corpus/versioned/v0.4.0/corpus-v0.4.0/train/\
 *   --output /tmp/corpus-stats-local.json
 */

import { execSync } from "node:child_process"
import { readdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const SEP = ""
const MIN_BIGRAM_COUNT = 2

interface Args {
	shardsArg: string
	outputPath: string
	limitPerShard?: number
}

function parseArgs(): Args {
	const args = process.argv.slice(2)
	const out: Partial<Args> = {}

	for (let i = 0; i < args.length; i++) {
		const a = args[i]

		if (a === "--shards" && args[i + 1]) {
			out.shardsArg = args[++i]
		} else if (a === "--output" && args[i + 1]) {
			out.outputPath = args[++i]
		} else if (a === "--limit-per-shard" && args[i + 1]) {
			out.limitPerShard = Number(args[++i])
		}
	}

	if (!out.shardsArg || !out.outputPath) {
		console.error("Usage: build-corpus-stats.ts --shards <dir-or-glob> --output <stats.json>")
		process.exit(1)
	}

	return out as Args
}

function discoverShards(shardsArg: string): string[] {
	const stat = statSync(shardsArg)

	if (stat.isDirectory()) {
		return readdirSync(shardsArg)
			.filter((f) => f.endsWith(".parquet"))
			.map((f) => join(shardsArg, f))
	}

	if (stat.isFile() && shardsArg.endsWith(".parquet")) return [shardsArg]

	// Otherwise treat as a literal path list (one per line if it's stdin-friendly).
	return [shardsArg]
}

/**
 * Use a Python subprocess to read parquet (pyarrow is heavier than parquet-wasm but already on the path here, and we
 * have nothing in the JS ecosystem that reads parquet cleanly at this scale). Emits one JSON object per line: `{tokens:
 * [...], labels: [...]}`.
 */
function streamShardRows(shardPath: string, limit?: number): Array<{ tokens: string[]; labels: string[] }> {
	// Pipe the python script via stdin instead of `-c` to preserve newlines verbatim
	// (JSON-encoding the script for -c collapses real newlines into literal `\n`).
	const py = `
import pyarrow.parquet as pq
import json, sys
t = pq.read_table(${JSON.stringify(shardPath)}, columns=['tokens', 'labels'])
tokens_col = t['tokens'].to_pylist()
labels_col = t['labels'].to_pylist()
n = min(len(tokens_col), ${limit ?? "len(tokens_col)"})
for i in range(n):
    sys.stdout.write(json.dumps({"tokens": tokens_col[i], "labels": labels_col[i]}) + "\\n")
`
	const buf = execSync(`python3`, { input: py, maxBuffer: 1024 * 1024 * 1024 })
	const rows: Array<{ tokens: string[]; labels: string[] }> = []

	for (const line of buf.toString("utf8").split("\n")) {
		if (!line) continue
		rows.push(JSON.parse(line))
	}

	return rows
}

function main(): void {
	const args = parseArgs()
	const shardPaths = discoverShards(args.shardsArg)
	console.error(`Discovered ${shardPaths.length} parquet shard(s)`)

	const tokenStats = new Map<string, Map<string, number>>()
	const bigramStats = new Map<string, Map<string, number>>()
	let totalRows = 0

	for (const path of shardPaths) {
		console.error(`Reading ${path}...`)
		const rows = streamShardRows(path, args.limitPerShard)
		totalRows += rows.length

		for (const row of rows) {
			const { tokens, labels } = row

			if (tokens.length !== labels.length) continue

			// skip malformed
			for (let i = 0; i < tokens.length; i++) {
				const tk = tokens[i]!
				const lb = labels[i]!
				let labelMap = tokenStats.get(tk)

				if (!labelMap) {
					labelMap = new Map()
					tokenStats.set(tk, labelMap)
				}
				labelMap.set(lb, (labelMap.get(lb) ?? 0) + 1)

				if (i + 1 < tokens.length) {
					const bigramKey = tk + SEP + tokens[i + 1]!
					const bigramLabel = lb + SEP + labels[i + 1]!
					let bMap = bigramStats.get(bigramKey)

					if (!bMap) {
						bMap = new Map()
						bigramStats.set(bigramKey, bMap)
					}
					bMap.set(bigramLabel, (bMap.get(bigramLabel) ?? 0) + 1)
				}
			}
		}
		console.error(
			`  ${rows.length} rows; running totals: ${tokenStats.size} unique tokens, ${bigramStats.size} unique bigrams`
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
		shard_paths: shardPaths,
		tokens: {} as Record<string, Record<string, number>>,
		bigrams: {} as Record<string, Record<string, number>>,
	}

	for (const [tk, labelMap] of tokenStats) {
		out.tokens[tk] = Object.fromEntries(labelMap)
	}

	for (const [k, labelMap] of bigramStats) {
		out.bigrams[k] = Object.fromEntries(labelMap)
	}

	writeFileSync(args.outputPath, JSON.stringify(out))
	const sizeMB = (Buffer.byteLength(JSON.stringify(out)) / 1024 / 1024).toFixed(1)
	console.error(
		`Wrote ${args.outputPath} (${sizeMB} MB) — ${totalRows} rows, ${tokenStats.size} tokens, ${bigramStats.size} bigrams`
	)
}

main()
