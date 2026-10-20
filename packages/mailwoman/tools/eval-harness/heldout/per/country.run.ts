/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Scores a baseline and one or more candidates on the same held-out rows and writes the per-country table
 *   with every arm's per-row outcomes.
 *
 *   Usage:
 *   node packages/mailwoman/tools/eval-harness/heldout/per/country.run.ts \
 *     --manifest <corpus MANIFEST.json> --baseline <weights cache> --candidates <cache>,<cache> --out <report .json> \
 *     [--provenance <history .json>]
 *
 *   The optional provenance file is `{ "rows": { "<rowID>": { "provenance": "verified_unseen" | "known_overlap",
 *   "evidence": "<where the history was recorded>" } } }`. A row it does not name is classed `unknown`.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"

import {
	assertPairedArms,
	type CountryScore,
	type HeldoutArmResult,
	type ProvenanceHistory,
	type ProvenanceRecord,
	sampleHeldoutRows,
	scoreHeldoutWeights,
} from "#tools/eval-harness/heldout/per/country"

const { values } = parseArguments({
	options: {
		manifest: {
			type: "string",
			description: "The corpus MANIFEST.json whose test files hold the rows",
		},
		"per-country": {
			type: "string",
			default: "200",
			description: "Rows sampled per country",
		},
		"path-root": {
			type: "string",
			default: "/mnt/mw",
			description: "Local directory for the manifest's /data prefix",
		},
		baseline: {
			type: "string",
			description: "The shipped model's package-shaped weights cache",
		},
		candidates: {
			type: "string",
			description: "Candidate weights caches, comma-separated",
		},
		provenance: {
			type: "string",
			description: "Recorded exclusion history keyed by row identity",
		},
		out: {
			type: "string",
			description: "Where to write the per-country report",
		},
	},
})

if (!values.manifest || !values.baseline || !values.candidates || !values.out) {
	throw new Error("--manifest, --baseline, --candidates and --out are required")
}

let history: ProvenanceHistory | undefined

if (values.provenance) {
	const file = await readLocalJSONFile<{
		rows?: Record<string, ProvenanceRecord>
	}>(values.provenance)

	if (!file.rows) throw new Error(`${values.provenance} holds no rows object`)

	for (const [rowID, record] of Object.entries(file.rows)) {
		if (record.provenance !== "verified_unseen" && record.provenance !== "known_overlap") {
			throw new Error(`${values.provenance} row ${rowID} has provenance ${String(record.provenance)}`)
		}

		if (typeof record.evidence !== "string" || !record.evidence) {
			throw new Error(`${values.provenance} row ${rowID} records no evidence`)
		}
	}

	history = new Map(Object.entries(file.rows))
}

const { rows, counts } = await sampleHeldoutRows(values.manifest, Number(values["per-country"]), values["path-root"])

console.error(`${rows.length} held-out rows from ${values.manifest}`)

const arms = [values.baseline, ...values.candidates.split(",").map((s) => s.trim())]
const scored: HeldoutArmResult[] = []

for (const arm of arms) {
	console.error(`scoring ${arm}`)

	scored.push(await scoreHeldoutWeights(rows, arm, history))
}

assertPairedArms(scored)

const rate = (n: number, d: number) => (d ? n / d : null)

const withRates = (s: CountryScore) => ({
	...s,
	exactParseRate: rate(s.rowsExactParse, s.rows),
	spanRate: rate(s.spansRecovered, s.spans),
})

const report = counts.map((cell) => ({
	...cell,
	arms: arms.map((arm, i) => {
		const score = scored[i]!.cells.get(`${cell.country}/${cell.kind}`)

		return { arm, ...(score ? withRates(score) : { rows: 0 }) }
	}),
}))

await writeLocalJSONFile(
	{
		manifest: values.manifest,
		provenance: values.provenance ?? null,
		rows: rows.length,
		arms,
		countries: report,
		outcomes: arms.map((arm, i) => ({ arm, rows: scored[i]!.rows })),
	},
	values.out
)

console.log(
	["cell", "available", "sampled", "baseline exact", ...arms.slice(1).map((_, i) => `cand${i + 1} Δ`)].join("\t")
)

for (const entry of report) {
	const exactRate = (i: number) => {
		const arm = entry.arms[i]!

		return "exactParseRate" in arm ? arm.exactParseRate : null
	}

	const base = exactRate(0)

	const deltas = entry.arms.slice(1).map((_, i) => {
		const cand = exactRate(i + 1)

		return base == null || cand == null ? "n/a" : ((cand - base) * 100).toFixed(1)
	})

	console.log(
		[
			`${entry.country}/${entry.kind}`,
			entry.available,
			entry.sampled,
			base == null ? "n/a" : (base * 100).toFixed(1),
			...deltas,
		].join("\t")
	)
}
