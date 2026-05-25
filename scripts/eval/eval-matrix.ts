/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Product-level eval matrix — comparison script as release gate.
 *
 *   Runs multiple pipeline modes against golden v0.1.2 + kryptonite catalogue and emits a structured
 *   report (JSON + human-readable Markdown table). Designed to be the release gate for all future
 *   weights: every `@mailwoman/neural-weights-*` publish must produce a dated matrix report under
 *   `docs/articles/evals/`.
 *
 *   Modes compared:
 *
 *   - Rule-only (legacy v1 parser, no neural classifier)
 *   - Neural (neural classifier, Viterbi with structural BIO mask, no rules)
 *   - Hybrid (current default — rule + neural per policy registry)
 *   - Hybrid-joint (hybrid + forceJointReconcile flag with real top-K)
 *
 *   Metrics per mode:
 *
 *   - Per-component P/R/F1
 *   - Full-parse exact match
 *   - Parse-level calibration (4 confidence buckets)
 *   - Empty-parse rate
 *   - Overconfident-wrong rate (conf > 0.9 but parse wrong)
 *   - Per-failure-class breakdown (from golden notes tags)
 *
 *   Usage: npx tsx scripts/eval/eval-matrix.ts [--golden-dir data/eval/golden/v0.1.2]
 *
 *   Outputs JSON report to stdout, human-readable summary to stderr.
 */

import { NeuralAddressClassifier } from "@mailwoman/neural"
import { createAddressParser, createRuntimePipeline } from "mailwoman"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GoldenRow {
	raw: string
	components: Record<string, string>
	country: string
	source: string
	notes?: string
}

interface ParseResult {
	components: Record<string, string>
	confidence: number
	isEmpty: boolean
}

interface PerTagMetrics {
	tp: number
	fp: number
	fn: number
	precision: number
	recall: number
	f1: number
}

interface ModeReport {
	mode: string
	totalRows: number
	exactMatch: number
	exactMatchRate: number
	emptyParseCount: number
	emptyParseRate: number
	overconfidentWrongCount: number
	overconfidentWrongRate: number
	calibration: Record<string, { total: number; correct: number; accuracy: number }>
	perTag: Record<string, PerTagMetrics>
	macroF1: number
	perFailureClass: Record<string, { total: number; exactMatch: number; rate: number }>
}

// ---------------------------------------------------------------------------
// Golden loader
// ---------------------------------------------------------------------------

function loadGolden(dir: string): GoldenRow[] {
	const rows: GoldenRow[] = []
	for (const file of ["us.jsonl", "fr.jsonl", "adversarial.jsonl"]) {
		const path = resolve(dir, file)
		try {
			const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean)
			for (const line of lines) rows.push(JSON.parse(line))
		} catch {
			// file may not exist
		}
	}
	return rows
}

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

function normalizeComponent(v: string | undefined): string {
	return (v ?? "").trim().toLowerCase()
}

function exactMatch(predicted: Record<string, string>, expected: Record<string, string>): boolean {
	const allKeys = new Set([...Object.keys(predicted), ...Object.keys(expected)])
	for (const key of allKeys) {
		if (normalizeComponent(predicted[key]) !== normalizeComponent(expected[key])) return false
	}
	return true
}

function extractFailureClasses(row: GoldenRow): string[] {
	const notes = row.notes ?? ""
	const classes: string[] = []

	if (/kryptonite/i.test(notes)) {
		const match = notes.match(/kryptonite\/([a-z\-]+)/i)
		if (match) classes.push(`kryptonite/${match[1]}`)
		else classes.push("kryptonite/general")
	}

	// Map to the "addresses that break geocoders" taxonomy
	if (/ambiguous|springfield|paris.*texas/i.test(notes)) classes.push("failure/ambiguous-locality")
	if (/repeated.*admin|NY-NY/i.test(notes)) classes.push("failure/repeated-admin")
	if (/tokeniz|whitespace/i.test(notes)) classes.push("failure/tokenization-trap")
	if (/street.*local|collisi/i.test(notes)) classes.push("failure/street-locality-collision")
	if (/numeric|house.*number.*postcode/i.test(notes)) classes.push("failure/numeric-chaos")
	if (/unicode|transliter|non.?latin/i.test(notes)) classes.push("failure/unicode-trap")
	if (/language.*switch|mixed.*script/i.test(notes)) classes.push("failure/language-switch")
	if (/admin.*nightmare|hierarchy/i.test(notes)) classes.push("failure/admin-nightmare")

	if (classes.length === 0) classes.push("normal")
	return classes
}

