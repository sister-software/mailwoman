/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Corpus linter. Compares a new shard against pre-computed corpus statistics and flags patterns
 *   that would cause the class of failure we hit with v0.6.2's "5th Avenue Theatre" adversarial
 *   venue templates.
 *
 *   Per DeepSeek turn 9 design (2026-05-29). v1 checks:
 *
 *   1. **Token-label distribution outliers.** For each token in the new shard, compare the shard's
 *        majority label to the corpus's majority label. Flag when the corpus has a
 *        confidently-established majority (>66%) AND the shard's majority differs AND both have
 *        non-trivial counts (shard ≥ 50, corpus ≥ 200).
 *   2. **Label-vacuum tokens.** Token labeled with a tag that has ZERO instances in the corpus for that
 *        token, despite the token being well-represented in the corpus. Stronger signal than #1 —
 *        we're introducing a novel association, not shifting a distribution.
 *   3. **Bigram-label collisions.** Identical (token_bigram, label_bigram) appears in shard while the
 *        same token_bigram has a DIFFERENT majority label_bigram in the corpus. The "5th Avenue"
 *        with [B-venue, I-venue] vs corpus's [B-house_number, I-street] case.
 *   4. **Common-form anti-pattern rules.** Applies `lint-rules.json` — token-regex → forbidden-labels
 *        mappings — flagging matches.
 *   5. **Basic sanity.** Truncated rows (tokens.length !== labels.length), all-O rows >90% of shard.
 *
 *   Output: markdown report on stdout, optional JSON sidecar via `--out-json`. Exits 0 if no errors,
 *   1 if any errors (warnings don't gate). Per the design, the MANIFEST entry for a flagged shard
 *   should require `lint_acknowledged: true` before training consumes it.
 *
 *   Usage: node --experimental-strip-types scripts/lint-corpus-shard.ts\
 *   --shard <new-shard.parquet>\
 *   --stats <corpus-stats.json>\
 *   [--rules scripts/lint-rules.json]\
 *   [--out-md /tmp/lint-report.md]\
 *   [--out-json /tmp/lint-report.json]
 */

import { execSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs as parseNodeArgs } from "node:util"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const SEP = ""

// Calibrated thresholds (DeepSeek turn 9). These can be tuned over time if new failure
// modes surface that the current numbers miss.
const CORPUS_CONFIDENCE_FLOOR = 0.66
const SHARD_MIN_COUNT = 50
const CORPUS_MIN_COUNT = 200
const VACUUM_SHARD_MIN_COUNT = 20
const VACUUM_CORPUS_MIN_COUNT = 100
const BIGRAM_MIN_COUNT = 10
const ALL_O_RATIO_CEILING = 0.9

interface Args {
	shardPath: string
	statsPath: string
	rulesPath: string
	outMd?: string
	outJson?: string
}

function parseArgs(): Args {
	const out: Partial<Args> = {}

	// node:util parseArgs (strict:false = old scan parity: unknown flags tolerated)
	const { values } = parseNodeArgs({
		args: process.argv.slice(2),
		options: {
			"out-json": { type: "string" },
			"out-md": { type: "string" },
			rules: { type: "string" },
			shard: { type: "string" },
			stats: { type: "string" },
		},
		strict: false,
		allowPositionals: true,
	})

	if (values["shard"] != null) out.shardPath = values["shard"] as string
	if (values["stats"] != null) out.statsPath = values["stats"] as string
	if (values["rules"] != null) out.rulesPath = values["rules"] as string
	if (values["out-md"] != null) out.outMd = values["out-md"] as string
	if (values["out-json"] != null) out.outJson = values["out-json"] as string

	if (!out.shardPath || !out.statsPath) {
		console.error(
			"Usage: lint-corpus-shard.ts --shard <parquet> --stats <stats.json> [--rules <rules.json>] [--out-md <path>] [--out-json <path>]"
		)
		process.exit(2)
	}
	out.rulesPath = out.rulesPath ?? resolve(__dirname, "lint-rules.json")

	return out as Args
}

interface CorpusStats {
	row_count: number
	shard_paths: string[]
	tokens: Record<string, Record<string, number>>
	bigrams: Record<string, Record<string, number>>
}

interface LintRule {
	id: string
	pattern: string
	pattern_case_sensitive: boolean
	forbidden_labels: string[]
	message: string
	severity: "error" | "warn"
}

interface LintRulesFile {
	rules: LintRule[]
}

interface ShardRow {
	tokens: string[]
	labels: string[]
}

function readShard(shardPath: string): ShardRow[] {
	const py = `
import pyarrow.parquet as pq
import json, sys
t = pq.read_table(${JSON.stringify(shardPath)}, columns=['tokens', 'labels'])
tokens_col = t['tokens'].to_pylist()
labels_col = t['labels'].to_pylist()
for i in range(len(tokens_col)):
    sys.stdout.write(json.dumps({"tokens": tokens_col[i], "labels": labels_col[i]}) + "\\n")
`
	const buf = execSync(`python3`, { input: py, maxBuffer: 1024 * 1024 * 1024 })
	const rows: ShardRow[] = []

	for (const line of buf.toString("utf8").split("\n")) {
		if (!line) continue
		rows.push(JSON.parse(line))
	}

	return rows
}

interface ShardStats {
	rowCount: number
	tokens: Map<string, Map<string, number>>
	bigrams: Map<string, Map<string, number>>
	truncatedRows: number
	allORows: number
}

function statsFromShard(rows: ShardRow[]): ShardStats {
	const out: ShardStats = {
		rowCount: rows.length,
		tokens: new Map(),
		bigrams: new Map(),
		truncatedRows: 0,
		allORows: 0,
	}

	for (const row of rows) {
		if (row.tokens.length !== row.labels.length) {
			out.truncatedRows++
			continue
		}

		if (row.labels.every((l) => l === "O")) {
			out.allORows++
		}

		for (let i = 0; i < row.tokens.length; i++) {
			const tk = row.tokens[i]!
			const lb = row.labels[i]!
			let labelMap = out.tokens.get(tk)

			if (!labelMap) {
				labelMap = new Map()
				out.tokens.set(tk, labelMap)
			}
			labelMap.set(lb, (labelMap.get(lb) ?? 0) + 1)

			if (i + 1 < row.tokens.length) {
				const bigramKey = tk + SEP + row.tokens[i + 1]!
				const bigramLabel = lb + SEP + row.labels[i + 1]!
				let bMap = out.bigrams.get(bigramKey)

				if (!bMap) {
					bMap = new Map()
					out.bigrams.set(bigramKey, bMap)
				}
				bMap.set(bigramLabel, (bMap.get(bigramLabel) ?? 0) + 1)
			}
		}
	}

	return out
}

function majorityLabel(distribution: Map<string, number> | Record<string, number>): {
	label: string
	count: number
	total: number
	confidence: number
} {
	const entries = distribution instanceof Map ? [...distribution.entries()] : Object.entries(distribution)
	let bestLabel = ""
	let bestCount = 0
	let total = 0

	for (const [label, count] of entries) {
		total += count

		if (count > bestCount) {
			bestCount = count
			bestLabel = label
		}
	}

	return { label: bestLabel, count: bestCount, total, confidence: total === 0 ? 0 : bestCount / total }
}

interface Flag {
	check: string
	severity: "error" | "warn"
	token?: string
	bigram?: string
	shardLabel?: string
	corpusLabel?: string
	shardCount?: number
	corpusCount?: number
	detail: string
	ruleID?: string
}

function checkDistributionOutliers(shard: ShardStats, corpus: CorpusStats): Flag[] {
	const flags: Flag[] = []

	for (const [token, shardLabelMap] of shard.tokens) {
		const corpusLabelMap = corpus.tokens[token]

		if (!corpusLabelMap) continue
		const shardMaj = majorityLabel(shardLabelMap)
		const corpusMaj = majorityLabel(corpusLabelMap)

		if (
			corpusMaj.confidence >= CORPUS_CONFIDENCE_FLOOR &&
			shardMaj.label !== corpusMaj.label &&
			shardMaj.count >= SHARD_MIN_COUNT &&
			corpusMaj.total >= CORPUS_MIN_COUNT
		) {
			flags.push({
				check: "distribution-outlier",
				severity: "error",
				token,
				shardLabel: shardMaj.label,
				corpusLabel: corpusMaj.label,
				shardCount: shardMaj.count,
				corpusCount: corpusMaj.count,
				detail: `Token "${token}": shard majority is ${shardMaj.label} (${shardMaj.count}/${shardMaj.total}, ${(shardMaj.confidence * 100).toFixed(0)}%), corpus majority is ${corpusMaj.label} (${corpusMaj.count}/${corpusMaj.total}, ${(corpusMaj.confidence * 100).toFixed(0)}%).`,
			})
		}
	}

	return flags
}

function checkLabelVacuum(shard: ShardStats, corpus: CorpusStats): Flag[] {
	const flags: Flag[] = []

	for (const [token, shardLabelMap] of shard.tokens) {
		const corpusLabelMap = corpus.tokens[token]

		if (!corpusLabelMap) continue
		const corpusTotal = Object.values(corpusLabelMap).reduce((a, b) => a + b, 0)

		if (corpusTotal < VACUUM_CORPUS_MIN_COUNT) continue

		for (const [label, shardCount] of shardLabelMap) {
			if (shardCount < VACUUM_SHARD_MIN_COUNT) continue

			if (corpusLabelMap[label] === undefined || corpusLabelMap[label] === 0) {
				flags.push({
					check: "label-vacuum",
					severity: "error",
					token,
					shardLabel: label,
					shardCount,
					corpusCount: corpusTotal,
					detail: `Token "${token}": shard labels it ${label} ${shardCount} times, but the corpus (${corpusTotal} instances of this token) has ZERO instances of this label.`,
				})
			}
		}
	}

	return flags
}

function checkBigramCollisions(shard: ShardStats, corpus: CorpusStats): Flag[] {
	const flags: Flag[] = []

	for (const [bigram, shardLabelMap] of shard.bigrams) {
		const corpusLabelMap = corpus.bigrams[bigram]

		if (!corpusLabelMap) continue
		const shardMaj = majorityLabel(shardLabelMap)
		const corpusMaj = majorityLabel(corpusLabelMap)

		if (
			shardMaj.label !== corpusMaj.label &&
			shardMaj.count >= BIGRAM_MIN_COUNT &&
			corpusMaj.count >= BIGRAM_MIN_COUNT
		) {
			const renderBigram = bigram.split(SEP).join(" ")
			const renderShardLabel = shardMaj.label.split(SEP).join(" → ")
			const renderCorpusLabel = corpusMaj.label.split(SEP).join(" → ")
			flags.push({
				check: "bigram-collision",
				severity: "error",
				bigram: renderBigram,
				shardLabel: renderShardLabel,
				corpusLabel: renderCorpusLabel,
				shardCount: shardMaj.count,
				corpusCount: corpusMaj.count,
				detail: `Bigram "${renderBigram}": shard label-bigram is [${renderShardLabel}] (${shardMaj.count}×), corpus label-bigram is [${renderCorpusLabel}] (${corpusMaj.count}×). Same surface text, different structural reading.`,
			})
		}
	}

	return flags
}

function checkRules(shard: ShardStats, rulesFile: LintRulesFile): Flag[] {
	const flags: Flag[] = []
	const compiled = rulesFile.rules.map((r) => ({
		rule: r,
		regex: new RegExp(r.pattern, r.pattern_case_sensitive ? "" : "i"),
	}))

	for (const [token, labelMap] of shard.tokens) {
		for (const { rule, regex } of compiled) {
			if (!regex.test(token)) continue

			for (const [label, count] of labelMap) {
				if (rule.forbidden_labels.includes(label) && count >= 5) {
					flags.push({
						check: "anti-pattern-rule",
						severity: rule.severity,
						ruleID: rule.id,
						token,
						shardLabel: label,
						shardCount: count,
						detail: `Token "${token}" matched rule ${rule.id} and is labeled ${label} ${count} time(s). Rule message: ${rule.message}`,
					})
				}
			}
		}
	}

	return flags
}

function checkSanity(shard: ShardStats): Flag[] {
	const flags: Flag[] = []

	if (shard.truncatedRows > 0) {
		flags.push({
			check: "truncated-rows",
			severity: "error",
			detail: `${shard.truncatedRows} row(s) have tokens.length !== labels.length. Pipeline alignment bug.`,
		})
	}
	const allORatio = shard.allORows / Math.max(1, shard.rowCount)

	if (allORatio >= ALL_O_RATIO_CEILING) {
		flags.push({
			check: "all-O-shard",
			severity: "warn",
			detail: `${shard.allORows}/${shard.rowCount} rows (${(allORatio * 100).toFixed(0)}%) are entirely O-labeled. Shard contributes no signal.`,
		})
	}

	return flags
}

function renderReport(args: Args, shard: ShardStats, flags: Flag[]): string {
	const errors = flags.filter((f) => f.severity === "error")
	const warns = flags.filter((f) => f.severity === "warn")
	const verdict = errors.length === 0 ? "**PASS** ✓" : "**FLAGGED** ⚠"
	const lines: string[] = []
	lines.push(`# Corpus Lint: ${verdict}`)
	lines.push("")
	lines.push(`- **Shard:** \`${args.shardPath}\``)
	lines.push(`- **Corpus stats:** \`${args.statsPath}\``)
	lines.push(`- **Rules:** \`${args.rulesPath}\``)
	lines.push(`- **Shard rows:** ${shard.rowCount}`)
	lines.push(`- **Unique tokens:** ${shard.tokens.size}`)
	lines.push(`- **Unique bigrams:** ${shard.bigrams.size}`)
	lines.push("")
	lines.push(
		`**Errors:** ${errors.length} (gates the shard's inclusion unless MANIFEST sets \`lint_acknowledged: true\`)`
	)
	lines.push(`**Warnings:** ${warns.length} (advisory)`)
	lines.push("")

	if (flags.length === 0) {
		lines.push("No anomalies detected.")

		return lines.join("\n")
	}
	const byCheck = new Map<string, Flag[]>()

	for (const f of flags) {
		const arr = byCheck.get(f.check) ?? []
		arr.push(f)
		byCheck.set(f.check, arr)
	}

	for (const [check, list] of byCheck) {
		lines.push(`## ${check} (${list.length})`)
		lines.push("")
		// Sort by shardCount desc — highest-volume issues first
		list.sort((a, b) => (b.shardCount ?? 0) - (a.shardCount ?? 0))

		for (const f of list.slice(0, 20)) {
			lines.push(`- **[${f.severity.toUpperCase()}]** ${f.detail}`)
		}

		if (list.length > 20) {
			lines.push(`- ... and ${list.length - 20} more`)
		}
		lines.push("")
	}

	return lines.join("\n")
}

function main(): void {
	const args = parseArgs()
	console.error(`Reading corpus stats from ${args.statsPath}...`)
	const corpus: CorpusStats = JSON.parse(readFileSync(args.statsPath, "utf8"))
	console.error(
		`  ${corpus.row_count} rows from ${corpus.shard_paths.length} shard(s); ${Object.keys(corpus.tokens).length} tokens, ${Object.keys(corpus.bigrams).length} bigrams`
	)

	console.error(`Reading shard from ${args.shardPath}...`)
	const rows = readShard(args.shardPath)
	console.error(`  ${rows.length} rows`)

	console.error(`Computing shard stats...`)
	const shard = statsFromShard(rows)

	console.error(`Loading rules from ${args.rulesPath}...`)
	const rulesFile: LintRulesFile = JSON.parse(readFileSync(args.rulesPath, "utf8"))

	console.error(`Running checks...`)
	const flags: Flag[] = [
		...checkDistributionOutliers(shard, corpus),
		...checkLabelVacuum(shard, corpus),
		...checkBigramCollisions(shard, corpus),
		...checkRules(shard, rulesFile),
		...checkSanity(shard),
	]

	const report = renderReport(args, shard, flags)
	console.log(report)

	if (args.outMd) {
		writeFileSync(args.outMd, report)
	}

	if (args.outJson) {
		writeFileSync(
			args.outJson,
			JSON.stringify(
				{
					shard: args.shardPath,
					stats: args.statsPath,
					flags,
					summary: {
						errors: flags.filter((f) => f.severity === "error").length,
						warnings: flags.filter((f) => f.severity === "warn").length,
					},
				},
				null,
				2
			)
		)
	}

	const errorCount = flags.filter((f) => f.severity === "error").length

	if (errorCount > 0) {
		console.error(`LINT FAILED: ${errorCount} error(s).`)
		process.exit(1)
	}
	console.error("LINT PASSED.")
	process.exit(0)
}

main()
