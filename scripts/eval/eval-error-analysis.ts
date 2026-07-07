/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Error analysis framework for the neural address parser. Runs the model against the golden eval
 *   set and produces a categorized failure report.
 *
 *   Categories (per DeepSeek taxonomy):
 *
 *   1. Span-boundary errors — tag is correct but boundaries are off
 *   2. Missed entities — ground-truth span has zero correct tokens
 *   3. Hallucinated entities — predicted span overlaps no ground truth
 *   4. Near-class confusion — city↔state, street↔venue swaps
 *   5. Structural violations — illegal BIO transitions (I after O)
 *
 *   This is the pre-publish 2pp promote gate (night-shift skill: "run the full per-tag error analysis
 *   and compare against the current default release; abort the upload if any tag regresses >2pp").
 *   It therefore builds the classifier via the canonical `createScorer`
 *   (`@mailwoman/neural/scorer`, #718) in STRICT mode, so the model is fed the full SHIP-CONFIG it
 *   was TRAINED against — anchor + gazetteer + conventions, per the model-card's `requires` block.
 *   The prior `--model` path built a RAW `new NeuralAddressClassifier` with NO anchor/gazetteer, so
 *   a freshly-trained STAGE3 checkpoint was graded ANCHOR-OFF (admin tags collapse) while the
 *   no-`--model` default (loadFromWeights) was anchor-ON — the candidate was scored OOD against an
 *   in-distribution baseline, the #566/#685 trap this very gate exists to prevent. `--no-strict`
 *   warns-and-continues for ad-hoc/legacy (pre-anchor) models instead of failing closed.
 *
 *   Usage: node --experimental-strip-types scripts/eval-error-analysis.ts\
 *   --golden data/eval/golden/v0.1.2 Grade a candidate: ... --model ./out/v.../model.onnx --tokenizer
 *   <spm> --model-card <json>
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { parseArgs as parseNodeArgs } from "node:util"

import { decodeAsJSON } from "@mailwoman/core/decoder"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { createScorer } from "@mailwoman/neural/scorer"
import { resolveWeights } from "@mailwoman/neural/weights"

interface GoldenEntry {
	raw: string
	components: Record<string, string>
	country: string
	source: string
}

interface CategoryStats {
	total: number
	examples: Array<{ raw: string; detail: string }>
}

interface Args {
	goldenDir: string
	modelPath?: string
	tokenizerPath?: string
	modelCardPath?: string
	postcodeRepair: boolean
	/** STRICT ship-config feed (#718): fail closed if a model-card-declared channel can't be fed. */
	strict: boolean
}

function parseArgs(): Args {
	const out: Partial<Args> = { postcodeRepair: false, strict: true }

	// node:util parseArgs (strict:false = old scan parity: unknown flags tolerated)
	const { values } = parseNodeArgs({
		args: process.argv.slice(2),
		options: {
			golden: { type: "string" },
			model: { type: "string" },
			"model-card": { type: "string" },
			"no-strict": { type: "boolean" },
			"postcode-repair": { type: "boolean" },
			tokenizer: { type: "string" },
		},
		strict: false,
		allowPositionals: true,
	})

	if (values["golden"] != null) out.goldenDir = values["golden"] as string
	if (values["model"] != null) out.modelPath = values["model"] as string
	if (values["tokenizer"] != null) out.tokenizerPath = values["tokenizer"] as string
	if (values["model-card"] != null) out.modelCardPath = values["model-card"] as string
	if (values["postcode-repair"] != null) out.postcodeRepair = true
	if (values["no-strict"] != null) out.strict = false

	if (!out.goldenDir) {
		console.error(
			"Usage: node scripts/eval-error-analysis.ts --golden <golden-dir> " +
				"[--model <onnx> --tokenizer <spm> --model-card <json>] [--postcode-repair]"
		)
		process.exit(1)
	}

	// --model requires the tokenizer + card to build a non-default classifier.
	if (out.modelPath && (!out.tokenizerPath || !out.modelCardPath)) {
		console.error("--model requires --tokenizer and --model-card")
		process.exit(1)
	}

	return out as Args
}

function loadGolden(dir: string): GoldenEntry[] {
	const entries: GoldenEntry[] = []

	for (const file of ["us.jsonl", "fr.jsonl", "adversarial.jsonl"]) {
		const path = resolve(dir, file)

		try {
			const text = readFileSync(path, "utf8")

			for (const line of text.split("\n")) {
				if (!line.trim()) continue
				entries.push(JSON.parse(line))
			}
		} catch {
			// file may not exist
		}
	}

	return entries
}

async function main() {
	const args = parseArgs()
	const golden = loadGolden(args.goldenDir)
	console.error(`Loaded ${golden.length} golden entries`)

	console.error("Loading model...")
	const parseOpts = args.postcodeRepair
		? ({ postcodeRepair: true } as Parameters<NeuralAddressClassifier["parse"]>[1])
		: undefined
	// Full SHIP-CONFIG via the canonical ProductionScorer (#718) — feed the anchor + gazetteer +
	// conventions channels the model was trained against (per the model-card `requires` block) so a
	// `--model` candidate is graded in-distribution, the same as the dev-weights default. createScorer
	// fails closed in strict mode if a declared channel can't actually be fed; `--no-strict` opts out.
	const resolved = args.modelPath
		? { modelPath: args.modelPath, tokenizerPath: args.tokenizerPath!, modelCardPath: args.modelCardPath! }
		: resolveWeights({ locale: "en-us" })

	if (!resolved.modelPath || !resolved.tokenizerPath || !resolved.modelCardPath)
		throw new Error("createScorer needs model + tokenizer + model-card; resolveWeights returned incomplete paths")
	const classifier = await createScorer({
		modelPath: resolved.modelPath,
		tokenizerPath: resolved.tokenizerPath,
		modelCardPath: resolved.modelCardPath,
		strict: args.strict,
	})

	const missed: CategoryStats = { total: 0, examples: [] }
	const hallucinated: CategoryStats = { total: 0, examples: [] }
	const confused: CategoryStats = { total: 0, examples: [] }
	const boundaryErrors: CategoryStats = { total: 0, examples: [] }
	let correct = 0
	let total = 0

	const tagConfusion = new Map<string, Map<string, number>>()

	// Per-tag stats: { tag → { expected_count, correct_count, missed_count, boundary_count, confused_count } }
	type TagStats = {
		expected: number
		correct: number
		missed: number
		boundary: number
		confused: number
		hallucinated: number
	}
	const perTag = new Map<string, TagStats>()
	function tagStat(tag: string): TagStats {
		let s = perTag.get(tag)

		if (!s) {
			s = { expected: 0, correct: 0, missed: 0, boundary: 0, confused: 0, hallucinated: 0 }
			perTag.set(tag, s)
		}

		return s
	}

	console.error("Running eval...")
	const t0 = performance.now()

	for (const entry of golden) {
		total++
		const tree = await classifier.parse(entry.raw, parseOpts)
		const predicted = decodeAsJSON(tree)
		const expected = entry.components

		let allCorrect = true

		for (const [tag, value] of Object.entries(expected)) {
			const predValue = predicted[tag as keyof typeof predicted]
			tagStat(tag).expected++

			if (!predValue) {
				missed.total++
				tagStat(tag).missed++

				if (missed.examples.length < 10) {
					missed.examples.push({ raw: entry.raw, detail: `missing ${tag}="${value}"` })
				}
				allCorrect = false
			} else if (predValue !== value) {
				const predNorm = String(predValue).toLowerCase().trim()
				const expNorm = value.toLowerCase().trim()

				if (predNorm.includes(expNorm) || expNorm.includes(predNorm)) {
					boundaryErrors.total++
					tagStat(tag).boundary++

					if (boundaryErrors.examples.length < 10) {
						boundaryErrors.examples.push({
							raw: entry.raw,
							detail: `${tag}: expected "${value}" got "${predValue}"`,
						})
					}
				} else {
					confused.total++
					tagStat(tag).confused++

					if (confused.examples.length < 10) {
						confused.examples.push({
							raw: entry.raw,
							detail: `${tag}: expected "${value}" got "${predValue}"`,
						})
					}
				}
				allCorrect = false
			} else {
				tagStat(tag).correct++
			}
		}

		for (const [tag] of Object.entries(predicted)) {
			if (!(tag in expected)) {
				hallucinated.total++
				tagStat(tag).hallucinated++

				if (hallucinated.examples.length < 10) {
					hallucinated.examples.push({
						raw: entry.raw,
						detail: `hallucinated ${tag}="${predicted[tag as keyof typeof predicted]}"`,
					})
				}
				allCorrect = false
			}
		}

		if (allCorrect) {
			correct++
		}

		if (total % 500 === 0) {
			const elapsed = (performance.now() - t0) / 1000
			console.error(`  ${total}/${golden.length} (${elapsed.toFixed(1)}s)`)
		}
	}

	const elapsed = ((performance.now() - t0) / 1000).toFixed(1)

	// Output markdown report
	console.log("# Error Analysis Report")
	console.log("")
	console.log(`**Golden set:** ${golden.length} entries`)
	console.log(`**Model:** ${args.modelPath ?? "default weights"}${args.postcodeRepair ? " (+postcode-repair)" : ""}`)
	console.log(`**Time:** ${elapsed}s`)
	console.log("")
	console.log("## Summary")
	console.log("")
	console.log(`| Metric | Count | Rate |`)
	console.log(`|--------|-------|------|`)
	console.log(`| Exact match | ${correct} | ${((100 * correct) / total).toFixed(1)}% |`)
	console.log(`| Missed entities | ${missed.total} | — |`)
	console.log(`| Boundary errors | ${boundaryErrors.total} | — |`)
	console.log(`| Confused tags | ${confused.total} | — |`)
	console.log(`| Hallucinated tags | ${hallucinated.total} | — |`)
	console.log("")

	// Per-tag breakdown
	console.log("## Per-tag breakdown")
	console.log("")
	console.log("| Tag | Expected | Correct | Missed | Boundary | Confused | Hallucinated | Recall |")
	console.log("|-----|----------|---------|--------|----------|----------|--------------|--------|")
	const sortedTags = [...perTag.entries()].sort((a, b) => b[1].expected - a[1].expected)

	for (const [tag, s] of sortedTags) {
		const recall = s.expected > 0 ? ((100 * s.correct) / s.expected).toFixed(1) + "%" : "—"
		console.log(
			`| ${tag} | ${s.expected} | ${s.correct} | ${s.missed} | ${s.boundary} | ${s.confused} | ${s.hallucinated} | ${recall} |`
		)
	}
	console.log("")

	for (const [name, stats] of [
		["Missed entities", missed],
		["Boundary errors", boundaryErrors],
		["Confused tags", confused],
		["Hallucinated tags", hallucinated],
	] as const) {
		if (stats.total === 0) continue
		console.log(`## ${name} (${stats.total})`)
		console.log("")

		for (const ex of stats.examples.slice(0, 5)) {
			console.log(`- \`${ex.raw}\` — ${ex.detail}`)
		}
		console.log("")
	}
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