function treeToComponents(tree: { roots: Array<{ tag?: string; value?: string }> }): Record<string, string> {
	const out: Record<string, string> = {}
	for (const node of tree.roots ?? []) {
		if (node.tag && node.value) out[node.tag] = node.value
	}
	return out
}

function averageConfidence(tree: { roots: Array<{ confidence?: number }> }): number {
	const confs = (tree.roots ?? []).map((n) => n.confidence ?? 0).filter((c) => c > 0)
	if (confs.length === 0) return 0
	return confs.reduce((a, b) => a + b, 0) / confs.length
}

// ---------------------------------------------------------------------------
// Metrics computation
// ---------------------------------------------------------------------------

function computeMetrics(
	mode: string,
	results: Array<{
		predicted: Record<string, string>
		expected: Record<string, string>
		confidence: number
		failureClasses: string[]
	}>
): ModeReport {
	const totalRows = results.length

	// Exact match
	let exactMatchCount = 0
	for (const r of results) {
		if (exactMatch(r.predicted, r.expected)) exactMatchCount++
	}

	// Empty parse
	const emptyParseCount = results.filter((r) => Object.keys(r.predicted).length === 0).length

	// Calibration buckets
	const buckets: Record<string, { total: number; correct: number }> = {
		"conf>0.9": { total: 0, correct: 0 },
		"conf:0.7-0.9": { total: 0, correct: 0 },
		"conf:0.5-0.7": { total: 0, correct: 0 },
		"conf<0.5": { total: 0, correct: 0 },
	}

	let overconfidentWrongCount = 0

	for (const r of results) {
		const isCorrect = exactMatch(r.predicted, r.expected)
		const bucket =
			r.confidence > 0.9
				? "conf>0.9"
				: r.confidence > 0.7
					? "conf:0.7-0.9"
					: r.confidence > 0.5
						? "conf:0.5-0.7"
						: "conf<0.5"
		buckets[bucket]!.total++
		if (isCorrect) buckets[bucket]!.correct++

		if (r.confidence > 0.9 && !isCorrect) overconfidentWrongCount++
	}

	const calibration: Record<string, { total: number; correct: number; accuracy: number }> = {}
	for (const [k, v] of Object.entries(buckets)) {
		calibration[k] = { ...v, accuracy: v.total > 0 ? v.correct / v.total : 0 }
	}

	// Per-tag P/R/F1
	const allTags = new Set<string>()
	for (const r of results) {
		for (const k of Object.keys(r.expected)) allTags.add(k)
		for (const k of Object.keys(r.predicted)) allTags.add(k)
	}

	const perTag: Record<string, PerTagMetrics> = {}
	let f1Sum = 0
	let tagCount = 0

	for (const tag of allTags) {
		let tp = 0,
			fp = 0,
			fn = 0
		for (const r of results) {
			const pred = normalizeComponent(r.predicted[tag])
			const gold = normalizeComponent(r.expected[tag])
			if (pred && gold && pred === gold) tp++
			else if (pred && (!gold || pred !== gold)) fp++
			if (gold && (!pred || pred !== gold)) fn++
		}
		const precision = tp / Math.max(tp + fp, 1)
		const recall = tp / Math.max(tp + fn, 1)
		const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0
		perTag[tag] = { tp, fp, fn, precision, recall, f1 }
		f1Sum += f1
		tagCount++
	}

	const macroF1 = tagCount > 0 ? f1Sum / tagCount : 0

	// Per-failure-class
	const failureClassMap = new Map<string, { total: number; exactMatch: number }>()
	for (const r of results) {
		const isCorrect = exactMatch(r.predicted, r.expected)
		for (const fc of r.failureClasses) {
			const entry = failureClassMap.get(fc) ?? { total: 0, exactMatch: 0 }
			entry.total++
			if (isCorrect) entry.exactMatch++
			failureClassMap.set(fc, entry)
		}
	}

	const perFailureClass: Record<string, { total: number; exactMatch: number; rate: number }> = {}
	for (const [fc, v] of failureClassMap) {
		perFailureClass[fc] = { ...v, rate: v.total > 0 ? v.exactMatch / v.total : 0 }
	}

	return {
		mode,
		totalRows,
		exactMatch: exactMatchCount,
		exactMatchRate: exactMatchCount / Math.max(totalRows, 1),
		emptyParseCount,
		emptyParseRate: emptyParseCount / Math.max(totalRows, 1),
		overconfidentWrongCount,
		overconfidentWrongRate: overconfidentWrongCount / Math.max(totalRows, 1),
		calibration,
		perTag,
		macroF1,
		perFailureClass,
	}
}

