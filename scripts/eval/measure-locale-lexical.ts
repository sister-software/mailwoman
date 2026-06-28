/**
 * Measure-locale-lexical.ts — v0.7 task #33, step 2.
 *
 * Measure-locale-gate.ts showed the postcode-shape baseline collapses every 5-digit-postcode country (FR/DE/NL) onto
 * US. This probes whether RICHER lexical features — diacritics, street-type morphology, toponym/country words — recover
 * those countries with rules alone. It's a rule-based proxy for the #33 "lexical features → MLP": if a handful of
 * features already separate the same-postcode-shape countries, an MLP's job is mostly feature-learning we can
 * bootstrap; if not, the MLP needs to be richer.
 *
 * Standalone measurement — does NOT touch the shipped locale-gate pipeline.
 *
 * Run: node --experimental-strip-types scripts/eval/measure-locale-lexical.ts
 */

import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { detectLocaleSync } from "@mailwoman/locale-gate"
import { computeQueryShape } from "@mailwoman/query-shape"

const GOLDEN = "data/eval/golden/v0.1.2"
const FALSEHOODS = "data/eval/falsehoods"

interface Sample {
	input: string
	country: string
}

function regionOf(locale: string): string {
	const p = locale.split("-")

	return (p[1] ?? p[0] ?? "").toUpperCase()
}

function load(): Sample[] {
	const out: Sample[] = []

	for (const f of readdirSync(GOLDEN).filter((e) => e.endsWith(".jsonl"))) {
		for (const line of readFileSync(join(GOLDEN, f), "utf8").split("\n")) {
			if (!line.trim()) continue

			try {
				const r = JSON.parse(line)

				if (r.raw && r.country) out.push({ input: r.raw, country: r.country.toUpperCase() })
			} catch {
				/* skip */
			}
		}
	}

	for (const f of readdirSync(FALSEHOODS).filter((e) => e.endsWith(".jsonl"))) {
		for (const line of readFileSync(join(FALSEHOODS, f), "utf8").split("\n")) {
			if (!line.trim()) continue

			try {
				const r = JSON.parse(line)

				if (r.input && r.locale) out.push({ input: r.input, country: regionOf(r.locale) })
			} catch {
				/* skip */
			}
		}
	}

	return out
}

// --- Lexical feature rules (additive over the postcode-shape baseline) ---
// Each returns a country code if its signal fires, else null. Order = priority.
const FR_DIACRITICS = /[àâäéèêëïîôöùûüçœ]/i
const LEXICAL: Array<{ country: string; test: (t: string, lower: string) => boolean }> = [
	// French: accented chars OR French street/PO words OR CEDEX.
	{
		country: "FR",
		test: (t, l) =>
			FR_DIACRITICS.test(t) ||
			/\bcedex\b/.test(l) ||
			/\b(rue|avenue|av|boulevard|bd|impasse|allée|allee|chemin|quai|cours|place)\b/.test(l) ||
			/\bfrance\b/.test(l),
	},
	// German: ß or German street types or Deutschland or D-##### prefix.
	{
		country: "DE",
		test: (t, l) =>
			/ß/.test(t) ||
			/\b(stra(ß|ss)e|str|platz|weg|gasse|allee)\b/.test(l) ||
			/\bdeutschland\b/.test(l) ||
			/\bd-\d{5}\b/.test(l),
	},
	// Dutch: Dutch street types or Nederland or "#### XX" postcode shape.
	{
		country: "NL",
		test: (_t, l) =>
			/\b(straat|laan|plein|gracht|dijk|kade)\b/.test(l) || /\bnederland\b/.test(l) || /\b\d{4}\s?[a-z]{2}\b/i.test(l),
	},
]

function lexicalGuess(text: string, baseline: string): string {
	const lower = text.toLowerCase()

	for (const rule of LEXICAL) {
		if (rule.test(text, lower)) return rule.country
	}

	return baseline // fall back to the postcode-shape baseline
}

function main(): void {
	const samples = load()
	const base = new Map<string, { total: number; correct: number }>()
	const lex = new Map<string, { total: number; correct: number }>()
	let baseOk = 0
	let lexOk = 0

	for (const s of samples) {
		const shape = computeQueryShape(s.input)
		const baseline = regionOf(detectLocaleSync({ raw: s.input, normalized: s.input }, shape).locale)
		const enhanced = lexicalGuess(s.input, baseline)

		const b = base.get(s.country) ?? { total: 0, correct: 0 }
		b.total++

		if (baseline === s.country) {
			b.correct++
			baseOk++
		}
		base.set(s.country, b)

		const e = lex.get(s.country) ?? { total: 0, correct: 0 }
		e.total++

		if (enhanced === s.country) {
			e.correct++
			lexOk++
		}
		lex.set(s.country, e)
	}

	const n = samples.length
	console.log(`# Locale: postcode-shape baseline vs +lexical (#33) — ${n} samples\n`)
	console.log(
		`**Overall:** baseline ${((100 * baseOk) / n).toFixed(1)}% → +lexical ${((100 * lexOk) / n).toFixed(1)}%\n`
	)
	console.log("| Country | Total | Baseline | +Lexical |")
	console.log("|---------|------:|---------:|---------:|")

	for (const [c, b] of [...base.entries()].sort((x, y) => y[1].total - x[1].total)) {
		const e = lex.get(c)!
		console.log(
			`| ${c} | ${b.total} | ${((100 * b.correct) / b.total).toFixed(0)}% | ${((100 * e.correct) / e.total).toFixed(0)}% |`
		)
	}
}

main()
