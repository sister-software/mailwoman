#!/usr/bin/env npx tsx
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
 *   Usage: npx tsx corpus/scripts/build-kryptonite-shard.ts\
 *   --jsonl /data/corpus/versioned/v0.4.0/kryptonite/canonical-kryptonite.jsonl\
 *   --base-manifest /data/corpus/versioned/v0.3.0/corpus-v0.3.0/MANIFEST.json\
 *   --out-dir /data/corpus/versioned/v0.4.0
 */

///<reference types="node" />

import { createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { createInterface } from "node:readline"

import { cliArguments } from "@mailwoman/core/utils"

import { alignRow } from "../src/align.js"
import { PARQUET_COLUMNS, ROW_GROUP_SIZE, SHARD_COMPRESSION, type ShardManifest, writeShards } from "../src/parquet.js"
import type { CanonicalRow, LabeledRow } from "../src/types.js"

interface Args {
	jsonl: string
	baseManifest: string
	outDir: string
	corpusVersion: string
	source: string
}

function parseArgs(argv: readonly string[]): Args {
	const out: Partial<Args> = {
		corpusVersion: "0.4.0",
		source: "deepseek-kryptonite",
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
			case "--source":
				out.source = next ?? out.source
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

async function* canonicalRows(jsonl: string, corpusVersion: string): AsyncIterable<CanonicalRow> {
	const rl = createInterface({ input: createReadStream(jsonl, "utf8"), crlfDelay: Infinity })

	for await (const line of rl) {
		if (!line.trim()) continue
		const raw = JSON.parse(line) as Record<string, unknown>
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

async function main(): Promise<void> {
	const args = parseArgs(cliArguments())

	if (!existsSync(args.jsonl)) throw new Error(`jsonl not found: ${args.jsonl}`)

	if (!existsSync(args.baseManifest)) throw new Error(`base-manifest not found: ${args.baseManifest}`)

	await mkdir(args.outDir, { recursive: true })

	const quarantine: string[] = []
	const newManifest = await writeShards(
		{ train: labeledRows(args.jsonl, args.corpusVersion, quarantine) },
		{ outputDir: args.outDir, corpusVersion: args.corpusVersion }
	)

	console.error(
		`wrote ${newManifest.total_rows} rows into ${newManifest.shards.length} shard(s); ` +
			`quarantined ${quarantine.length}`
	)

	if (quarantine.length > 0) {
		const qPath = join(args.outDir, `corpus-v${args.corpusVersion}`, "quarantine-kryptonite.tsv")
		writeFileSync(qPath, quarantine.join("\n") + "\n", "utf8")
		console.error(`quarantine log → ${qPath}`)
	}

	// Stamp the new shard's source field for audit.ts (which prefers shard.source over
	// first_source_id-prefix inference). Without this, deepseek-kryptonite IDs would have
	// to match a prefix in KNOWN_SOURCE_PREFIXES — we add it there too as a belt-and-braces.
	for (const sh of newManifest.shards) {
		;(sh as unknown as { source: string }).source = args.source
	}

	// Compose the final corpus-v0.4.0 manifest: every shard from base + the new shard(s).
	const base = JSON.parse(readFileSync(args.baseManifest, "utf8")) as ShardManifest
	const combined: ShardManifest = {
		corpus_version: args.corpusVersion,
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
	const combinedPath = join(args.outDir, `corpus-v${args.corpusVersion}`, "MANIFEST.json")
	writeFileSync(combinedPath, JSON.stringify(combined, null, 2) + "\n", "utf8")
	console.error(`wrote combined manifest → ${combinedPath}`)
	console.error(`  total_rows=${combined.total_rows} (base=${base.total_rows}, added=${newManifest.total_rows})`)
	console.error(`  shards=${combined.shards.length} (base=${base.shards.length}, added=${newManifest.shards.length})`)
	console.error(`  compression=${SHARD_COMPRESSION}`)
}

main().catch((err) => {
	console.error(`fatal: ${err instanceof Error ? err.stack : err}`)
	process.exit(1)
})
