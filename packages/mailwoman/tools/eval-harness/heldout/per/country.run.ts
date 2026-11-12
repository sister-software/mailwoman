// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Scores a baseline and one or more candidates on the same held-out rows
 *   and writes the per-country table with every arm's per-row outcomes.
 *
 *   Usage:
 *   node packages/mailwoman/tools/eval-harness/heldout/per/country.run.ts \
 *     --manifest <corpus MANIFEST.json> --baseline <weights cache> --candidates <cache>,<cache> --out <report .json> \
 *     [--provenance <history .json>]
 *
 *   `--dataset <dataset manifest .json>` scores a frozen, versioned sample
 *   (`heldout/dataset/freeze.run.ts`) in place of drawing one from `--manifest`;
 *   the rows file's sha256 is checked against the manifest.
 *   Every outcome includes the row's `group`.
 *   `release/evaluate.ts` uses that group for resampling.
 *
 *   The optional provenance file is `{ "rows": { "<rowID>": { "provenance": "verified_unseen" |
 *   "unseen_by_candidate" | "known_overlap", "evidence": "<where the history was recorded>" } } }`. A row it doesn't
 *   name is classed `unknown`.
 *
 *   `--spec` names the release specification (default: the current one) whose
 *   capability requirements select the capability-probe sources.
 *   Their rows are reported in a `<country>/capability` entry rather than in the country's address cell.
 *
 *   Each row is parsed by its country's shipped locale package (`HELDOUT_INFERENCE_RULE`),
 *   so every arm's cache must hold every package the rows need.
 *   The report records the rule and the country-to-package map.
 *
 *   Rows are parsed on `--workers` worker threads (`heldout/per/parse-cache`).
 *   Parses are kept under `$MAILWOMAN_DATA_ROOT/models/arms/heldout-parses/`
 *   and read back when the rows, the weights files and the commit all match,
 *   so a rerun or an added arm parses only what's new.
 *
 *   The report's `parses` entry records, per arm, the cache file read or written,
 *   or why the cache was left unused.
 *   `--no-parse-cache` parses every arm again.
 *
 *   After the per-country table it prints the exact-parse difference split by row kind, by provenance, by both,
 *   and by source within the unseen address rows, with the equal-country rate on address rows. `--from-report
 *   <report .json>` prints those splits from a report this command wrote earlier, without parsing.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"

import { readHeldoutDatasetRows } from "#tools/eval-harness/heldout/dataset/manifest"
import {
	type HeldoutRowOutcome,
	assertPairedArms,
	type CountryScore,
	HELDOUT_CAPABILITY_CELL,
	HELDOUT_INFERENCE_RULE,
	type HeldoutArmResult,
	heldoutRowID,
	heldoutWeightsLocale,
	readHeldoutLocalePackages,
	type ProvenanceHistory,
	type ProvenanceRecord,
	sampleHeldoutRows,
	scoreHeldoutArm,
} from "#tools/eval-harness/heldout/per/country"
import {
	byKindAndProvenance,
	byProvenance,
	byRowKind,
	bySourceWithin,
	equalCountryExactRate,
	formatPairedSplits,
	splitPairedOutcomes,
} from "#tools/eval-harness/heldout/per/paired-splits"
import { type HeldoutParseSource, parseHeldoutRows } from "#tools/eval-harness/heldout/per/parse-cache"
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
		"from-report": {
			type: "string",
			description: "A report this command wrote; print its paired splits without parsing",
		},
		spec: {
			type: "string",
			default: CURRENT_RELEASE_SPEC,
			description:
				"The release specification whose capability requirements name the probe sources kept out of the address cells",
		},
		workers: { type: "string", default: "6", description: "Parse worker threads" },
		threads: { type: "string", default: "2", description: "ONNX threads per parse worker" },
		"no-parse-cache": {
			type: "boolean",
			description: "Parse every arm again rather than reading parses cached for the same rows, weights and commit",
		},
		"no-hint": {
			type: "boolean",
			default: false,
			description: "Parse without the row's country as the classifier's locale hint, as the runtime pipeline does",
		},
	},
})

/**
 * Prints the paired exact-parse splits by row kind and provenance,
 * then the equal-country rate on address rows.
 */
function printPairedSplits(arms: readonly string[], outcomes: readonly (readonly HeldoutRowOutcome[])[]): void {
	const candidates = arms.length - 1

	console.log(
		`\narms: baseline ${arms[0]}; ${arms
			.slice(1)
			.map((arm, i) => `cand${i + 1} ${arm}`)
			.join("; ")}`
	)

	for (const [title, key] of [
		["exact parse by row kind", byRowKind],
		["exact parse by provenance", byProvenance],
		["exact parse by row kind and provenance", byKindAndProvenance],
		["verified_unseen address rows by source", bySourceWithin("address", "verified_unseen")],
	] as const) {
		console.log(`\n${formatPairedSplits(title, splitPairedOutcomes(outcomes, key), candidates).join("\n")}`)
	}

	console.log("\n# equal-country exact parse on address rows")
	console.log(["selection", "rows", "countries", ...arms.map((_, i) => (i ? `cand${i} %` : "baseline %"))].join("\t"))

	const unseenAddress = (o: HeldoutRowOutcome) => o.kind === "address" && o.provenance === "verified_unseen"

	for (const [label, keep] of [
		["all address rows", (o: HeldoutRowOutcome) => o.kind === "address"],
		["verified_unseen address rows", unseenAddress],
	] as const) {
		const rate = equalCountryExactRate(outcomes, keep)

		console.log([label, rate.rows, rate.countries, ...rate.rates.map((r) => (r * 100).toFixed(2))].join("\t"))
	}
}

if (values["from-report"]) {
	const earlier = await readLocalJSONFile<{ outcomes?: { arm: string; rows: HeldoutRowOutcome[] }[] }>(
		values["from-report"]
	)

	if (!Array.isArray(earlier.outcomes) || earlier.outcomes.length < 2) {
		throw new Error(`${values["from-report"]} holds no paired outcomes for two or more arms`)
	}

	printPairedSplits(
		earlier.outcomes.map((arm) => arm.arm),
		earlier.outcomes.map((arm) => arm.rows)
	)
} else {
	await scoreAndReport()
}

async function scoreAndReport(): Promise<void> {
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

	const parseSources: HeldoutParseSource[] = []

	for (const [index, arm] of arms.entries()) {
		console.error(`scoring arm ${index + 1} of ${arms.length}: ${arm}`)

		const { parses, source } = await parseHeldoutRows(rows, arm, {
			packages,
			workers: Number(values.workers),
			threads: Number(values.threads),
			localeHint: values["no-hint"] ? "none" : "row-country",
			...(values["no-parse-cache"] ? { cacheDirectory: null } : {}),
		})

		parseSources.push(source)

		scored.push(
			await scoreHeldoutArm(
				rows,
				async (row) => parses.get(heldoutRowID(row))!,
				history,
				(row) => heldoutWeightsLocale(row.country, packages),
				capabilitySources
			)
		)
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
	// Its arm scores leave out capability-probe rows.
	// Those rows use their own `<country>/capability` entry.
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
			inference: {
				rule: HELDOUT_INFERENCE_RULE,
				packages: Object.fromEntries(packages),
				localeHint: values["no-hint"] ? "none" : "row-country",
			},
			parses: arms.map((arm, i) => ({ arm, ...parseSources[i]! })),
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

	printPairedSplits(
		arms,
		scored.map((arm) => arm.rows)
	)
}
