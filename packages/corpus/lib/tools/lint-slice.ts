/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Corpus linter. Compares a new slice against pre-computed corpus statistics and flags patterns
 *   that would cause the class of failure we hit with v0.6.2's "5th Avenue Theatre" adversarial
 *   venue templates.
 *
 *   Per DeepSeek turn 9 design (2026-05-29). v1 checks:
 *
 *   1. **Token-label distribution outliers.** For each token in the new slice, compare the slice's
 *        majority label to the corpus's majority label. Flag when the corpus has a
 *        confidently-established majority (>66%) AND the slice's majority differs AND both have
 *        non-trivial counts (slice ≥ 50, corpus ≥ 200).
 *   2. **Label-vacuum tokens.** Token labeled with a tag that has ZERO instances in the corpus for that
 *        token, despite the token being well-represented in the corpus. Stronger signal than #1 —
 *        we're introducing a novel association, not shifting a distribution.
 *   3. **Bigram-label collisions.** Identical (token_bigram, label_bigram) appears in slice while the
 *        same token_bigram has a DIFFERENT majority label_bigram in the corpus. The "5th Avenue"
 *        with [B-venue, I-venue] vs corpus's [B-house_number, I-street] case.
 *   4. **Common-form anti-pattern rules.** Applies `lint-rules.json` — token-regex → forbidden-labels
 *        mappings — flagging matches.
 *   5. **Basic sanity.** Truncated rows (tokens.length !== labels.length), all-O rows >90% of slice.
 *
 *   Output: markdown report on stdout, optional JSON sidecar via `outJSON`. The command exits 0 if
 *   no errors, 1 if any errors (warnings don't gate). Per the design, the MANIFEST entry for a
 *   flagged slice should require `lint_acknowledged: true` before training consumes it.
 *
 *   Usage: mailwoman dev lint corpus-slice\
 *   --slice <new-slice.parquet>\
 *   --stats <corpus-stats.json>\
 *   [--rules <rules.json>]\
 *   [--out-md /tmp/lint-report.md]\
 *   [--out-json /tmp/lint-report.json]
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalFile, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"

import {
	accumulateCooccurrences,
	createCooccurrenceStats,
	SLICE_STATS_SEP as SEP,
	streamTokenLabelRows,
	type TokenLabelRow as SliceRow,
} from "#utils/slice-stats"

/**
 * Occurrences of a forbidden label before it is reported — one or two are noise, five is a pattern.
 */
const FORBIDDEN_LABEL_REPORT_THRESHOLD = 5

/**
 * Examples printed per finding before the list is truncated.
 */
const MAX_LISTED_EXAMPLES = 20

/**
 * Calibrated thresholds (DeepSeek turn 9). These can be tuned over time if new failure modes surface that the current
 * numbers miss.
 */
const CORPUS_CONFIDENCE_FLOOR = 0.66
const SLICE_MIN_COUNT = 50
const CORPUS_MIN_COUNT = 200
const VACUUM_SLICE_MIN_COUNT = 20
const VACUUM_CORPUS_MIN_COUNT = 100
const BIGRAM_MIN_COUNT = 10
const ALL_O_RATIO_CEILING = 0.9

/**
 * Default `lint-rules.json` path — the rules ship beside this module in the source tree. tsc does not emit
 * readFileSync'd JSON into `out/`, so the compiled tree falls back to the source-tree copy (corpus/out/src/tools/ →
 * corpus/src/tools/). In-repo the `node` exports condition loads this module from source anyway, so the sibling URL is
 * the common path.
 */
function defaultRulesPath(): string {
	return resolvePackagePath("@mailwoman/corpus", "lib", "tools", "lint-rules.json")
}

/**
 * Options for {@linkcode lintCorpusSlice}.
 */
export interface LintCorpusSliceOptions {
	/**
	 * The new slice parquet to lint.
	 */
	slicePath: string
	/**
	 * Pre-computed corpus stats JSON (see `corpus-stats.ts`).
	 */
	statsPath: string
	/**
	 * Anti-pattern rules JSON. Default: the `lint-rules.json` beside this module.
	 */
	rulesPath?: string
	/**
	 * Write the markdown report here as well as stdout.
	 */
	outMd?: string
	/**
	 * Write a JSON sidecar of the flags + summary here.
	 */
	outJSON?: string
}

interface CorpusStats {
	row_count: number
	slice_paths: string[]
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

interface SliceStats {
	rowCount: number
	tokens: Map<string, Map<string, number>>
	bigrams: Map<string, Map<string, number>>
	truncatedRows: number
	allORows: number
}

async function statsFromSlice(rows: AsyncIterable<SliceRow>): Promise<SliceStats> {
	const co = createCooccurrenceStats()

	const out: SliceStats = {
		rowCount: 0,
		tokens: co.tokens,
		bigrams: co.bigrams,
		truncatedRows: 0,
		allORows: 0,
	}

	for await (const row of rows) {
		out.rowCount++

		if (row.tokens.length !== row.labels.length) {
			out.truncatedRows++

			continue
		}

		if (row.labels.every((l) => l === "O")) {
			out.allORows++
		}

		accumulateCooccurrences(co, row.tokens, row.labels)
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

/**
 * One lint flag emitted by a check.
 */
export interface LintSliceFlag {
	check: string
	severity: "error" | "warn"
	token?: string
	bigram?: string
	sliceLabel?: string
	corpusLabel?: string
	sliceCount?: number
	corpusCount?: number
	detail: string
	ruleID?: string
}

/**
 * Findings summary returned by {@linkcode lintCorpusSlice}.
 */
export interface LintCorpusSliceSummary {
	errors: number
	warnings: number
	findings: LintSliceFlag[]
	/**
	 * The rendered markdown report (also printed to stdout).
	 */
	report: string
}

function checkDistributionOutliers(slice: SliceStats, corpus: CorpusStats): LintSliceFlag[] {
	const flags: LintSliceFlag[] = []

	for (const [token, sliceLabelMap] of slice.tokens) {
		const corpusLabelMap = corpus.tokens[token]

		if (!corpusLabelMap) continue
		const sliceMaj = majorityLabel(sliceLabelMap)
		const corpusMaj = majorityLabel(corpusLabelMap)

		if (
			corpusMaj.confidence >= CORPUS_CONFIDENCE_FLOOR &&
			sliceMaj.label !== corpusMaj.label &&
			sliceMaj.count >= SLICE_MIN_COUNT &&
			corpusMaj.total >= CORPUS_MIN_COUNT
		) {
			flags.push({
				check: "distribution-outlier",
				severity: "error",
				token,
				sliceLabel: sliceMaj.label,
				corpusLabel: corpusMaj.label,
				sliceCount: sliceMaj.count,
				corpusCount: corpusMaj.count,
				detail: `Token "${token}": slice majority is ${sliceMaj.label} (${sliceMaj.count}/${sliceMaj.total}, ${(sliceMaj.confidence * 100).toFixed(0)}%), corpus majority is ${corpusMaj.label} (${corpusMaj.count}/${corpusMaj.total}, ${(corpusMaj.confidence * 100).toFixed(0)}%).`,
			})
		}
	}

	return flags
}

function checkLabelVacuum(slice: SliceStats, corpus: CorpusStats): LintSliceFlag[] {
	const flags: LintSliceFlag[] = []

	for (const [token, sliceLabelMap] of slice.tokens) {
		const corpusLabelMap = corpus.tokens[token]

		if (!corpusLabelMap) continue
		const corpusTotal = Object.values(corpusLabelMap).reduce((a, b) => a + b, 0)

		if (corpusTotal < VACUUM_CORPUS_MIN_COUNT) continue

		for (const [label, sliceCount] of sliceLabelMap) {
			if (sliceCount < VACUUM_SLICE_MIN_COUNT) continue

			if (corpusLabelMap[label] === undefined || corpusLabelMap[label] === 0) {
				flags.push({
					check: "label-vacuum",
					severity: "error",
					token,
					sliceLabel: label,
					sliceCount,
					corpusCount: corpusTotal,
					detail: `Token "${token}": slice labels it ${label} ${sliceCount} times, but the corpus (${corpusTotal} instances of this token) has ZERO instances of this label.`,
				})
			}
		}
	}

	return flags
}

function checkBigramCollisions(slice: SliceStats, corpus: CorpusStats): LintSliceFlag[] {
	const flags: LintSliceFlag[] = []

	for (const [bigram, sliceLabelMap] of slice.bigrams) {
		const corpusLabelMap = corpus.bigrams[bigram]

		if (!corpusLabelMap) continue
		const sliceMaj = majorityLabel(sliceLabelMap)
		const corpusMaj = majorityLabel(corpusLabelMap)

		if (
			sliceMaj.label !== corpusMaj.label &&
			sliceMaj.count >= BIGRAM_MIN_COUNT &&
			corpusMaj.count >= BIGRAM_MIN_COUNT
		) {
			const renderBigram = bigram.split(SEP).join(" ")
			const renderSliceLabel = sliceMaj.label.split(SEP).join(" → ")
			const renderCorpusLabel = corpusMaj.label.split(SEP).join(" → ")

			flags.push({
				check: "bigram-collision",
				severity: "error",
				bigram: renderBigram,
				sliceLabel: renderSliceLabel,
				corpusLabel: renderCorpusLabel,
				sliceCount: sliceMaj.count,
				corpusCount: corpusMaj.count,
				detail: `Bigram "${renderBigram}": slice label-bigram is [${renderSliceLabel}] (${sliceMaj.count}×), corpus label-bigram is [${renderCorpusLabel}] (${corpusMaj.count}×). Same surface text, different structural reading.`,
			})
		}
	}

	return flags
}

function checkRules(slice: SliceStats, rulesFile: LintRulesFile): LintSliceFlag[] {
	const flags: LintSliceFlag[] = []

	const compiled = rulesFile.rules.map((r) => ({
		rule: r,
		regex: new RegExp(r.pattern, r.pattern_case_sensitive ? "" : "i"),
	}))

	for (const [token, labelMap] of slice.tokens) {
		for (const { rule, regex } of compiled) {
			if (!regex.test(token)) continue

			for (const [label, count] of labelMap) {
				if (rule.forbidden_labels.includes(label) && count >= FORBIDDEN_LABEL_REPORT_THRESHOLD) {
					flags.push({
						check: "anti-pattern-rule",
						severity: rule.severity,
						ruleID: rule.id,
						token,
						sliceLabel: label,
						sliceCount: count,
						detail: `Token "${token}" matched rule ${rule.id} and is labeled ${label} ${count} time(s). Rule message: ${rule.message}`,
					})
				}
			}
		}
	}

	return flags
}

function checkSanity(slice: SliceStats): LintSliceFlag[] {
	const flags: LintSliceFlag[] = []

	if (slice.truncatedRows > 0) {
		flags.push({
			check: "truncated-rows",
			severity: "error",
			detail: `${slice.truncatedRows} row(s) have tokens.length !== labels.length. Pipeline alignment bug.`,
		})
	}

	const allORatio = slice.allORows / Math.max(1, slice.rowCount)

	if (allORatio >= ALL_O_RATIO_CEILING) {
		flags.push({
			check: "all-O-slice",
			severity: "warn",
			detail: `${slice.allORows}/${slice.rowCount} rows (${(allORatio * 100).toFixed(0)}%) are entirely O-labeled. Slice contributes no signal.`,
		})
	}

	return flags
}

function renderReport(
	opts: { slicePath: string; statsPath: string; rulesPath: string },
	slice: SliceStats,
	flags: LintSliceFlag[]
): string {
	const errors = flags.filter((f) => f.severity === "error")
	const warns = flags.filter((f) => f.severity === "warn")
	const verdict = !errors.length ? "**PASS** ✓" : "**FLAGGED** ⚠"

	const lines: string[] = [
		`# Corpus Lint: ${verdict}`,
		"",
		`- **Slice:** \`${opts.slicePath}\``,
		`- **Corpus stats:** \`${opts.statsPath}\``,
		`- **Rules:** \`${opts.rulesPath}\``,
		`- **Slice rows:** ${slice.rowCount}`,
		`- **Unique tokens:** ${slice.tokens.size}`,
		`- **Unique bigrams:** ${slice.bigrams.size}`,
		"",
		`**Errors:** ${errors.length} (gates the slice's inclusion unless MANIFEST sets \`lint_acknowledged: true\`)`,
		`**Warnings:** ${warns.length} (advisory)`,
		"",
	]

	if (!flags.length) {
		lines.push("No anomalies detected.")

		return lines.join("\n")
	}

	const byCheck = new Map<string, LintSliceFlag[]>()

	for (const f of flags) {
		const arr = byCheck.get(f.check) ?? []
		arr.push(f)
		byCheck.set(f.check, arr)
	}

	for (const [check, list] of byCheck) {
		lines.push(`## ${check} (${list.length})`)
		lines.push("")
		// Sort by sliceCount desc — highest-volume issues first
		list.sort((a, b) => (b.sliceCount ?? 0) - (a.sliceCount ?? 0))

		for (const f of list.slice(0, 20)) {
			lines.push(`- **[${f.severity.toUpperCase()}]** ${f.detail}`)
		}

		if (list.length > MAX_LISTED_EXAMPLES) {
			lines.push(`- ... and ${list.length - 20} more`)
		}

		lines.push("")
	}

	return lines.join("\n")
}

/**
 * Lint a slice against corpus stats + the anti-pattern rules; print the markdown report to stdout.
 */
export async function lintCorpusSlice(
	options: LintCorpusSliceOptions,
	report?: (line: string) => void
): Promise<LintCorpusSliceSummary> {
	const rulesPath = options.rulesPath ?? defaultRulesPath()
	report?.(`Reading corpus stats from ${options.statsPath}...`)
	const corpus = await readLocalJSONFile<CorpusStats>(options.statsPath)

	report?.(
		`  ${corpus.row_count} rows from ${corpus.slice_paths.length} slice(s); ${Object.keys(corpus.tokens).length} tokens, ${Object.keys(corpus.bigrams).length} bigrams`
	)

	report?.(`Reading slice from ${options.slicePath}...`)

	const slice = await statsFromSlice(streamTokenLabelRows(options.slicePath))

	report?.(`  ${slice.rowCount} rows`)

	report?.(`Loading rules from ${rulesPath}...`)
	const rulesFile = await readLocalJSONFile<LintRulesFile>(rulesPath)

	report?.(`Running checks...`)

	const flags: LintSliceFlag[] = [
		...checkDistributionOutliers(slice, corpus),
		...checkLabelVacuum(slice, corpus),
		...checkBigramCollisions(slice, corpus),
		...checkRules(slice, rulesFile),
		...checkSanity(slice),
	]

	const rendered = renderReport({ slicePath: options.slicePath, statsPath: options.statsPath, rulesPath }, slice, flags)

	console.log(rendered)

	if (options.outMd) {
		await writeLocalFile(rendered, options.outMd)
	}

	if (options.outJSON) {
		await writeLocalJSONFile(
			{
				slice: options.slicePath,
				stats: options.statsPath,
				flags,
				summary: {
					errors: flags.filter((f) => f.severity === "error").length,
					warnings: flags.filter((f) => f.severity === "warn").length,
				},
			},
			options.outJSON
		)
	}

	const errorCount = flags.filter((f) => f.severity === "error").length
	const warningCount = flags.filter((f) => f.severity === "warn").length

	if (errorCount > 0) {
		report?.(`LINT FAILED: ${errorCount} error(s).`)
	} else {
		report?.("LINT PASSED.")
	}

	return { errors: errorCount, warnings: warningCount, findings: flags, report: rendered }
}
