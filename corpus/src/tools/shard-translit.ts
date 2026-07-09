/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build per-script parquet shards from the DeepSeek-generated transliteration JSONL and emit the
 *   corpus-v0.4.0 MANIFEST that combines them with the existing kryptonite + v0.3.0 shards.
 *
 *   Sibling to `shard-kryptonite.ts`. The two modules share the same composition pattern: take a
 *   base MANIFEST, append new shards, write a combined MANIFEST. Differences specific to
 *   transliteration:
 *
 *   - One JSONL contains rows from N target scripts (source = `deepseek-translit-<slug>`). We bucket by
 *       `source` and write one shard per script so `audit.ts` can attribute each shard to its
 *       synthetic source without relying on filename-prefix inference.
 *   - Each shard is written to `train/part-translit-<slug>.parquet` (distinct from kryptonite's
 *       `part-0000.parquet`, which v0.4.0's first builder already produced).
 *   - Inherits the path-canonicalization fix flagged in Thread B's postmortem: v0.3.0 shard paths are
 *       rewritten from `/mnt/playpen/mailwoman-data/...` to `/data/...` in the combined MANIFEST so
 *       all paths share one container-friendly form.
 *
 *   See docs/articles/plan/reference/CORPUS_V0_4_0_GENERATION.md for prompts, model, and the
 *   reproducibility contract.
 *
 *   Invoke via `mailwoman corpus shard translit \
 *   --jsonl /data/corpus/versioned/v0.4.0/transliteration/canonical-transliteration.jsonl \
 *   --base-manifest /data/corpus/versioned/v0.4.0/corpus-v0.4.0/MANIFEST.json \
 *   --out-dir /data/corpus/versioned/v0.4.0`
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { mkdir, stat } from "node:fs/promises"
import { join } from "node:path"

import { iterateJSONL, sha256File } from "@mailwoman/core/utils"

import { alignRow } from "../align.ts"
import { ParquetWriter } from "../parquet-wrapper/index.ts"
import type { ParquetRow, ShardDescriptor, ShardManifest } from "../parquet.ts"
import { LABELED_ROW_SCHEMA, PARQUET_COLUMNS, ROW_GROUP_SIZE, rowToParquet, SHARD_COMPRESSION } from "../parquet.ts"
import type { CanonicalRow, LabeledRow } from "../types.ts"

export interface ShardTranslitOptions {
	jsonl: string
	baseManifest: string
	outDir: string
	/** Default `"0.4.0"`. */
	corpusVersion?: string
	/** Default `"/data/"`. */
	canonicalPathPrefix?: string
	/** Default `"/mnt/playpen/mailwoman-data/"`. */
	legacyPathPrefix?: string
}

function toCanonicalRow(raw: Record<string, unknown>, corpusVersion: string): CanonicalRow {
	return {
		raw: raw["raw"] as string,
		components: raw["components"] as Record<string, string>,
		country: (raw["country"] as string) ?? "US",
		locale: (raw["locale"] as string) ?? undefined,
		source: raw["source"] as string,
		source_id: raw["source_id"] as string,
		corpus_version: corpusVersion,
		license: (raw["license"] as string) ?? "Synthetic (DeepSeek-v4-flash, AGPL-compatible)",
		synth: raw["synth"] as CanonicalRow["synth"],
	}
}

function appendShape(row: ParquetRow): Record<string, unknown> {
	const out: Record<string, unknown> = {
		raw: row.raw,
		tokens: row.tokens,
		labels: row.labels,
		country: row.country,
		source: row.source,
		source_id: row.source_id,
		corpus_version: row.corpus_version,
		license: row.license,
	}

	if (row.locale !== null) {
		out.locale = row.locale
	}

	if (row.synth_method !== null) {
		out.synth_method = row.synth_method
	}

	if (row.synth_base_id !== null) {
		out.synth_base_id = row.synth_base_id
	}

	return out
}

/**
 * Write one shard for a single source slug. Returns the populated ShardDescriptor + a list of quarantine reasons for
 * rows that failed alignment.
 */
async function writeOneShard(
	rows: readonly LabeledRow[],
	outPath: string,
	source: string,
	corpusVersion: string
): Promise<ShardDescriptor> {
	const writer = await ParquetWriter.openFile<ParquetRow>(LABELED_ROW_SCHEMA, outPath, {
		rowGroupSize: ROW_GROUP_SIZE,
	})
	writer.setMetadata("mailwoman.corpus_version", corpusVersion)
	writer.setMetadata("mailwoman.split", "train")
	writer.setMetadata("mailwoman.shard_source", source)

	let firstSourceID = ""
	let lastSourceID = ""

	for (const row of rows) {
		const pq = rowToParquet(row)
		await writer.appendRow(appendShape(pq) as unknown as ParquetRow)

		if (firstSourceID === "") {
			firstSourceID = row.source_id
		}
		lastSourceID = row.source_id
	}
	await writer.close()

	const fileStat = await stat(outPath)
	const sha256 = await sha256File(outPath)

	return {
		split: "train",
		path: outPath,
		format: "parquet",
		compression: SHARD_COMPRESSION,
		rows: rows.length,
		bytes: fileStat.size,
		sha256,
		first_source_id: firstSourceID,
		last_source_id: lastSourceID,
		// Stamp source so audit.ts attributes the shard without falling back to filename-prefix
		// inference. Cast widens ShardDescriptor; the field is read by audit.ts.
		...({ source } as Record<string, string>),
	}
}

function canonicalizeShardPath(path: string, legacyPrefix: string, canonicalPrefix: string): string {
	if (path.startsWith(legacyPrefix)) return canonicalPrefix + path.slice(legacyPrefix.length)

	return path
}

export async function buildTranslitShard(
	options: ShardTranslitOptions,
	report?: (line: string) => void
): Promise<void> {
	const corpusVersion = options.corpusVersion ?? "0.4.0"
	const canonicalPathPrefix = options.canonicalPathPrefix ?? "/data/"
	const legacyPathPrefix = options.legacyPathPrefix ?? "/mnt/playpen/mailwoman-data/"

	if (!existsSync(options.jsonl)) throw new Error(`jsonl not found: ${options.jsonl}`)

	if (!existsSync(options.baseManifest)) throw new Error(`base-manifest not found: ${options.baseManifest}`)

	const corpusDir = join(options.outDir, `corpus-v${corpusVersion}`)
	const trainDir = join(corpusDir, "train")
	await mkdir(trainDir, { recursive: true })

	// Bucket canonical rows by source. Quarantined rows are logged.
	const buckets = new Map<string, LabeledRow[]>()
	const quarantine: string[] = []
	let totalIn = 0

	for await (const raw of iterateJSONL<Record<string, unknown>>(options.jsonl)) {
		totalIn++
		const canon = toCanonicalRow(raw, corpusVersion)
		const result = alignRow(canon)

		if (result.kind !== "labeled") {
			quarantine.push(`${canon.source_id}\t${result.row.reason}`)
			continue
		}
		const bucket = buckets.get(canon.source)

		if (bucket) {
			bucket.push(result.row)
		} else {
			buckets.set(canon.source, [result.row])
		}
	}
	report?.(`read ${totalIn} rows; ${quarantine.length} quarantined; ${buckets.size} script buckets`)

	const newShards: ShardDescriptor[] = []
	const sortedKeys = [...buckets.keys()].sort()

	for (const source of sortedKeys) {
		const rows = buckets.get(source)!
		const slug = source.startsWith("deepseek-translit-") ? source.slice("deepseek-translit-".length) : source
		const outPath = join(trainDir, `part-translit-${slug}.parquet`)
		const descriptor = await writeOneShard(rows, outPath, source, corpusVersion)
		newShards.push(descriptor)
		report?.(`  ${source}: ${descriptor.rows} rows → ${outPath} (${descriptor.bytes} bytes)`)
	}

	if (quarantine.length > 0) {
		const qPath = join(corpusDir, "quarantine-transliteration.tsv")
		writeFileSync(qPath, quarantine.join("\n") + "\n", "utf8")
		report?.(`quarantine log → ${qPath} (${quarantine.length} rows)`)
	}

	// Compose final MANIFEST: rewrite base.shards paths from /mnt/playpen/... → /data/... and append
	// the new translit shards. Kryptonite shard already lives in the base manifest (it was written
	// there by Thread B).
	const base = JSON.parse(readFileSync(options.baseManifest, "utf8")) as ShardManifest
	const rewrittenBase = base.shards.map((sh) => ({
		...sh,
		path: canonicalizeShardPath(sh.path, legacyPathPrefix, canonicalPathPrefix),
	}))
	const newTrainRows = newShards.reduce((sum, sh) => sum + sh.rows, 0)
	const combined: ShardManifest = {
		corpus_version: corpusVersion,
		schema: PARQUET_COLUMNS,
		rows_per_shard: base.rows_per_shard,
		row_group_size: base.row_group_size ?? ROW_GROUP_SIZE,
		shards: [...rewrittenBase, ...newShards],
		counts: {
			train: base.counts.train + newTrainRows,
			val: base.counts.val,
			test: base.counts.test,
		},
		total_rows: base.total_rows + newTrainRows,
	}

	const combinedPath = join(corpusDir, "MANIFEST.json")
	writeFileSync(combinedPath, JSON.stringify(combined, null, 2) + "\n", "utf8")
	report?.(`wrote combined manifest → ${combinedPath}`)
	report?.(`  total_rows=${combined.total_rows} (base=${base.total_rows}, added=${newTrainRows})`)
	report?.(`  shards=${combined.shards.length} (base=${base.shards.length}, added=${newShards.length})`)
	report?.(`  compression=${SHARD_COMPRESSION}`)
	const pathFix = rewrittenBase.filter((s, i) => s.path !== base.shards[i]!.path).length

	if (pathFix > 0) {
		report?.(`  path-canonicalized base shards: ${pathFix} (legacy '${legacyPathPrefix}' → '${canonicalPathPrefix}')`)
	}
}
