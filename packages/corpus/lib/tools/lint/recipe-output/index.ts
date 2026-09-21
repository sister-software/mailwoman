/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Corpus linter. Compares a new recipe output (one parquet file) against pre-computed corpus
 *   statistics and flags patterns that would cause the class of failure we hit with v0.6.2's
 *   "5th Avenue Theatre" adversarial venue templates.
 *
 *   Per DeepSeek turn 9 design (2026-05-29). v1 checks:
 *
 *   1. **Token-label distribution outliers.** For each token in the new recipe output, compare the
 *        output's majority label to the corpus's majority label. Flag when the corpus has a
 *        confidently-established majority (>66%) and the output's majority differs and both have
 *        non-trivial counts (output ≥ 50, corpus ≥ 200).
 *   2. **Label-vacuum tokens.** Token labeled with a tag that has zero instances in the corpus for that
 *        token, despite the token being well-represented in the corpus. Stronger signal than #1 —
 *        we're introducing a novel association rather than shifting a distribution.
 *   3. **Bigram-label collisions.** Identical (token_bigram, label_bigram) appears in the output while
 *        the same token_bigram has a different majority label_bigram in the corpus. The "5th Avenue"
 *        with [B-venue, I-venue] vs corpus's [B-house_number, I-street] case.
 *   4. **Common-form anti-pattern rules.** Applies `lint-rules.json` — token-regex → forbidden-labels
 *        mappings — flagging matches.
 *   5. **Basic sanity.** Truncated rows (tokens.length !== labels.length), all-O rows >90% of the output.
 *
 *   Output: markdown report on stdout, optional JSON sidecar via `outJSON`. The command exits 0 if
 *   no errors, 1 if any errors (warnings don't refuse). Per the design, the manifest entry for a
 *   flagged recipe output should require `lint_acknowledged: true` before training consumes it.
 *
 *   Usage: mailwoman dev lint corpus-slice\
 *   --database <new-recipe-output.parquet>\
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
	COOCCURRENCE_KEY_SEP as SEP,
	streamTokenLabelRows,
	type TokenLabelRow as RecipeOutputRow,
} from "#utils/cooccurrence-stats"

/**
 * Occurrences of a forbidden label before it is reported — one or two are noise, five is a pattern.
 */
const FORBIDDEN_LABEL_REPORT_THRESHOLD = 5

/**
 * Examples printed per finding before the list is truncated.
 */
const MAX_LISTED_EXAMPLES = 20

/**
 * Calibrated thresholds (DeepSeek turn 9). These can be tuned over time if new
 * failure modes surface that the current numbers miss.
 */
const CORPUS_CONFIDENCE_FLOOR = 0.66
const OUTPUT_MIN_COUNT = 50
const CORPUS_MIN_COUNT = 200
const VACUUM_OUTPUT_MIN_COUNT = 20
const VACUUM_CORPUS_MIN_COUNT = 100
const BIGRAM_MIN_COUNT = 10
const ALL_O_RATIO_CEILING = 0.9

/**
 * Default `lint-rules.json` path — the rules ship beside this module in the source tree. tsc does
 * not emit readFileSync'd JSON into `out/`, so the compiled tree falls back to the source-tree
 * copy (corpus/out/src/tools/ → corpus/src/tools/). In-repo the `node` exports condition
 * loads this module from source anyway, so the sibling URL is the common path.
 */
function defaultRulesPath(): string {
	return resolvePackagePath("@mailwoman/corpus", "lib", "tools", "lint-rules.json")
}

/**
 * Options for {@linkcode lintRecipeOutput}.
 */