// ---------------------------------------------------------------------------
// Mode runners
// ---------------------------------------------------------------------------

type ModeRunner = (row: GoldenRow) => Promise<{ components: Record<string, string>; confidence: number }>

function createRuleOnlyRunner(): ModeRunner {
	const parser = createAddressParser()
	return async (row) => {
		const solutions = await parser.parse(row.raw)
		if (!solutions || solutions.length === 0) return { components: {}, confidence: 0 }
		const top = solutions[0]!
		const components: Record<string, string> = {}
		// classifications is Partial<Record<VisibleClassification, string[]>>
		for (const [tag, values] of Object.entries(top.classifications ?? {})) {
			if (values && values.length > 0) {
				components[tag] = values.join(" ")
			}
		}
		return { components, confidence: top.score ?? 0 }
	}
}

interface WeightsOpts {
	modelPath?: string
	tokenizerPath?: string
}

async function loadClassifier(opts: WeightsOpts): Promise<NeuralAddressClassifier> {
	return NeuralAddressClassifier.loadFromWeights({
		locale: "en-US",
		...(opts.modelPath ? { modelPath: opts.modelPath } : {}),
		...(opts.tokenizerPath ? { tokenizerPath: opts.tokenizerPath } : {}),
	})
}

async function createNeuralArgmaxRunner(opts: WeightsOpts): Promise<ModeRunner> {
	const classifier = await loadClassifier(opts)
	return async (row) => {
		const tree = await classifier.parse(row.raw)
		return { components: treeToComponents(tree), confidence: averageConfidence(tree) }
	}
}

async function createHybridRunner(opts: WeightsOpts): Promise<ModeRunner> {
	const classifier = await loadClassifier(opts)
	const pipeline = createRuntimePipeline({ classifier })
	return async (row) => {
		const result = await pipeline(row.raw)
		return { components: treeToComponents(result.tree), confidence: averageConfidence(result.tree) }
	}
}

async function createHybridJointRunner(opts: WeightsOpts): Promise<ModeRunner> {
	const classifier = await loadClassifier(opts)
	const pipeline = createRuntimePipeline({ classifier })
	return async (row) => {
		const result = await pipeline(row.raw, { forceJointReconcile: true })
		return { components: treeToComponents(result.tree), confidence: averageConfidence(result.tree) }
	}
}

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

