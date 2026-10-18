/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Scores a baseline and one or more candidates on the same held-out rows and writes the per-country table.
 *
 *   Usage:
 *   node packages/mailwoman/tools/eval-harness/heldout/per-country.run.ts \
 *     --manifest <corpus MANIFEST.json> --baseline <weights cache> --candidates <cache>,<cache> --out <report .json>
 */

import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"

import { type CountryScore, sampleHeldoutRows, scoreHeldoutByCountry } from "#tools/eval-harness/heldout/per-country"

const { values } = parseArguments({
	options: {
		manifest: { type: "string", description: "The corpus MANIFEST.json whose test files hold the rows" },
		"per-country": { type: "string", default: "200", description: "Rows sampled per country" },
		"path-root": { type: "string", default: "/mnt/mw", description: "Local directory for the manifest's /data prefix" },
		baseline: { type: "string", description: "The shipped model's package-shaped weights cache" },
		candidates: { type: "string", description: "Candidate weights caches, comma-separated" },
		out: { type: "string", description: "Where to write the per-country report" },
	},
})

if (!values.manifest || !values.baseline || !values.candidates || !values.out) {
	throw new Error("--manifest, --baseline, --candidates and --out are required")
}

const rows = await sampleHeldoutRows(values.manifest, Number(values["per-country"]), values["path-root"])

console.error(`${rows.length} held-out rows from ${values.manifest}`)

const arms = [values.baseline, ...values.candidates.split(",").map((s) => s.trim())]
const scored: Array<Map<string, CountryScore>> = []

for (const arm of arms) {
	console.error(`scoring ${arm}`)

	scored.push(await scoreHeldoutByCountry(rows, arm))
}

const spanRate = (s: CountryScore | undefined) => (s && s.spans ? s.spansRecovered / s.spans : 0)
const countries = [...scored[0]!.keys()].toSorted()

const report = countries.map((country) => ({
	country,
	rows: scored[0]!.get(country)!.rows,
	arms: arms.map((arm, i) => ({ arm, ...scored[i]!.get(country)!, spanRate: spanRate(scored[i]!.get(country)) })),
}))

await writeLocalJSONFile({ manifest: values.manifest, rows: rows.length, arms, countries: report }, values.out)

console.log(["country", "rows", "baseline", ...arms.slice(1).map((_, i) => `cand${i + 1} Δ`)].join("\t"))

for (const entry of report) {
	const base = entry.arms[0]!.spanRate
	const deltas = entry.arms.slice(1).map((a) => ((a.spanRate - base) * 100).toFixed(1))

	console.log([entry.country, entry.rows, (base * 100).toFixed(1), ...deltas].join("\t"))
}