export interface LintRecipeOutputOptions {
	/**
	 * The new recipe output parquet to lint.
	 */
	recipeOutputPath: string
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

interface RecipeOutputStats {
	rowCount: number
	tokens: Map<string, Map<string, number>>
	bigrams: Map<string, Map<string, number>>
	truncatedRows: number
	allORows: number
}

async function statsFromRecipeOutput(rows: AsyncIterable<RecipeOutputRow>): Promise<RecipeOutputStats> {
	const co = createCooccurrenceStats()

	const out: RecipeOutputStats = {
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
export interface LintFlag {
	check: string
	severity: "error" | "warn"
	token?: string
	bigram?: string
	outputLabel?: string
	corpusLabel?: string
	outputCount?: number
	corpusCount?: number
	detail: string
	ruleID?: string
}

/**
 * Findings summary returned by {@linkcode lintRecipeOutput}.
 */
export interface LintRecipeOutputSummary {
	errors: number
	warnings: number
	findings: LintFlag[]
	/**
	 * The rendered markdown report (also printed to stdout).
	 */
	report: string
}

function checkDistributionOutliers(output: RecipeOutputStats, corpus: CorpusStats): LintFlag[] {
	const flags: LintFlag[] = []

	for (const [token, outputLabelMap] of output.tokens) {
		const corpusLabelMap = corpus.tokens[token]

		if (!corpusLabelMap) continue
		const outputMaj = majorityLabel(outputLabelMap)
		const corpusMaj = majorityLabel(corpusLabelMap)

		if (
			corpusMaj.confidence >= CORPUS_CONFIDENCE_FLOOR &&
			outputMaj.label !== corpusMaj.label &&
			outputMaj.count >= OUTPUT_MIN_COUNT &&
			corpusMaj.total >= CORPUS_MIN_COUNT
		) {
			flags.push({
				check: "distribution-outlier",
				severity: "error",
				token,
				outputLabel: outputMaj.label,
				corpusLabel: corpusMaj.label,
				outputCount: outputMaj.count,
				corpusCount: corpusMaj.count,
				detail: `Token "${token}": recipe-output majority is ${outputMaj.label} (${outputMaj.count}/${outputMaj.total}, ${(outputMaj.confidence * 100).toFixed(0)}%), corpus majority is ${corpusMaj.label} (${corpusMaj.count}/${corpusMaj.total}, ${(corpusMaj.confidence * 100).toFixed(0)}%).`,
			})
		}
	}

	return flags
}

function checkLabelVacuum(output: RecipeOutputStats, corpus: CorpusStats): LintFlag[] {
	const flags: LintFlag[] = []

	for (const [token, outputLabelMap] of output.tokens) {
		const corpusLabelMap = corpus.tokens[token]

		if (!corpusLabelMap) continue
		const corpusTotal = Object.values(corpusLabelMap).reduce((a, b) => a + b, 0)

		if (corpusTotal < VACUUM_CORPUS_MIN_COUNT) continue

		for (const [label, outputCount] of outputLabelMap) {
			if (outputCount < VACUUM_OUTPUT_MIN_COUNT) continue

			if (corpusLabelMap[label] === undefined || corpusLabelMap[label] === 0) {
				flags.push({
					check: "label-vacuum",
					severity: "error",
					token,
					outputLabel: label,
					outputCount,
					corpusCount: corpusTotal,
					detail: `Token "${token}": the recipe output labels it ${label} ${outputCount} times, but the corpus (${corpusTotal} instances of this token) has ZERO instances of this label.`,
				})
			}
		}
	}

	return flags
}

function checkBigramCollisions(output: RecipeOutputStats, corpus: CorpusStats): LintFlag[] {
	const flags: LintFlag[] = []

	for (const [bigram, outputLabelMap] of output.bigrams) {
		const corpusLabelMap = corpus.bigrams[bigram]

		if (!corpusLabelMap) continue
		const outputMaj = majorityLabel(outputLabelMap)
		const corpusMaj = majorityLabel(corpusLabelMap)

		if (
			outputMaj.label !== corpusMaj.label &&
			outputMaj.count >= BIGRAM_MIN_COUNT &&
			corpusMaj.count >= BIGRAM_MIN_COUNT
		) {
			const renderBigram = bigram.split(SEP).join(" ")
			const renderOutputLabel = outputMaj.label.split(SEP).join(" → ")
			const renderCorpusLabel = corpusMaj.label.split(SEP).join(" → ")

			flags.push({
				check: "bigram-collision",
				severity: "error",
				bigram: renderBigram,
				outputLabel: renderOutputLabel,
				corpusLabel: renderCorpusLabel,
				outputCount: outputMaj.count,
				corpusCount: corpusMaj.count,
				detail: `Bigram "${renderBigram}": recipe-output label-bigram is [${renderOutputLabel}] (${outputMaj.count}×), corpus label-bigram is [${renderCorpusLabel}] (${corpusMaj.count}×). Same surface text, different structural reading.`,
			})
		}
	}

	return flags
}

function checkRules(output: RecipeOutputStats, rulesFile: LintRulesFile): LintFlag[] {
	const flags: LintFlag[] = []

	const compiled = rulesFile.rules.map((r) => ({
		rule: r,
		regex: new RegExp(r.pattern, r.pattern_case_sensitive ? "" : "i"),
	}))

	for (const [token, labelMap] of output.tokens) {
		for (const { rule, regex } of compiled) {
			if (!regex.test(token)) continue

			for (const [label, count] of labelMap) {
				if (rule.forbidden_labels.includes(label) && count >= FORBIDDEN_LABEL_REPORT_THRESHOLD) {
					flags.push({
						check: "anti-pattern-rule",
						severity: rule.severity,
						ruleID: rule.id,
						token,
						outputLabel: label,
						outputCount: count,
						detail: `Token "${token}" matched rule ${rule.id} and is labeled ${label} ${count} time(s). Rule message: ${rule.message}`,
					})
				}
			}
		}
	}

	return flags
}

function checkSanity(output: RecipeOutputStats): LintFlag[] {
	const flags: LintFlag[] = []

	if (output.truncatedRows > 0) {
		flags.push({
			check: "truncated-rows",
			severity: "error",
			detail: `${output.truncatedRows} row(s) have tokens.length !== labels.length. Pipeline alignment bug.`,
		})
	}

	const allORatio = output.allORows / Math.max(1, output.rowCount)

	if (allORatio >= ALL_O_RATIO_CEILING) {
		flags.push({
			check: "all-O-output",
			severity: "warn",
			detail: `${output.allORows}/${output.rowCount} rows (${(allORatio * 100).toFixed(0)}%) are entirely O-labeled. The recipe output contributes no signal.`,
		})
	}

	return flags
}

function renderReport(
	opts: { outputPath: string; statsPath: string; rulesPath: string },
	output: RecipeOutputStats,
	flags: LintFlag[]
): string {
	const errors = flags.filter((f) => f.severity === "error")
	const warns = flags.filter((f) => f.severity === "warn")
	const verdict = !errors.length ? "**PASS** ✓" : "**FLAGGED** ⚠"

	const lines: string[] = [
		`# Corpus Lint: ${verdict}`,
		"",
		`- **Recipe output:** \`${opts.outputPath}\``,
		`- **Corpus stats:** \`${opts.statsPath}\``,
		`- **Rules:** \`${opts.rulesPath}\``,
		`- **Recipe output rows:** ${output.rowCount}`,
		`- **Unique tokens:** ${output.tokens.size}`,
		`- **Unique bigrams:** ${output.bigrams.size}`,
		"",
		`**Errors:** ${errors.length} (refuses the recipe output's inclusion unless MANIFEST sets \`lint_acknowledged: true\`)`,
		`**Warnings:** ${warns.length} (advisory)`,
		"",
	]

	if (!flags.length) {
		lines.push("No anomalies detected.")

		return lines.join("\n")
	}

	const byCheck = new Map<string, LintFlag[]>()

	for (const f of flags) {
		const arr = byCheck.get(f.check) ?? []
		arr.push(f)
		byCheck.set(f.check, arr)
	}

	for (const [check, list] of byCheck) {
		lines.push(`## ${check} (${list.length})`)
		lines.push("")
		// Highest-volume issues first.
		list.sort((a, b) => (b.outputCount ?? 0) - (a.outputCount ?? 0))

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
 * Lint a recipe output against corpus stats + the anti-pattern rules. print the markdown report to stdout.
 */
export async function lintRecipeOutput(
	options: LintRecipeOutputOptions,
	report?: (line: string) => void
): Promise<LintRecipeOutputSummary> {
	const rulesPath = options.rulesPath ?? defaultRulesPath()
	report?.(`Reading corpus stats from ${options.statsPath}...`)
	const corpus = await readLocalJSONFile<CorpusStats>(options.statsPath)

	report?.(
		`  ${corpus.row_count} rows from ${corpus.slice_paths.length} parquet file(s); ${Object.keys(corpus.tokens).length} tokens, ${Object.keys(corpus.bigrams).length} bigrams`
	)

	report?.(`Reading recipe output from ${options.recipeOutputPath}...`)

	const output = await statsFromRecipeOutput(streamTokenLabelRows(options.recipeOutputPath))

	report?.(`  ${output.rowCount} rows`)

	report?.(`Loading rules from ${rulesPath}...`)
	const rulesFile = await readLocalJSONFile<LintRulesFile>(rulesPath)

	report?.(`Running checks...`)

	const flags: LintFlag[] = [
		...checkDistributionOutliers(output, corpus),
		...checkLabelVacuum(output, corpus),
		...checkBigramCollisions(output, corpus),
		...checkRules(output, rulesFile),
		...checkSanity(output),
	]

	const rendered = renderReport(
		{ outputPath: options.recipeOutputPath, statsPath: options.statsPath, rulesPath },
		output,
		flags
	)

	console.log(rendered)

	if (options.outMd) {
		await writeLocalFile(rendered, options.outMd)
	}

	if (options.outJSON) {
		await writeLocalJSONFile(
			{
				recipe_output: options.recipeOutputPath,
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
