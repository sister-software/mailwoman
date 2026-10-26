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
 *   `--dataset <dataset manifest .json>` scores a frozen, versioned sample (`heldout/dataset/freeze.run.ts`) in
 *   place of drawing one from `--manifest`; the rows file's sha256 is checked against the manifest. Every
 *   outcome carries the row's `group`, which `release/evaluate.ts` resamples by.
 *
 *   The optional provenance file is `{ "rows": { "<rowID>": { "provenance": "verified_unseen" |
 *   "unseen_by_candidate" | "known_overlap", "evidence": "<where the history was recorded>" } } }`. A row it does
 *   not name is classed `unknown`.
 *
 *   `--spec` names the release specification (default: the current one) whose capability requirements select
 *   the capability-probe sources. Their rows are reported in a `<country>/capability` entry rather than in the
 *   country's address cell.
 *
 *   Each row is parsed by its country's shipped locale package (`HELDOUT_INFERENCE_RULE`), so every arm's cache
 *   must hold every package the rows need. The report records the rule and the country-to-package map.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"

import { readHeldoutDatasetRows } from "#tools/eval-harness/heldout/dataset/manifest"
import {
	assertPairedArms,
	type CountryScore,
	HELDOUT_CAPABILITY_CELL,
	HELDOUT_INFERENCE_RULE,
	type HeldoutArmResult,
	readHeldoutLocalePackages,
	type ProvenanceHistory,
	type ProvenanceRecord,
	sampleHeldoutRows,
	scoreHeldoutWeights,
} from "#tools/eval-harness/heldout/per/country"
import { CURRENT_RELEASE_SPEC } from "#tools/eval-harness/release/current-spec"
import {
	capabilityProbeSources,
	HELDOUT_PROVENANCE_CLASSES,
	readReleaseSpec,
} from "#tools/eval-harness/release/requirements"

const { values } = parseArguments({
	options: {
		manifest: {
			type: "string",
			description: "The corpus MANIFEST.json whose test files hold the rows",
		},
		dataset: {
			type: "string",
			description: "A frozen held-out dataset manifest (heldout/dataset/freeze.run.ts), in place of --manifest",
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
		"skip-file": {
			type: "string",
			description:
				"Manifest file paths to leave out of the sample, comma-separated, exactly as the manifest lists them. " +
				"The report records each one, so a sample drawn without a file says so.",
		},
		spec: {
			type: "string",
			default: CURRENT_RELEASE_SPEC,
			description:
				"The release specification whose capability requirements name the probe sources kept out of the address cells",
		},
	},
})

if (!(values.manifest || values.dataset) || !values.baseline || !values.candidates || !values.out) {
	throw new Error("--manifest or --dataset, --baseline, --candidates and --out are required")
}

if (values.manifest && values.dataset) throw new Error("--manifest and --dataset name two row sets; pass one")

let history: ProvenanceHistory | undefined

if (values.provenance) {
	const file = await readLocalJSONFile<{
		rows?: Record<string, ProvenanceRecord>
	}>(values.provenance)

	if (!file.rows) throw new Error(`${values.provenance} holds no rows object`)

	for (const [rowID, record] of Object.entries(file.rows)) {
		if (
			!(HELDOUT_PROVENANCE_CLASSES as readonly string[]).includes(record.provenance) ||
			(record.provenance as string) === "unknown"
		) {
			throw new Error(`${values.provenance} row ${rowID} has provenance ${String(record.provenance)}`)
		}

		if (typeof record.evidence !== "string" || !record.evidence) {
			throw new Error(`${values.provenance} row ${rowID} records no evidence`)
		}
	}

	history = new Map(Object.entries(file.rows))
}

const { rows, counts, dataset } = values.dataset
	? await readHeldoutDatasetRows(values.dataset).then((frozen) => ({
			rows: frozen.rows,
			counts: frozen.manifest.cells,
			dataset: {
				path: values.dataset!,
				datasetID: frozen.manifest.datasetID,
				version: frozen.manifest.version,
			},
		}))
	: {
			...(await sampleHeldoutRows(
				values.manifest!,
				Number(values["per-country"]),
				values["path-root"],
				null,
				{},
				null,
				values["skip-file"] ? values["skip-file"].split(",").map((path) => path.trim()) : []
			)),
			dataset: null,
		}

console.error(`${rows.length} held-out rows from ${values.dataset ?? values.manifest}`)

const arms = [values.baseline, ...values.candidates.split(",").map((s) => s.trim())]
const scored: HeldoutArmResult[] = []
const packages = await readHeldoutLocalePackages()
const capabilitySources = capabilityProbeSources(await readReleaseSpec(values.spec))

for (const arm of arms) {
	console.error(`scoring ${arm}`)

	scored.push(await scoreHeldoutWeights(rows, arm, history, { packages, capabilitySources }))
}

assertPairedArms(scored)

const rate = (n: number, d: number) => (d ? n / d : null)

const withRates = (s: CountryScore) => ({
	...s,
	exactParseRate: rate(s.rowsExactParse, s.rows),
	spanRate: rate(s.spansRecovered, s.spans),
})

const armScores = (key: string) =>
	arms.map((arm, i) => {
		const score = scored[i]!.cells.get(key)

		return { arm, ...(score ? withRates(score) : { rows: 0 }) }
	})

// A sampled cell's `sampled` counts every row drawn into it.
// Its arm scores leave out the capability-probe rows, which take their own `<country>/capability` entry.
const capabilityCountries = [
	...new Set(
		[...scored[0]!.cells.keys()]
			.filter((key) => key.endsWith(`/${HELDOUT_CAPABILITY_CELL}`))
			.map((key) => key.split("/")[0]!)
	),
].toSorted()

const report = [
	...counts.map((cell) => ({ ...cell, arms: armScores(`${cell.country}/${cell.kind}`) })),
	...capabilityCountries.map((country) => ({
		country,
		kind: HELDOUT_CAPABILITY_CELL,
		available: null,
		sampled: scored[0]!.cells.get(`${country}/${HELDOUT_CAPABILITY_CELL}`)!.rows,
		arms: armScores(`${country}/${HELDOUT_CAPABILITY_CELL}`),
	})),
]

await writeLocalJSONFile(
	{
		manifest: values.manifest ?? null,
		dataset,
		provenance: values.provenance ?? null,
		capabilitySources: { spec: values.spec, sources: [...capabilitySources].toSorted() },
		inference: { rule: HELDOUT_INFERENCE_RULE, packages: Object.fromEntries(packages) },
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
