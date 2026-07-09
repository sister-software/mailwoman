#!/usr/bin/env npx tsx
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus-audit` — per-source shard-count vs source_weight diagnostic.
 *
 *   Reads a corpus dir's MANIFEST.json (or scans shards directly), counts shards per source,
 *   optionally loads a training config to pair the counts with the configured source_weights, and
 *   reports the estimated sampled-row distribution at training time.
 *
 *   Would have caught v0.3.0's "NAD = 411/674 train shards × 2.0 weight = ~75% of sampled mix"
 *   finding before the v0.3.0 retrospective surfaced it.
 *
 *   Usage: npx tsx corpus/scripts/audit.ts <corpus_dir> [--config <training-config.yaml>]
 *
 *   Example: npx tsx corpus/scripts/audit.ts
 *   /mnt/playpen/mailwoman-data/corpus/versioned/v0.3.0/corpus-v0.3.0\
 *   --config corpus-python/src/mailwoman_train/configs/v0_4_0.yaml
 *
 *   Exits 0 always; emits warnings to stderr and the audit table to stdout.
 */

///<reference types="node" />

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { basename, join } from "node:path"

import { runIfScript } from "@mailwoman/core/scripting"
import { cliArguments } from "@mailwoman/core/scripting/utils"

interface AuditOpts {
	corpusDir: string
	configPath?: string
	/**
	 * Sample at most N shards per split when counting sources. Default 100 for speed; bump to read the full set on a slow
	 * run. The first row of each shard determines its source — corpus-v0.2.0+ shards are 100% source-segregated, so a
	 * one-row read is authoritative.
	 */
	sampleShardCount?: number
}

interface ShardStats {
	/** Shards per source per split */
	bySplit: Record<string, Record<string, number>>
	/** Total shards counted (may be less than file count if sampleShardCount caps reads) */
	totalShards: number
	/** Total shards on disk (file count) — equals totalShards unless capped */
	totalFiles: number
}

interface ParsedConfig {
	sourceWeights: Record<string, number>
}

/**
 * Try parsing a training YAML's source_weights as a minimal regex-based extract. We don't pull in a YAML lib for this
 * script — the syntax is so small that a regex over the source_weights block is sufficient + keeps the script
 * dep-free.
 */
function parseConfig(configPath: string): ParsedConfig | null {
	if (!existsSync(configPath)) return null
	const text = readFileSync(configPath, "utf8")
	const lines = text.split("\n")
	const weights: Record<string, number> = {}
	let inBlock = false
	let blockIndent = -1

	for (const raw of lines) {
		const sourceWeightsMatch = raw.match(/^([\t ]*)source_weights:\s*$/)

		if (sourceWeightsMatch) {
			inBlock = true
			blockIndent = sourceWeightsMatch[1]!.length
			continue
		}

		if (!inBlock) continue

		// Skip blank lines and comments.
		if (/^[\t ]*(#|$)/.test(raw)) continue
		// Lines indented MORE than `source_weights:` are entries; lines with ≤ indent end the block.
		const indent = raw.match(/^[\t ]*/)![0].length

		if (indent <= blockIndent) {
			inBlock = false
			continue
		}
		const m = raw.match(/^[\t ]+([\w-]+):\s*([\d.]+)/)

		if (m) {
			weights[m[1]!] = parseFloat(m[2]!)
		}
	}

	return { sourceWeights: weights }
}

/**
 * Scan a corpus directory's shards (typically under <corpus_dir>/train, /val, /test) and count shards per source per
 * split.
 */
function scanShards(corpusDir: string, sampleCount: number): ShardStats {
	const stats: ShardStats = { bySplit: {}, totalShards: 0, totalFiles: 0 }

	for (const split of ["train", "val", "test"]) {
		const splitDir = join(corpusDir, split)

		if (!existsSync(splitDir)) continue
		const files = readdirSync(splitDir)
			.filter((f) => f.endsWith(".parquet"))
			.sort()
		stats.totalFiles += files.length
		const sampleEvery = Math.max(1, Math.floor(files.length / sampleCount))
		const sampled = files.filter((_, i) => i % sampleEvery === 0).slice(0, sampleCount)
		const splitMap: Record<string, number> = {}

		// We can't read parquet without a dep, so we infer source from filenames where possible.
		// The corpus build typically writes deterministically by source — fall back to "<unknown>"
		// when filename gives no hint. For accurate per-source counts on real corpora, the
		// MANIFEST.json route below is preferred.
		for (const f of sampled) {
			const inferred = inferSourceFromFilename(f)
			splitMap[inferred] = (splitMap[inferred] ?? 0) + 1
		}
		// Scale to estimated full-shard counts.
		const scale = files.length / Math.max(sampled.length, 1)

		for (const k of Object.keys(splitMap)) {
			splitMap[k] = Math.round(splitMap[k]! * scale)
		}
		stats.bySplit[split] = splitMap
		stats.totalShards += files.length
	}

	return stats
}

function inferSourceFromFilename(filename: string): string {
	// Many corpus builds write part-<source>-<n>.parquet or part-<n>.parquet. The latter (current
	// build at corpus-v0.3.0) gives no source signal in the filename — see manifestScan() for the
	// authoritative path. Return "<unknown>" so the caller flags this case.
	const m = basename(filename).match(/part-([\w-]+)-\d+\.parquet$/)

	if (m && m[1] !== undefined) return m[1]

	return "<unknown>"
}

/**
 * Known source name prefixes. Corpus-v0.3.0 uses these as `source_id` prefixes; matching against the longest prefix
 * that fits a given `first_source_id` recovers the canonical source name.
 *
 * Order matters: longer prefixes must be tried first so `usgov-nad-...` matches `usgov-nad` rather than `usgov`. Sorted
 * descending by length at use site.
 */
const KNOWN_SOURCE_PREFIXES: ReadonlyArray<string> = [
	"wof-admin",
	"wof-postalcode",
	"ban",
	"tiger",
	"usgov-nad",
	"usgov-nppes",
	"usgov-hrsa-fqhc",
	"usgov-imls-pls",
	"state-ia-contractors",
	"state-tx-notaries",
	"state-ny-notaries",
	"openaddresses",
	// Synthetic adversarial sources (corpus-v0.4.0+, Thread B).
	"deepseek-kryptonite",
	"deepseek-translit-cyrl",
	"deepseek-translit-jpan",
	"deepseek-translit-hans",
	"deepseek-translit-hang",
	"deepseek-translit-armn",
]

/** Extract the source-name prefix from a `first_source_id` value. */
function sourceFromID(sourceID: string, knownPrefixes: readonly string[]): string {
	// Sort longest-first so usgov-nad beats usgov, wof-admin beats wof.
	const sorted = [...knownPrefixes].sort((a, b) => b.length - a.length)

	for (const prefix of sorted) {
		if (sourceID.startsWith(prefix + "-") || sourceID === prefix) return prefix
	}

	return "<unknown>"
}

/**
 * Prefer reading MANIFEST.json when present — uses each shard's `first_source_id` + prefix matching to recover the
 * source name. Falls back to scanShards when MANIFEST is absent.
 *
 * NOTE: corpus-v0.3.0 shards can mix sources (see `last_source_id` differing from `first_source_id`). The first-row
 * source is an approximation; reading the parquet's full source column would be authoritative but requires a parquet
 * dep. For audit purposes the first-row approximation is accurate within ~5% for the corpus-v0.3.0 shape (most shards
 * are >95% one source).
 */
function manifestScan(corpusDir: string, knownPrefixes: readonly string[]): ShardStats | null {
	const manifestPath = join(corpusDir, "MANIFEST.json")

	if (!existsSync(manifestPath)) return null
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
		shards?: Array<{ split: string; source?: string | null; first_source_id?: string | null }>
	}

	if (!Array.isArray(manifest.shards)) return null
	const bySplit: Record<string, Record<string, number>> = {}

	for (const shard of manifest.shards) {
		const split = shard.split
		const src = shard.source ?? sourceFromID(shard.first_source_id ?? "", knownPrefixes)
		bySplit[split] ??= {}
		bySplit[split][src] = (bySplit[split][src] ?? 0) + 1
	}
	const total = Object.values(bySplit).reduce((sum, m) => sum + Object.values(m).reduce((a, b) => a + b, 0), 0)

	return { bySplit, totalShards: total, totalFiles: total }
}

interface AuditRow {
	source: string
	shards: number
	shardPct: number
	weight: number | "—"
	effectiveSamplePct: number | "—"
	overweightFactor?: number
}

function buildAuditRows(stats: Record<string, number>, weights: Record<string, number>): AuditRow[] {
	const totalShards = Object.values(stats).reduce((a, b) => a + b, 0)
	const allSources = new Set([...Object.keys(stats), ...Object.keys(weights)])
	const rows: AuditRow[] = []
	// Compute effective sample weight: shard_count × source_weight. Sources with no weight get the
	// "—" marker (loader skips them).
	const sampleWeights: Array<[string, number]> = []

	for (const src of allSources) {
		const shards = stats[src] ?? 0
		const weight = weights[src]
		const effective = weight !== undefined ? shards * weight : 0
		sampleWeights.push([src, effective])
	}
	const totalSampleWeight = sampleWeights.reduce((a, [, w]) => a + w, 0)

	for (const src of allSources) {
		const shards = stats[src] ?? 0
		const weight = weights[src] ?? "—"
		const effective = typeof weight === "number" ? (shards * weight) / Math.max(totalSampleWeight, 1) : "—"
		rows.push({
			source: src,
			shards,
			shardPct: totalShards > 0 ? shards / totalShards : 0,
			weight,
			effectiveSamplePct: typeof effective === "number" ? effective : "—",
		})
	}
	// Flag the dominator: empirically calibrated against the v0.3.0 → v0.4.0 retrospective.
	// v0.3.0 had usgov-nad at 52% effective sample (1.9× ban); the resulting label-space dilution
	// was responsible for the coarse-F1 regression. So flag a source as "concentration warning"
	// when it's above 40% effective sample OR more than 1.5× the next-highest.
	const numeric = rows.filter((r) => typeof r.effectiveSamplePct === "number") as Array<
		AuditRow & { effectiveSamplePct: number }
	>
	numeric.sort((a, b) => b.effectiveSamplePct - a.effectiveSamplePct)

	if (numeric.length >= 1) {
		const top = numeric[0]!
		const next = numeric[1]?.effectiveSamplePct ?? 0

		if (top.effectiveSamplePct > 0.4 || (next > 0 && top.effectiveSamplePct / next > 1.5)) {
			top.overweightFactor = next > 0 ? top.effectiveSamplePct / next : Infinity
		}
	}
	rows.sort((a, b) => b.shards - a.shards)

	return rows
}

function formatPct(v: number | "—"): string {
	if (v === "—") return "—"

	return `${(v * 100).toFixed(1)}%`
}

function printReport(corpusDir: string, configPath: string | undefined, stats: ShardStats, rows: AuditRow[]): void {
	console.log(`\nCorpus audit — ${corpusDir}`)

	if (configPath) {
		console.log(`Config:        ${configPath}`)
	}
	console.log(
		`Total shards:  ${stats.totalShards}${stats.totalFiles !== stats.totalShards ? ` (${stats.totalFiles} files on disk)` : ""}`
	)
	console.log("")
	const trainStats = stats.bySplit["train"]

	if (trainStats) {
		const total = Object.values(trainStats).reduce((a, b) => a + b, 0)
		console.log(`Train split: ${total} shards`)
		console.log("")
		const headers = ["source", "shards", "shard %", "weight", "eff. sample %"]
		const widths = [22, 8, 10, 8, 14]
		const fmtRow = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ")
		console.log(fmtRow(headers))
		console.log(fmtRow(widths.map((w) => "─".repeat(w))))

		for (const row of rows) {
			console.log(
				fmtRow([
					row.source,
					String(row.shards),
					formatPct(row.shardPct),
					typeof row.weight === "number" ? row.weight.toFixed(2) : "—",
					formatPct(row.effectiveSamplePct),
				])
			)
		}
		console.log("")
		const dominator = rows.find((r) => r.overweightFactor !== undefined)

		if (dominator) {
			const factor = dominator.overweightFactor
			const factorStr = factor === Infinity ? "∞" : factor?.toFixed(1)
			console.error(
				`⚠ Concentration: ${dominator.source} would sample ${formatPct(dominator.effectiveSamplePct)} ` +
					`of training rows (${factorStr}× the next-highest). ` +
					`Past lesson: v0.3.0's NAD at ~52% caused the 21-label coarse regression. ` +
					`Consider lowering this source's weight or boosting others.`
			)
		} else {
			console.log("✓ No single-source concentration (top source < 40% effective sample AND < 1.5× next).")
		}
		const missingWeights = rows.filter((r) => r.weight === "—" && r.shards > 0)

		if (missingWeights.length > 0 && configPath) {
			console.error(
				`⚠ Sources present in corpus but absent from config.source_weights ` +
					`(loader will skip them): ${missingWeights.map((r) => r.source).join(", ")}`
			)
		}
		const orphanWeights = rows.filter((r) => typeof r.weight === "number" && r.shards === 0)

		if (orphanWeights.length > 0) {
			console.error(
				`⚠ Sources weighted in config but no shards found in corpus ` +
					`(no-op weights): ${orphanWeights.map((r) => r.source).join(", ")}`
			)
		}
	}
}

