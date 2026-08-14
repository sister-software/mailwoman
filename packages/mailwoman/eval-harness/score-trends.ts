/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Per-tag score trends from the eval ledger — the version × tag matrix behind
 *   `docs/records/evals/score-trends.md`, which `docs/records/evals/index.mdx` links as the answer to
 *   the scorecards' standing "see the latest". Reads `evals/scores-by-version.json` in every shape the
 *   ledger has carried across eras and emits one table per locale.
 *
 *   Lives beside `ledger-append` because it is that command's second half: a row appended to the
 *   ledger is not visible in the docs until this regenerates the page.
 *
 *   The number formatting reproduces Python's `%g` and round-half-to-even to the digit, inherited from
 *   the retired Python generator that wrote the committed page's earlier columns. Rounding "correctly"
 *   instead would rewrite cells whose underlying score never changed, so every regen would land as
 *   diff noise across a table spanning every release.
 */

import { readFileSync, writeFileSync } from "node:fs"

import { parseJSONStrict } from "@mailwoman/core/objects"
import { pyRound, repoRootPath } from "@mailwoman/core/utils"

/**
 * Tags in report order. Anything the ledger carries that is absent here still appears, sorted, after the listed ones —
 * a new tag shows up on its own rather than waiting for this list to grow.
 */
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

/**
 * Locales with a trend table, in report order. Also the discriminator for the v4.4.0-era ledger shape, which put the
 * locale dict straight at the top of `metrics`.
 */
const LOCALES = ["us", "fr", "de"]

/**
 * `%g`'s default precision: 6 significant digits.
 */
const G_PRECISION = 6

/**
 * `%g`'s lower crossover exponent. C switches to scientific notation below 1e-4 and at or above `10 ** G_PRECISION`;
 * both bounds come from the format, not from anything about eval scores.
 */
const G_MIN_FIXED_EXPONENT = -4

/**
 * Python/C `%g` formatting at the default precision.
 */
function pyG(v: number): string {
	if (!Number.isFinite(v)) return Number.isNaN(v) ? "nan" : v > 0 ? "inf" : "-inf"

	if (v === 0) return Object.is(v, -0) ? "-0" : "0"

	const sign = v < 0 ? "-" : ""
	const a = Math.abs(v)
	const e = a.toExponential(G_PRECISION - 1)
	const exp = Number.parseInt(/e([+-]\d+)/.exec(e)![1]!, 10)
	let out: string

	if (exp < G_MIN_FIXED_EXPONENT || exp >= G_PRECISION) {
		let mant = e.split("e")[0]!

		if (mant.includes(".")) {
			mant = mant.replace(/0+$/, "").replace(/\.$/, "")
		}

		const expSign = exp < 0 ? "-" : "+"
		const expAbs = Math.abs(exp).toString().padStart(2, "0")

		out = `${mant}e${expSign}${expAbs}`
	} else {
		let f = a.toFixed(Math.max(0, G_PRECISION - 1 - exp))

		if (f.includes(".")) {
			f = f.replace(/0+$/, "").replace(/\.$/, "")
		}

		out = f
	}

	return sign + out
}

type LocaleScores = Record<string, Record<string, number>>

/**
 * One ledger run → `{locale: {tag: score}}` on the percent scale, across every era the ledger has carried: a
 * `per_component*` container, a bare locale dict (the v4.4.0 era), or the pre-locale flat `tag → {f1}` map on the 0–1
 * scale.
 */
