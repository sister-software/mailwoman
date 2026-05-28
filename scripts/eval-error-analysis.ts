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
 *   Usage: node --experimental-strip-types scripts/eval-error-analysis.ts\
 *   --golden data/eval/golden/v0.1.2
 */

import { decodeAsJson } from "@mailwoman/core/decoder"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

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

function parseArgs(): { goldenDir: string } {
	const args = process.argv.slice(2)
	let goldenDir: string | undefined
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--golden" && args[i + 1]) goldenDir = args[++i]
	}
	if (!goldenDir) {
		console.error("Usage: node scripts/eval-error-analysis.ts --golden <golden-dir>")
		process.exit(1)
	}
	return { goldenDir }
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
	const { goldenDir } = parseArgs()
	const golden = loadGolden(goldenDir)
	console.error(`Loaded ${golden.length} golden entries`)

	console.error("Loading model...")
	const classifier = await NeuralAddressClassifier.loadFromWeights()

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
		const tree = await classifier.parse(entry.raw)
		const predicted = decodeAsJson(tree)
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

		if (allCorrect) correct++

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
	console.log(`**Model:** ${classifier.constructor.name}`)
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