export function audit(opts: AuditOpts): void {
	const config = opts.configPath ? parseConfig(opts.configPath) : null
	// Compose the known-prefix list from both the hardcoded set and any extra names in the config
	// (forward-compat for future adapters added before this file is updated).
	const prefixes = [...new Set([...KNOWN_SOURCE_PREFIXES, ...Object.keys(config?.sourceWeights ?? {})])]
	const stats = manifestScan(opts.corpusDir, prefixes) ?? scanShards(opts.corpusDir, opts.sampleShardCount ?? 100)
	const trainStats = stats.bySplit["train"] ?? {}
	const rows = buildAuditRows(trainStats, config?.sourceWeights ?? {})
	printReport(opts.corpusDir, opts.configPath, stats, rows)
}

function parseArgv(argv: readonly string[]): AuditOpts {
	if (argv.length < 1) {
		console.error("Usage: audit.ts <corpus_dir> [--config <yaml>]")
		process.exit(2)
	}
	const opts: AuditOpts = { corpusDir: argv[0]! }

	for (let i = 1; i < argv.length; i++) {
		if (argv[i] === "--config" && argv[i + 1]) {
			opts.configPath = argv[i + 1]
			i++
		} else if (argv[i] === "--sample" && argv[i + 1]) {
			opts.sampleShardCount = parseInt(argv[i + 1]!, 10)
			i++
		}
	}

	return opts
}

runIfScript(() => audit(parseArgv(cliArguments())))
