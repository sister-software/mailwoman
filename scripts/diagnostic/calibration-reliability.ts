/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #1739 — do our confidences mean anything?
 *
 * Reliability of the SHIPPED decode distribution, measured at the unit a consumer actually reads: the assembled
 * COMPONENT. For every component the parse produced, take the weakest per-token softmax over the tokens carrying that
 * tag (the weakest link — a span is only as trustworthy as its least certain piece), and ask whether the component is
 * right against the golden set's labels.
 *
 * Correctness rule is the harness's own: case-insensitive string equality (`componentMatches`). A produced tag the gold
 * row does not carry at all counts as WRONG — predicting a component that should not exist is exactly the error a
 * calibrated confidence must not hide.
 *
 *   MEASURED 2026-08-19 (golden v0.1.3, both splits): the aggregate ECE of 0.034 hides opposite errors per tag —
 *   `street` is over-confident (top decile mean confidence 0.926, accuracy 0.730, n=1,894) while `locality` is
 *   under-confident (0.932 → 0.996). One scalar temperature cannot fix both directions, which is why any calibrator
 *   fitted from this has to be per class. Dev and test agree (street ECE 0.169 vs 0.183), so it is the model's
 *   property rather than our iteration's; and `gazetteer_prior: false` moves nothing (0.034 vs 0.036), so the
 *   default-ON FST prior is not what bends the curves.
 *
 *   Usage: node scripts/diagnostic/calibration-reliability.ts --corpus <path.jsonl> --label <name> [--no-fst]
 */
import { readFileSync } from "node:fs"
import { parseArgs } from "node:util"

import { parseJSONStrict } from "@mailwoman/core/objects"
import { repoRootPath } from "@mailwoman/core/utils"
import { EngineRegistry } from "@mailwoman/dev-mcp"

const { values } = parseArgs({
	options: {
		corpus: { type: "string", multiple: true },
		label: { type: "string" },
		"no-fst": { type: "boolean" },
		limit: { type: "string" },
	},
})

if (!values.corpus?.length) throw new Error("pass --corpus <path.jsonl> (repeatable)")

const BIN_COUNT = 10

interface Observation {
	tag: string
	locale: string
	confidence: number
	correct: boolean
}

function fold(value: string): string {
	return value.toLowerCase()
}

const rows: { input: string; components: Record<string, string>; locale: string }[] = []

for (const path of values.corpus) {
	const locale = path.split("/").pop()!.replace(".jsonl", "")

	// The golden splits are small, bounded and read once; streaming would add an async boundary to a synchronous
	// corpus load for no measurable gain.
	// oxlint-disable-next-line mailwoman/prefer-spliterator -- bounded input, one synchronous pass
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue

		// Strict: a corrupt golden row must stop the measurement, not silently shrink the sample.
		const row = parseJSONStrict<{ raw?: string; input?: string; components?: Record<string, string> }>(line)
		const input = row.raw ?? row.input

		if (!input || !row.components) continue

		rows.push({ input, components: row.components, locale })
	}
}

const limit = values.limit ? Number(values.limit) : rows.length
const subject = rows.slice(0, limit)

const registry = new EngineRegistry(String(repoRootPath()), 1)
const engine = await registry.acquire({ trace: true, ...(values["no-fst"] ? { gazetteer_prior: false } : {}) })

const observations: Observation[] = []
let parsed = 0

for (const row of subject) {
	const run = await engine.session.geocode(row.input)
	const tokens = run.trace?.parse?.tokens ?? []
	const produced = (run.result.components ?? {}) as Record<string, string | undefined>

	parsed++

	for (const [tag, value] of Object.entries(produced)) {
		if (!value) continue

		// The tokens carrying this tag, in either BIO position. A tag appearing in two separate spans is folded into
		// one observation: the result shape holds one value per tag, so one confidence is what a consumer sees.
		const carrying = tokens.filter((t) => t.label === `B-${tag}` || t.label === `I-${tag}`)

		if (!carrying.length) continue

		const confidence = Math.min(...carrying.map((t) => t.confidence))
		const expected = row.components[tag]

		observations.push({
			tag,
			locale: row.locale,
			confidence,
			correct: expected !== undefined && fold(value) === fold(expected),
		})
	}

	if (parsed % 500 === 0) {
		console.error(`  … ${parsed}/${subject.length} rows`)
	}
}

registry.closeAll()

/**
 * Equal-width bins over [0,1]; empty bins are reported as empty rather than dropped, because a model whose confidences
 * never enter the low bins is itself the finding.
 */
function reliability(sample: Observation[]): { table: string[]; ece: number; mce: number; n: number; acc: number } {
	const bins: Observation[][] = Array.from({ length: BIN_COUNT }, () => [])

	for (const o of sample) {
		const index = Math.min(BIN_COUNT - 1, Math.floor(o.confidence * BIN_COUNT))

		bins[index]!.push(o)
	}

	const table: string[] = []
	let ece = 0
	let mce = 0

	for (const [index, bin] of bins.entries()) {
		const low = (index / BIN_COUNT).toFixed(1)
		const high = ((index + 1) / BIN_COUNT).toFixed(1)

		if (!bin.length) {
			table.push(`  [${low}–${high})  n=0`)

			continue
		}

		const meanConfidence = bin.reduce((sum, o) => sum + o.confidence, 0) / bin.length
		const accuracy = bin.filter((o) => o.correct).length / bin.length
		const gap = Math.abs(accuracy - meanConfidence)

		ece += (bin.length / sample.length) * gap
		mce = Math.max(mce, gap)

		table.push(
			`  [${low}–${high})  n=${String(bin.length).padStart(5)}  conf=${meanConfidence.toFixed(3)}  ` +
				`acc=${accuracy.toFixed(3)}  gap=${(accuracy - meanConfidence >= 0 ? "+" : "") + (accuracy - meanConfidence).toFixed(3)}`
		)
	}

	return {
		table,
		ece,
		mce,
		n: sample.length,
		acc: sample.filter((o) => o.correct).length / (sample.length || 1),
	}
}

function report(name: string, sample: Observation[]): void {
	if (!sample.length) return

	const r = reliability(sample)

	console.log(
		`\n=== ${name}   n=${r.n}  accuracy=${r.acc.toFixed(3)}  ECE=${r.ece.toFixed(3)}  MCE=${r.mce.toFixed(3)}`
	)

	for (const line of r.table) {
		console.log(line)
	}
}

console.log(
	`\n#1739 reliability — label=${values.label ?? "(unlabelled)"}  rows=${subject.length}  ` +
		`observations=${observations.length}  fst=${values["no-fst"] ? "OFF" : "ON (default)"}`
)

report("ALL", observations)

for (const locale of [...new Set(observations.map((o) => o.locale))].toSorted()) {
	report(
		`locale:${locale}`,
		observations.filter((o) => o.locale === locale)
	)
}

const byTag = [...new Set(observations.map((o) => o.tag))]
	.map((tag) => ({ tag, n: observations.filter((o) => o.tag === tag).length }))
	.toSorted((a, b) => b.n - a.n)
	.slice(0, 6)

for (const { tag } of byTag) {
	report(
		`tag:${tag}`,
		observations.filter((o) => o.tag === tag)
	)
}