function normalize(run: Record<string, unknown>): LocaleScores {
	const metrics = (run.metrics as Record<string, unknown>) || {}
	let container: Record<string, unknown> | null = null

	for (const key of Object.keys(metrics)) {
		if (key.startsWith("per_component")) {
			container = metrics[key] as Record<string, unknown>

			break
		}
	}

	if (container === null && LOCALES.some((locale) => locale in metrics)) {
		container = metrics
	}

	if (container === null) return {}

	const out: LocaleScores = {}

	if (LOCALES.some((locale) => locale in container!)) {
		for (const [locale, tags] of Object.entries(container)) {
			if (typeof tags !== "object" || tags === null || Array.isArray(tags)) continue

			const inner: Record<string, number> = {}

			for (const [tag, value] of Object.entries(tags as Record<string, unknown>)) {
				if (typeof value === "number") {
					inner[tag] = value
				}
			}

			out[locale] = inner
		}

		return out
	}

	// Pre-locale era: flat tag → {f1: 0-1 fraction}; report as US, the only graded locale then.
	const inner: Record<string, number> = {}

	for (const [tag, value] of Object.entries(container)) {
		if (typeof value === "object" && value !== null && !Array.isArray(value)) {
			const f1 = (value as Record<string, unknown>).f1

			inner[tag] = pyRound(Number(typeof f1 === "number" ? f1 : 0) * 100, 1)
		}
	}

	out.us = inner

	return out
}

export interface ScoreTrendsOptions {
	/**
	 * The eval ledger. Default `evals/scores-by-version.json`.
	 */
	ledger?: string
	/**
	 * Destination markdown. Default `docs/records/evals/score-trends.md`.
	 */
	out?: string
}

export interface ScoreTrendsResult {
	outPath: string
	/**
	 * Versions that reached the table — ledger rows carrying no recognizable per-tag metrics are skipped, so this sits
	 * below `runs` whenever the ledger holds a shape this cannot read.
	 */
	versions: number
	/**
	 * Ledger rows examined.
	 */
	runs: number
}

/**
 * Render the ledger to the trend page.
 */
export function buildScoreTrends(options: ScoreTrendsOptions = {}): ScoreTrendsResult {
	const ledgerPath = options.ledger ?? repoRootPath("evals", "scores-by-version.json")
	const outPath = options.out ?? repoRootPath("docs", "records", "evals", "score-trends.md")
	const ledger = parseJSONStrict<{ runs: Array<Record<string, unknown>> }>(readFileSync(ledgerPath, "utf8"))

	let rows: Array<[version: string, scores: LocaleScores]> = []
	const seenVersions = new Set<string>()

	for (const run of ledger.runs) {
		const version = "model_version" in run ? String(run.model_version) : "?"
		const scores = normalize(run)

		if (!Object.keys(scores).length) continue

		// One row per version: the LAST ledger entry for a version wins (re-measurements supersede).
		if (seenVersions.has(version)) {
			rows = rows.filter(([seen]) => seen !== version)
		}

		seenVersions.add(version)
		rows.push([version, scores])
	}

	const lines: string[] = [
		"# Per-tag score trends",
		"",
		"GENERATED from [`evals/scores-by-version.json`](https://github.com/sister-software/mailwoman/blob/main/evals/scores-by-version.json)",
		"by `mailwoman eval score-trends` — do not hand-edit; regenerate after each ledger row.",
		"",
		"Numbers are per-tag scores as recorded per release (eval sets, channels, and quantization",
		"evolve across eras — adjacent columns are comparable, distant ones directional; the dated",
		'ship-gate docs carry each column\'s exact conditions). "—" = not measured that release.',
		"",
	]

	for (const locale of LOCALES) {
		const ordered = TAG_ORDER.filter((tag) => rows.some(([, scores]) => tag in (scores[locale] || {})))

		const extra = [
			...new Set(
				rows.flatMap(([, scores]) => Object.keys(scores[locale] || {})).filter((tag) => !ordered.includes(tag))
			),
		].toSorted()

		const tags = [...ordered, ...extra]

		if (!tags.length) continue

		lines.push(`## ${locale.toUpperCase()}`, "")
		lines.push("| tag | " + rows.map(([version]) => version).join(" | ") + " |")
		lines.push("| --- |" + " --: |".repeat(rows.length))

		for (const tag of tags) {
			const cells = rows.map(([, scores]) => {
				const value = (scores[locale] || {})[tag]

				return value === undefined ? "—" : pyG(value)
			})

			lines.push(`| ${tag} | ` + cells.join(" | ") + " |")
		}

		lines.push("")
	}

	writeFileSync(outPath, lines.join("\n") + "\n")

	return { outPath, versions: rows.length, runs: ledger.runs.length }
}