function formatMarkdown(reports: ModeReport[]): string {
	const lines: string[] = []
	lines.push("# Eval Matrix Report")
	lines.push("")
	lines.push(`Generated: ${new Date().toISOString()}`)
	lines.push(`Golden rows: ${reports[0]?.totalRows ?? 0}`)
	lines.push("")

	// Summary table
	lines.push("## Summary")
	lines.push("")
	lines.push("| Mode | Exact Match | Macro F1 | Empty Parse | Overconf Wrong |")
	lines.push("|---|---|---|---|---|")
	for (const r of reports) {
		lines.push(
			`| ${r.mode} | ${(r.exactMatchRate * 100).toFixed(1)}% | ${(r.macroF1 * 100).toFixed(1)}% | ${(r.emptyParseRate * 100).toFixed(1)}% | ${(r.overconfidentWrongRate * 100).toFixed(1)}% |`
		)
	}
	lines.push("")

	// Per-tag detail for each mode
	for (const r of reports) {
		lines.push(`## ${r.mode}`)
		lines.push("")
		lines.push("### Per-component F1")
		lines.push("")
		lines.push("| Tag | P | R | F1 | TP | FP | FN |")
		lines.push("|---|---|---|---|---|---|---|")
		for (const [tag, m] of Object.entries(r.perTag).sort((a, b) => b[1].f1 - a[1].f1)) {
			lines.push(
				`| ${tag} | ${(m.precision * 100).toFixed(1)}% | ${(m.recall * 100).toFixed(1)}% | ${(m.f1 * 100).toFixed(1)}% | ${m.tp} | ${m.fp} | ${m.fn} |`
			)
		}
		lines.push("")

		lines.push("### Calibration")
		lines.push("")
		lines.push("| Bucket | Total | Correct | Accuracy |")
		lines.push("|---|---|---|---|")
		for (const [bucket, v] of Object.entries(r.calibration)) {
			lines.push(`| ${bucket} | ${v.total} | ${v.correct} | ${(v.accuracy * 100).toFixed(1)}% |`)
		}
		lines.push("")

		if (Object.keys(r.perFailureClass).length > 0) {
			lines.push("### Per-failure-class")
			lines.push("")
			lines.push("| Class | Total | Exact Match | Rate |")
			lines.push("|---|---|---|---|")
			for (const [fc, v] of Object.entries(r.perFailureClass).sort((a, b) => a[1].rate - b[1].rate)) {
				lines.push(`| ${fc} | ${v.total} | ${v.exactMatch} | ${(v.rate * 100).toFixed(1)}% |`)
			}
			lines.push("")
		}
	}

	return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	const goldenDir =
		process.argv.find((a) => a.startsWith("--golden-dir="))?.split("=")[1] ?? resolve("data/eval/golden/v0.1.2")
	const modelPath = process.argv.find((a) => a.startsWith("--model-path="))?.split("=")[1]
	const tokenizerPath = process.argv.find((a) => a.startsWith("--tokenizer-path="))?.split("=")[1]

	const weightsOpts: WeightsOpts = { modelPath, tokenizerPath }

	const rows = loadGolden(goldenDir)
	console.error(`loaded ${rows.length} golden rows`)
	if (modelPath) console.error(`using custom model: ${modelPath}`)
	if (tokenizerPath) console.error(`using custom tokenizer: ${tokenizerPath}`)

	// Build runners
	console.error("building runners...")
	const runners: Array<{ mode: string; run: ModeRunner }> = []

	console.error("  rule-only...")
	runners.push({ mode: "rule-only", run: createRuleOnlyRunner() })

	console.error("  neural...")
	runners.push({ mode: "neural", run: await createNeuralArgmaxRunner(weightsOpts) })

	console.error("  hybrid...")
	runners.push({ mode: "hybrid", run: await createHybridRunner(weightsOpts) })

	console.error("  hybrid-joint...")
	runners.push({ mode: "hybrid-joint", run: await createHybridJointRunner(weightsOpts) })

	const reports: ModeReport[] = []

	for (const { mode, run } of runners) {
		console.error(`\nrunning ${mode}...`)
		const results: Array<{
			predicted: Record<string, string>
			expected: Record<string, string>
			confidence: number
			failureClasses: string[]
		}> = []
		let processed = 0

		for (const row of rows) {
			try {
				const { components, confidence } = await run(row)
				results.push({
					predicted: components,
					expected: row.components,
					confidence,
					failureClasses: extractFailureClasses(row),
				})
			} catch {
				results.push({
					predicted: {},
					expected: row.components,
					confidence: 0,
					failureClasses: extractFailureClasses(row),
				})
			}

			processed++
			if (processed % 500 === 0) console.error(`  ${processed}/${rows.length}...`)
		}

		const report = computeMetrics(mode, results)
		reports.push(report)

		console.error(
			`  ${mode}: exact_match=${(report.exactMatchRate * 100).toFixed(1)}% macro_f1=${(report.macroF1 * 100).toFixed(1)}% empty=${(report.emptyParseRate * 100).toFixed(1)}%`
		)
	}

	// Markdown report to stderr
	const markdown = formatMarkdown(reports)
	console.error("\n" + markdown)

	// JSON to stdout
	console.log(JSON.stringify({ generated: new Date().toISOString(), goldenDir, reports }, null, 2))

	// Optionally write markdown to file
	const outPath = process.argv.find((a) => a.startsWith("--out="))?.split("=")[1]
	if (outPath) {
		writeFileSync(outPath, markdown, "utf-8")
		console.error(`\nMarkdown report written to ${outPath}`)
	}
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
