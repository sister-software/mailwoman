/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Per-tag score trends from the eval ledger (stretch S5, night-11). The scorecards keep saying "see
 *   the latest"; this gives them a trend page to point at. Reads evals/scores-by-version.json
 *   (every shape the ledger has carried across eras), emits a version × tag matrix per locale.
 *
 *   Ported faithfully from scripts/eval/build-score-trends.py (pure JSON → markdown, no numpy).
 *
 *   Regenerate: node --experimental-strip-types scripts/eval/build-score-trends.ts Output:
 *   docs/articles/evals/score-trends.md (GENERATED — do not hand-edit)
 */

import { readFileSync, writeFileSync } from "node:fs"

import { repoRootPath } from "@mailwoman/core/utils"

const LEDGER = repoRootPath("evals", "scores-by-version.json")
const OUT = repoRootPath("docs", "articles", "evals", "score-trends.md")

const TAG_ORDER = [
	"micro",
	"street",
	"street_prefix",
	"street_suffix",
	"house_number",
	"locality",
	"region",
	"postcode",
	"country_homograph",
	"unit",
	"po_box_real",
	"cedex_real",
	"intersection_real",
	"native_locality_anchor_on",
]

/** Python `format(x, ".{d}f")` — round-half-to-even on the exact decimal value of the double. */
function pyFixed(x: number, d: number): string {
	if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf"
	const neg = x < 0 || Object.is(x, -0)
	const [intPart, fracRaw = ""] = Math.abs(x).toFixed(20).split(".")
	const frac = fracRaw

	if (frac.length <= d) {
		const body = d > 0 ? `${intPart}.${frac.padEnd(d, "0")}` : intPart!

		return (neg ? "-" : "") + body
	}
	const keep = frac.slice(0, d)
	const rest = frac.slice(d)
	let roundUp: boolean

	if (rest[0]! > "5") {
		roundUp = true
	} else if (rest[0]! < "5") {
		roundUp = false
	} else if (rest.slice(1).replace(/0+$/, "").length > 0) {
		roundUp = true
	} else {
		const lastKept = d > 0 ? (keep[d - 1] ?? "0") : (intPart![intPart!.length - 1] ?? "0")
		roundUp = parseInt(lastKept, 10) % 2 === 1
	}
	let digits = intPart! + keep

	if (roundUp) {
		const arr = digits.split("")
		let i = arr.length - 1

		for (; i >= 0; i--) {
			if (arr[i] === "9") {
				arr[i] = "0"
			} else {
				arr[i] = String(parseInt(arr[i]!, 10) + 1)
				break
			}
		}

		if (i < 0) {
			arr.unshift("1")
		}
		digits = arr.join("")
	}
	const di = digits.length - d
	const body = d > 0 ? `${digits.slice(0, di) || "0"}.${digits.slice(di)}` : digits.slice(0, di) || "0"

	return (neg ? "-" : "") + body
}

/** Python `round(x, ndigits)` — the nearest double to the round-half-to-even decimal. */
function pyRound(x: number, ndigits: number): number {
	return Number(pyFixed(x, ndigits))
}

/** Python/C `%g` formatting with the default precision of 6 significant digits. */
function pyG(v: number): string {
	if (!Number.isFinite(v)) return Number.isNaN(v) ? "nan" : v > 0 ? "inf" : "-inf"

	if (v === 0) return Object.is(v, -0) ? "-0" : "0"
	const P = 6
	const sign = v < 0 ? "-" : ""
	const a = Math.abs(v)
	const e = a.toExponential(P - 1)
	const exp = parseInt(/e([+-]\d+)/.exec(e)![1]!, 10)
	let out: string

	if (exp < -4 || exp >= P) {
		let mant = e.split("e")[0]!

		if (mant.indexOf(".") >= 0) {
			mant = mant.replace(/0+$/, "").replace(/\.$/, "")
		}
		const expSign = exp < 0 ? "-" : "+"
		const expAbs = Math.abs(exp).toString().padStart(2, "0")
		out = `${mant}e${expSign}${expAbs}`
	} else {
		let f = a.toFixed(Math.max(0, P - 1 - exp))

		if (f.indexOf(".") >= 0) {
			f = f.replace(/0+$/, "").replace(/\.$/, "")
		}
		out = f
	}

	return sign + out
}

