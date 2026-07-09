/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build a parquet shard from the DeepSeek-generated kryptonite JSONL and emit the corpus-v0.4.0
 *   MANIFEST. corpus-v0.4.0 is a pure adapter-addition revision: it points at every shard from
 *   v0.3.0 plus the new kryptonite shard(s). No v0.3.0 bytes are touched or re-shuffled.
 *
 *   See docs/articles/plan/reference/CORPUS_V0_4_0_GENERATION.md for the why; that doc also pins the
 *   DeepSeek model version + prompt versions used to produce the JSONL.
 *
 *   Invoke via `mailwoman corpus shard kryptonite \
 *   --jsonl /data/corpus/versioned/v0.4.0/kryptonite/canonical-kryptonite.jsonl \
 *   --base-manifest /data/corpus/versioned/v0.3.0/corpus-v0.3.0/MANIFEST.json \
 *   --out-dir /data/corpus/versioned/v0.4.0`
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"

import { iterateJSONL } from "@mailwoman/core/utils"

import { alignRow } from "../align.ts"
import type { ShardManifest } from "../parquet.ts"
import { PARQUET_COLUMNS, ROW_GROUP_SIZE, SHARD_COMPRESSION, writeShards } from "../parquet.ts"
import type { CanonicalRow, LabeledRow } from "../types.ts"

export interface ShardKryptoniteOptions {
	jsonl: string
	baseManifest: string
	outDir: string
	/** Default `"0.4.0"`. */
	corpusVersion?: string
	/** Default `"deepseek-kryptonite"`. */
	source?: string
}

async function* canonicalRows(jsonl: string, corpusVersion: string): AsyncIterable<CanonicalRow> {
	for await (const raw of iterateJSONL<Record<string, unknown>>(jsonl)) {
		// Strip sidecar underscore-prefixed fields the generator left behind for debugging.
		const components = raw["components"] as Record<string, string>
		yield {
			raw: raw["raw"] as string,
			components,
			country: (raw["country"] as string) ?? "US",
			locale: (raw["locale"] as string) ?? undefined,
			source: (raw["source"] as string) ?? "deepseek-kryptonite",
			source_id: raw["source_id"] as string,
			corpus_version: corpusVersion,
			license: (raw["license"] as string) ?? "Synthetic (DeepSeek-v4-flash, AGPL-compatible)",
			synth: raw["synth"] as CanonicalRow["synth"],
		}
	}
}

async function* labeledRows(jsonl: string, corpusVersion: string, quarantineLog: string[]): AsyncIterable<LabeledRow> {
	for await (const row of canonicalRows(jsonl, corpusVersion)) {
		const result = alignRow(row)

		if (result.kind === "labeled") {
			yield result.row
		} else {
			quarantineLog.push(`${row.source_id}\t${result.row.reason}`)
		}
	}
}

export async function buildKryptoniteShard(
	options: ShardKryptoniteOptions,
	report?: (line: string) => void
): Promise<void> {
	const corpusVersion = options.corpusVersion ?? "0.4.0"
	const source = options.source ?? "deepseek-kryptonite"

	if (!existsSync(options.jsonl)) throw new Error(`jsonl not found: ${options.jsonl}`)

	if (!existsSync(options.baseManifest)) throw new Error(`base-manifest not found: ${options.baseManifest}`)

	await mkdir(options.outDir, { recursive: true })

	const quarantine: string[] = []
	const newManifest = await writeShards(
		{ train: labeledRows(options.jsonl, corpusVersion, quarantine) },
		{ outputDir: options.outDir, corpusVersion }
	)

	report?.(
		`wrote ${newManifest.total_rows} rows into ${newManifest.shards.length} shard(s); ` +
			`quarantined ${quarantine.length}`
	)

	if (quarantine.length > 0) {
		const qPath = join(options.outDir, `corpus-v${corpusVersion}`, "quarantine-kryptonite.tsv")
		writeFileSync(qPath, quarantine.join("\n") + "\n", "utf8")
		report?.(`quarantine log → ${qPath}`)
	}

	// Stamp the new shard's source field for audit.ts (which prefers shard.source over
	// first_source_id-prefix inference). Without this, deepseek-kryptonite IDs would have
	// to match a prefix in KNOWN_SOURCE_PREFIXES — we add it there too as a belt-and-braces.
	for (const sh of newManifest.shards) {
		;(sh as unknown as { source: string }).source = source
	}

	// Compose the final corpus-v0.4.0 manifest: every shard from base + the new shard(s).
	const base = JSON.parse(readFileSync(options.baseManifest, "utf8")) as ShardManifest
	const combined: ShardManifest = {
		corpus_version: corpusVersion,
		schema: PARQUET_COLUMNS,
		rows_per_shard: base.rows_per_shard,
		row_group_size: base.row_group_size ?? ROW_GROUP_SIZE,
		shards: [...base.shards, ...newManifest.shards],
		counts: {
			train: base.counts.train + (newManifest.counts.train ?? 0),
			val: base.counts.val,
			test: base.counts.test,
		},
		total_rows: base.total_rows + newManifest.total_rows,
	}
	// Stamp source on the legacy v0.3.0 shards too, so audit's shard.source path is the
	// authoritative one. v0.3.0 shards mix sources; we use the first_source_id-prefix
	// inference for them (audit.ts will re-derive on its own when shard.source is absent).
	const combinedPath = join(options.outDir, `corpus-v${corpusVersion}`, "MANIFEST.json")
	writeFileSync(combinedPath, JSON.stringify(combined, null, 2) + "\n", "utf8")
	report?.(`wrote combined manifest → ${combinedPath}`)
	report?.(`  total_rows=${combined.total_rows} (base=${base.total_rows}, added=${newManifest.total_rows})`)
	report?.(`  shards=${combined.shards.length} (base=${base.shards.length}, added=${newManifest.shards.length})`)
	report?.(`  compression=${SHARD_COMPRESSION}`)
}
