/**
 * Measure-locale-gate.ts — v0.7 task #33 baseline.
 *
 * #33 asks for a "locale pre-classifier (lexical features → MLP)". Before building an MLP, measure
 * what the EXISTING rule-based `@mailwoman/locale-gate` (`detectLocaleSync`: postcode-shape +
 * script scoring over `QueryShape`) already achieves at predicting an address's country from
 * lexical cues alone. If the rule baseline is strong, #33 needs no new model — it's already
 * shipped, and the remaining system-aware work is #38 (per-system containment) + #39 (tree `system`
 * field).
 *
 * Ground truth: golden v0.1.2 `country` field + falsehoods `locale` region subtag. Detected: region
 * subtag of `detectLocaleSync(...).locale`.
 *
 * Run: node --experimental-strip-types scripts/eval/measure-locale-gate.ts\
 * [--golden data/eval/golden/v0.1.2] [--falsehoods data/eval/falsehoods]
 */

import { detectLocaleSync } from "@mailwoman/locale-gate"
import { computeQueryShape } from "@mailwoman/query-shape"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

function arg(name: string, fallback: string): string {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const GOLDEN = arg("golden", "data/eval/golden/v0.1.2")
const FALSEHOODS = arg("falsehoods", "data/eval/falsehoods")

interface Sample {
	input: string
	country: string // ISO alpha-2 ground truth
}

/** "en-US" → "US", "ja-JP" → "JP". Returns input uppercased if no subtag. */
function regionOf(locale: string): string {
	const parts = locale.split("-")
	return (parts[1] ?? parts[0] ?? "").toUpperCase()
}

function loadGolden(dir: string): Sample[] {
	const out: Sample[] = []
	for (const f of readdirSync(dir).filter((e) => e.endsWith(".jsonl"))) {
		for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
			if (!line.trim()) continue
			try {
				const row = JSON.parse(line)
				if (row.raw && row.country) out.push({ input: row.raw, country: row.country.toUpperCase() })
			} catch {
				/* skip */
			}
		}
	}
	return out
}

function loadFalsehoods(dir: string): Sample[] {
	const out: Sample[] = []
	for (const f of readdirSync(dir).filter((e) => e.endsWith(".jsonl"))) {
		for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
			if (!line.trim()) continue
			try {
				const row = JSON.parse(line)
				if (row.input && row.locale) out.push({ input: row.input, country: regionOf(row.locale) })
			} catch {
				/* skip */
			}
		}
	}
	return out
}

function main(): void {
	const samples = [...loadGolden(GOLDEN), ...loadFalsehoods(FALSEHOODS)]
	console.log(`# Locale-gate baseline (#33) — ${samples.length} samples\n`)

	const byCountry = new Map<string, { total: number; correct: number; conf: number }>()
	const confusion = new Map<string, Map<string, number>>()
	let correct = 0

	for (const s of samples) {
		const shape = computeQueryShape(s.input)
		const hint = detectLocaleSync({ raw: s.input, normalized: s.input }, shape)
		const detected = regionOf(hint.locale)
		const ok = detected === s.country
		if (ok) correct++

		const cs = byCountry.get(s.country) ?? { total: 0, correct: 0, conf: 0 }
		cs.total++
		if (ok) cs.correct++
		cs.conf += hint.confidence
		byCountry.set(s.country, cs)

		if (!ok) {
			const row = confusion.get(s.country) ?? new Map<string, number>()
			row.set(detected, (row.get(detected) ?? 0) + 1)
			confusion.set(s.country, row)
		}
	}

	console.log(`**Overall:** ${correct}/${samples.length} (${((100 * correct) / samples.length).toFixed(1)}%)\n`)
	console.log("| Country | Total | Correct | Rate | Mean conf |")
	console.log("|---------|------:|--------:|-----:|----------:|")
	for (const [country, cs] of [...byCountry.entries()].sort((a, b) => b[1].total - a[1].total)) {
		console.log(
			`| ${country} | ${cs.total} | ${cs.correct} | ${((100 * cs.correct) / cs.total).toFixed(1)}% | ${(cs.conf / cs.total).toFixed(2)} |`
		)
	}

	console.log("\n## Misclassifications (truth → detected)")
	for (const [truth, row] of confusion) {
		const parts = [...row.entries()].map(([d, n]) => `${d}×${n}`).join(", ")
		console.log(`- ${truth} → ${parts}`)
	}
}

main()