type LocaleScores = Record<string, Record<string, number>>

/** Whatever era the run is from → {locale: {tag: score}} (percent scale). */
function normalize(run: Record<string, unknown>): LocaleScores {
	const m = (run.metrics as Record<string, unknown>) || {}
	let container: Record<string, unknown> | null = null

	for (const k of Object.keys(m)) {
		if (k.startsWith("per_component")) {
			container = m[k] as Record<string, unknown>
			break
		}
	}

	if (container === null && ["us", "fr", "de"].some((k) => k in m)) {
		container = m // v4.4.0-era: locale dict at the top
	}

	if (container === null) return {}
	const out: LocaleScores = {}

	if (["us", "fr", "de"].some((k) => k in container!)) {
		for (const [locale, tags] of Object.entries(container)) {
			if (typeof tags !== "object" || tags === null || Array.isArray(tags)) continue
			const inner: Record<string, number> = {}

			for (const [t, v] of Object.entries(tags as Record<string, unknown>)) {
				if (typeof v === "number") {
					inner[t] = v
				}
			}
			out[locale] = inner
		}
	} else {
		// Pre-locale era: flat tag → {f1: 0-1 fraction}; report as US (the only graded locale then).
		const inner: Record<string, number> = {}

		for (const [t, v] of Object.entries(container)) {
			if (typeof v === "object" && v !== null && !Array.isArray(v)) {
				const f1 = (v as Record<string, unknown>).f1
				inner[t] = pyRound(Number(typeof f1 === "number" ? f1 : 0) * 100, 1)
			}
		}
		out.us = inner
	}

	return out
}

function main(): void {
	const ledger = JSON.parse(readFileSync(LEDGER, "utf-8")) as { runs: Array<Record<string, unknown>> }
	let rows: Array<[string, LocaleScores]> = [] // (version, locale_scores)
	const seenVersions = new Set<string>()

	for (const run of ledger.runs) {
		const version = "model_version" in run ? String(run.model_version) : "?"
		const scores = normalize(run)

		if (Object.keys(scores).length === 0) continue

		// One row per version: the LAST ledger entry for a version wins (re-measurements supersede).
		if (seenVersions.has(version)) {
			rows = rows.filter(([v]) => v !== version)
		}
		seenVersions.add(version)
		rows.push([version, scores])
	}

	const lines: string[] = [
		"# Per-tag score trends",
		"",
		"GENERATED from [`evals/scores-by-version.json`](https://github.com/sister-software/mailwoman/blob/main/evals/scores-by-version.json)",
		"by `scripts/eval/build-score-trends.ts` — do not hand-edit; regenerate after each ledger row.",
		"",
		"Numbers are per-tag scores as recorded per release (eval sets, channels, and quantization",
		"evolve across eras — adjacent columns are comparable, distant ones directional; the dated",
		'ship-gate docs carry each column\'s exact conditions). "—" = not measured that release.',
		"",
	]

	for (const locale of ["us", "fr", "de"]) {
		const tags = TAG_ORDER.filter((t) => rows.some(([, s]) => t in (s[locale] || {})))
		const extra = [
			...new Set(rows.flatMap(([, s]) => Object.keys(s[locale] || {})).filter((t) => !tags.includes(t))),
		].sort()
		tags.push(...extra)

		if (tags.length === 0) continue
		lines.push(`## ${locale.toUpperCase()}`)
		lines.push("")
		lines.push("| tag | " + rows.map(([v]) => v).join(" | ") + " |")
		lines.push("| --- |" + " --: |".repeat(rows.length))

		for (const t of tags) {
			const cells: string[] = []

			for (const [, s] of rows) {
				const v = (s[locale] || {})[t]
				cells.push(v !== undefined ? pyG(v) : "—")
			}
			lines.push(`| ${t} | ` + cells.join(" | ") + " |")
		}
		lines.push("")
	}
	writeFileSync(OUT, lines.join("\n") + "\n")
	console.log(`wrote ${OUT} (${rows.length} versions)`)
}

if (import.meta.main) {
	main()
}
