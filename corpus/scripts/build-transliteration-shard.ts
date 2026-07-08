#!/usr/bin/env npx tsx
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build per-script parquet shards from the DeepSeek-generated transliteration JSONL and emit the
 *   corpus-v0.4.0 MANIFEST that combines them with the existing kryptonite + v0.3.0 shards.
 *
 *   Sibling to `build-kryptonite-shard.ts`. The two scripts share the same composition pattern: take
 *   a base MANIFEST, append new shards, write a combined MANIFEST. Differences specific to
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
 *   Usage: npx tsx corpus/scripts/build-transliteration-shard.ts\
 *   --jsonl /data/corpus/versioned/v0.4.0/transliteration/canonical-transliteration.jsonl\
 *   --base-manifest /data/corpus/versioned/v0.4.0/corpus-v0.4.0/MANIFEST.json\
 *   --out-dir /data/corpus/versioned/v0.4.0
 */

///<reference types="node" />

import { createHash } from "node:crypto"
import { createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs"
import { mkdir, stat } from "node:fs/promises"
import { join } from "node:path"

import { cliArguments } from "@mailwoman/core/utils"
import { TextSpliterator } from "spliterator"

import { alignRow } from "../src/align.js"
import { ParquetWriter } from "../src/parquet-wrapper/index.js"
import {
	LABELED_ROW_SCHEMA,
	PARQUET_COLUMNS,
	ROW_GROUP_SIZE,
	rowToParquet,
	SHARD_COMPRESSION,
	type ParquetRow,
	type ShardDescriptor,
	type ShardManifest,
} from "../src/parquet.js"
import type { CanonicalRow, LabeledRow } from "../src/types.js"

interface Args {
	jsonl: string
	baseManifest: string
	outDir: string
	corpusVersion: string
	canonicalPathPrefix: string
	legacyPathPrefix: string
}

function parseArgs(argv: readonly string[]): Args {
	const out: Partial<Args> = {
		corpusVersion: "0.4.0",
		canonicalPathPrefix: "/data/",
		legacyPathPrefix: "/mnt/playpen/mailwoman-data/",
	}

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!
		const next = argv[i + 1]

		switch (a) {
			case "--jsonl":
				out.jsonl = next
				i++
				break
			case "--base-manifest":
				out.baseManifest = next
				i++
				break
			case "--out-dir":
				out.outDir = next
				i++
				break
			case "--corpus-version":
				out.corpusVersion = next ?? out.corpusVersion
				i++
				break
			case "--canonical-path-prefix":
				out.canonicalPathPrefix = next ?? out.canonicalPathPrefix
				i++
				break
			case "--legacy-path-prefix":
				out.legacyPathPrefix = next ?? out.legacyPathPrefix
				i++
				break
			default:
				throw new Error(`unknown arg ${a}`)
		}
	}

	if (!out.jsonl) throw new Error("--jsonl required")

	if (!out.baseManifest) throw new Error("--base-manifest required")

	if (!out.outDir) throw new Error("--out-dir required")

	return out as Args
}

async function* readJsonl(jsonl: string): AsyncIterable<Record<string, unknown>> {
	// JSONL source: each line is JSON.parse'd below, so a trailing CR on CRLF input is harmless
	// whitespace to the parser and the `!line.trim()` guard drops any whitespace-only line.
	for await (const line of TextSpliterator.fromAsync(jsonl)) {
		if (!line.trim()) continue
		yield JSON.parse(line) as Record<string, unknown>
	}
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

async function hashFile(path: string): Promise<string> {
	const hash = createHash("sha256")

	for await (const chunk of createReadStream(path)) {
		hash.update(chunk as Buffer)
	}

	return hash.digest("hex")
}

interface ScriptShardResult {
	source: string
	descriptor: ShardDescriptor
	quarantinedReasons: string[]
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
	const sha256 = await hashFile(outPath)

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

async function main(): Promise<void> {
	const args = parseArgs(cliArguments())

	if (!existsSync(args.jsonl)) throw new Error(`jsonl not found: ${args.jsonl}`)

	if (!existsSync(args.baseManifest)) throw new Error(`base-manifest not found: ${args.baseManifest}`)

	const corpusDir = join(args.outDir, `corpus-v${args.corpusVersion}`)
	const trainDir = join(corpusDir, "train")
	await mkdir(trainDir, { recursive: true })

	// Bucket canonical rows by source. Quarantined rows are logged.
	const buckets = new Map<string, LabeledRow[]>()
	const quarantine: string[] = []
	let totalIn = 0

	for await (const raw of readJsonl(args.jsonl)) {
		totalIn++
		const canon = toCanonicalRow(raw, args.corpusVersion)
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
	console.error(`read ${totalIn} rows; ${quarantine.length} quarantined; ${buckets.size} script buckets`)

	const newShards: ShardDescriptor[] = []
	const sortedKeys = [...buckets.keys()].sort()

	for (const source of sortedKeys) {
		const rows = buckets.get(source)!
		const slug = source.startsWith("deepseek-translit-") ? source.slice("deepseek-translit-".length) : source
		const outPath = join(trainDir, `part-translit-${slug}.parquet`)
		const descriptor = await writeOneShard(rows, outPath, source, args.corpusVersion)
		newShards.push(descriptor)
		console.error(`  ${source}: ${descriptor.rows} rows → ${outPath} (${descriptor.bytes} bytes)`)
	}

	if (quarantine.length > 0) {
		const qPath = join(corpusDir, "quarantine-transliteration.tsv")
		writeFileSync(qPath, quarantine.join("\n") + "\n", "utf8")
		console.error(`quarantine log → ${qPath} (${quarantine.length} rows)`)
	}

	// Compose final MANIFEST: rewrite base.shards paths from /mnt/playpen/... → /data/... and append
	// the new translit shards. Kryptonite shard already lives in the base manifest (it was written
	// there by Thread B).
	const base = JSON.parse(readFileSync(args.baseManifest, "utf8")) as ShardManifest
	const rewrittenBase = base.shards.map((sh) => ({
		...sh,
		path: canonicalizeShardPath(sh.path, args.legacyPathPrefix, args.canonicalPathPrefix),
	}))
	const newTrainRows = newShards.reduce((sum, sh) => sum + sh.rows, 0)
	const combined: ShardManifest = {
		corpus_version: args.corpusVersion,
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
	console.error(`wrote combined manifest → ${combinedPath}`)
	console.error(`  total_rows=${combined.total_rows} (base=${base.total_rows}, added=${newTrainRows})`)
	console.error(`  shards=${combined.shards.length} (base=${base.shards.length}, added=${newShards.length})`)
	console.error(`  compression=${SHARD_COMPRESSION}`)
	const pathFix = rewrittenBase.filter((s, i) => s.path !== base.shards[i]!.path).length

	if (pathFix > 0) {
		console.error(
			`  path-canonicalized base shards: ${pathFix} (legacy '${args.legacyPathPrefix}' → '${args.canonicalPathPrefix}')`
		)
	}
}

main().catch((err) => {
	console.error(`fatal: ${err instanceof Error ? err.stack : err}`)
	process.exit(1)
})
