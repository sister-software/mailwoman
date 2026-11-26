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
 *   `--dataset <manifest .json>,<manifest .json>` scores frozen, versioned samples
 *   (`heldout/dataset/freeze.run.ts`) in place of drawing one from `--manifest`,
 *   all the collections of one evaluation role together.
 *   Each rows file's sha256 is checked against its manifest, two collections that share
 *   a row identity are refused, and the report's `dataset` lists every collection.
 *
 *   Every outcome includes the row's `group` and its expected tags.
 *   `release/evaluate.ts` uses that group for resampling.
 *
 *   An optional provenance file is `{ "rows": { "<rowID>": { "provenance": "verified_unseen" |
 *   "unseen_by_candidate" | "known_overlap", "evidence": "<where the history was recorded>" } } }`. `--provenance`
 *   takes one per collection, comma-separated, and refuses two that class one row differently.
 *   A row none of them names is classed `unknown`.
 *
 *   An arm is a weights cache root, optionally with resolver pins after a `#`
 *   (`heldout/per/arm.ts`): `<root>#countyDesignatorFallback=on`.
 *   Arms that share a root share one parse.
 *
 *   `--geocode` also geocodes, with every distinct arm, the rows the specification's
 *   `geocode` requirements select (`heldout/per/geocode.ts`), and records each
 *   row's geocode outcome beside its parse outcome.
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
import { stringifyJSON } from "@mailwoman/core/values/json"
import { isPresent } from "@mailwoman/core/values/objects"

import { mergeHeldoutCollections, readHeldoutDatasetRows } from "#tools/eval-harness/heldout/dataset/manifest"
import { heldoutArmDecoderSettings, parseHeldoutArm, splitHeldoutArms } from "#tools/eval-harness/heldout/per/arm"
import { HeldoutCase, rowsInCase } from "#tools/eval-harness/heldout/per/case"
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
	sampleHeldoutRows,
	scoreHeldoutArm,
} from "#tools/eval-harness/heldout/per/country"
import { geocodeRequirementSelects as selectsForGeocode } from "#tools/eval-harness/heldout/per/geocode/outcome"
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
import { readProvenanceHistory } from "#tools/eval-harness/heldout/per/provenance-history"
import { CURRENT_RELEASE_SPEC } from "#tools/eval-harness/release/current-spec"
import { capabilityProbeSources, readReleaseSpec } from "#tools/eval-harness/release/requirements"

const { values } = parseArguments({
	options: {
		manifest: {
			type: "string",
			description: "The corpus MANIFEST.json whose test files hold the rows",
		},
		dataset: {
			type: "string",
			description:
				"Frozen held-out dataset manifests (heldout/dataset/freeze.run.ts), comma-separated, in place of --manifest",
		},
		geocode: {
			type: "boolean",
			default: false,
			description: "Also geocode the rows the specification's geocode requirements select, with every arm",
		},
		case: {
			type: "string",
			default: HeldoutCase.AsWritten,
			description:
				"The register rows are scored in: as-written, or lower (each row's text lowercased; a row whose length " +
				"changes is left out and counted)",
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
			description: "Recorded exclusion histories keyed by row identity, comma-separated",
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
		"geocode-workers": {
			type: "string",
			description: "Geocode worker threads under --geocode, each with its own geocode sessions (default: the pool's)",
		},
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

/**
 * A comma-separated option as its trimmed, non-empty entries.
 */
function splitList(value: string): string[] {
	return value
		.split(",")
		.map((entry) => entry.trim())
		.filter(isPresent)
}

/**
 * Reads and verifies each collection, then joins them (`mergeHeldoutCollections`).
 */
async function readCollections(paths: readonly string[]) {
	const collections = []

	for (const path of paths) {
		collections.push({ path, ...(await readHeldoutDatasetRows(path)) })
	}

	return mergeHeldoutCollections(collections)
}

/**
 * Prints each arm's geocode-outcome rate per country over the geocoded rows.
 */
function printGeocodeRates(arms: readonly string[], outcomes: readonly (readonly HeldoutRowOutcome[])[]): void {
	console.log("\n# geocode outcome on geocoded rows")
	console.log(["country", "rows", ...arms.map((_, i) => (i ? `cand${i} %` : "baseline %"))].join("\t"))

	const countries = [...new Set(outcomes[0]!.filter((o) => o.geocode).map((o) => o.country))].toSorted()

	for (const country of countries) {
		const rates = outcomes.map((arm) => {
			const rows = arm.filter((o) => o.country === country && o.geocode)

			return { rows: rows.length, exact: rows.filter((o) => o.geocode!.exact).length }
		})

		console.log([country, rates[0]!.rows, ...rates.map((r) => ((100 * r.exact) / r.rows).toFixed(2))].join("\t"))
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

	const provenancePaths = values.provenance ? splitList(values.provenance) : []

	if (provenancePaths.length) {
		history = await readProvenanceHistory(provenancePaths)
	}

	const register = values.case as HeldoutCase

	if (!Object.values(HeldoutCase).includes(register)) {
		throw new Error(`--case must be one of ${Object.values(HeldoutCase).join(", ")}, got ${values.case}`)
	}

	const read = values.dataset
		? await readCollections(splitList(values.dataset))
		: {
				...(await sampleHeldoutRows(
					values.manifest!,
					Number(values["per-country"]),
					values["path-root"],
					null,
					{},
					[],
					values["skip-file"] ? values["skip-file"].split(",").map((path) => path.trim()) : []
				)),
				dataset: null,
			}

	const { counts, dataset } = read
	const { rows, leftOut } = rowsInCase(read.rows, register)

	console.error(`${rows.length} held-out rows from ${values.dataset ?? values.manifest}`)

	if (register !== HeldoutCase.AsWritten) {
		console.error(
			`scored in the ${register} register; ${leftOut} rows left out because the case change moved their length`
		)
	}

	const arms = [values.baseline, ...splitHeldoutArms(values.candidates)]
	const parsedArms = arms.map(parseHeldoutArm)
	const scored: HeldoutArmResult[] = []
	const packages = await readHeldoutLocalePackages()
	const spec = await readReleaseSpec(values.spec)
	const capabilitySources = capabilityProbeSources(spec)

	const parseSources: HeldoutParseSource[] = []
	// Arms that share a weights cache root and decoder pins parse identically,
	// because their other pins act only in the resolver.
	const parsesByRoot = new Map<string, Awaited<ReturnType<typeof parseHeldoutRows>>>()

	for (const [index, arm] of parsedArms.entries()) {
		console.error(`scoring arm ${index + 1} of ${arms.length}: ${arm.label}`)

		const decoderSettings = heldoutArmDecoderSettings(arm)
		const parseKey = `${arm.cacheRoot}\n${stringifyJSON(decoderSettings)}`
		let parsed = parsesByRoot.get(parseKey)

		if (!parsed) {
			parsed = await parseHeldoutRows(rows, arm.cacheRoot, {
				packages,
				workers: Number(values.workers),
				threads: Number(values.threads),
				localeHint: values["no-hint"] ? "none" : "row-country",
				decoderSettings,
				...(values["no-parse-cache"] ? { cacheDirectory: null } : {}),
			})

			parsesByRoot.set(parseKey, parsed)
		}

		const { parses, source } = parsed

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

	const geocodeRequirements = spec.requirements.filter((req) => req.kind === "geocode")
	let geocode: { rule: string; requirements: string[]; rows: number; seconds: Record<string, number> } | null = null

	if (values.geocode) {
		if (!geocodeRequirements.length) throw new Error(`${values.spec} declares no geocode requirement to geocode for`)

		const { geocodeHeldoutRows, HELDOUT_GEOCODE_RULE } = await import("#tools/eval-harness/heldout/per/geocode")

		const selected = rows.filter((row) =>
			geocodeRequirements.some((req) => selectsForGeocode(req, row, capabilitySources))
		)

		const outcomesByLabel = new Map<string, Awaited<ReturnType<typeof geocodeHeldoutRows>>>()
		const seconds: Record<string, number> = {}

		for (const arm of parsedArms) {
			if (outcomesByLabel.has(arm.label)) continue

			console.error(`geocoding ${selected.length} rows with ${arm.label}`)

			const started = Date.now()

			outcomesByLabel.set(
				arm.label,
				await geocodeHeldoutRows(selected, arm, {
					...(values["geocode-workers"] ? { workers: Number(values["geocode-workers"]) } : {}),
					onRow: (done, total) => {
						if (done % 500 === 0 || done === total) {
							console.error(`  ${done} of ${total}`)
						}
					},
				})
			)

			seconds[arm.label] = Math.round((Date.now() - started) / 1000)
		}

		for (const [i, arm] of parsedArms.entries()) {
			const outcomes = outcomesByLabel.get(arm.label)!

			for (const outcome of scored[i]!.rows) {
				const graded = outcomes.get(outcome.rowID)

				if (graded) {
					outcome.geocode = graded
				}
			}
		}

		geocode = {
			rule: HELDOUT_GEOCODE_RULE,
			requirements: geocodeRequirements.map((req) => req.id),
			rows: selected.length,
			seconds,
		}
	}

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
			case: { register, leftOut },
			provenance: provenancePaths.length ? provenancePaths : null,
			geocode,
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

	if (geocode) {
		printGeocodeRates(
			arms,
			scored.map((arm) => arm.rows)
		)
	}
}
