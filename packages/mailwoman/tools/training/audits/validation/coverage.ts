/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Counts the countries the validation and test splits hold, and each country's street-carrying rows.
 *
 *   `evaluate()` reports `val_loss`, `val_rows` and `macro_f1` over a whole split, so a country with no row in it
 *   changes none of them: a run cannot tell a locale it validates well from one it does not validate. A per-locale
 *   metric is read with its denominator beside it.
 *
 *   The scan reads every row of each split's parquet files through the manifest's row filters, rather than the
 *   sampler's draw, because the question is what the split contains. What a run draws from it is the epoch-mixture
 *   audit's question.
 */

import { countInto, mostCommon } from "@mailwoman/core/stats"
import type { TrainingConfig } from "@mailwoman/corpus/training/config/schema"
import type { MTFNode } from "@mailwoman/mtf/tools/sampler/native"

import { samplerConfigJSON } from "../../sampler.ts"
import { AuditFloorError } from "../receipt.ts"

/**
 * Tags whose presence makes a row street-level.
 * A row with neither measures only the admin hierarchy.
 */
export const STREET_TAGS: ReadonlySet<string> = new Set(["street", "house_number"])

/**
 * The columns the scan reads.
 */
const COLUMNS = ["country", "span_tags", "source"]

/**
 * The `country` of a coverage entry that applies to every country `country_weights` admits.
 */
export const EVERY_ADMITTED_COUNTRY = "*"

export interface SplitScan {
	files: number
	rows: number
	countries: number
	by_country: Record<string, { rows: number; street_rows: number }>
	by_country_source: Record<string, number>
}

/**
 * Counts rows, street rows and sources per country over one split.
 *
 * @throws When the split resolves no parquet file, a finding about the corpus
 * listing that a zero row count would hide.
 */
export function scanSplit(mtf: MTFNode, configJSON: string, split: string): SplitScan {
	const reader = new mtf.SplitColumns(configJSON, split, COLUMNS)
	const rows = new Map<string, number>()
	const streetRows = new Map<string, number>()
	const bySource = new Map<string, number>()

	for (let chunk = reader.nextChunk(); chunk; chunk = reader.nextChunk()) {
		const countries = chunk.strings.country ?? []
		const tags = chunk.lists.span_tags ?? []
		const sources = chunk.strings.source ?? []

		for (let i = 0; i < chunk.rows; i++) {
			const key = countries[i] || "(none)"

			countInto(rows, key)
			countInto(bySource, `${key}/${sources[i] ?? "None"}`)

			if ((tags[i] ?? []).some((tag) => STREET_TAGS.has(tag))) {
				countInto(streetRows, key)
			}
		}
	}

	const ranked = mostCommon(rows)

	return {
		files: reader.files,
		rows: ranked.reduce((sum, [, n]) => sum + n, 0),
		countries: rows.size,
		by_country: Object.fromEntries(
			ranked.map(([country, count]) => [country, { rows: count, street_rows: streetRows.get(country) ?? 0 }])
		),
		by_country_source: Object.fromEntries(mostCommon(bySource)),
	}
}

/**
 * For each wanted country, the split where it holds no row, or rows with no street.
 */
export function blindCountries(splits: Record<string, SplitScan>, wanted: readonly string[]) {
	const findings: Record<string, Record<string, string>> = {}

	for (const country of wanted) {
		const perSplit: Record<string, string> = {}

		for (const [split, measured] of Object.entries(splits)) {
			const entry = measured.by_country[country]

			if (!entry) {
				perSplit[split] = "no rows at all"
			} else if (entry.street_rows === 0) {
				perSplit[split] = `${entry.rows.toLocaleString("en-US")} rows, none carrying a street or house number`
			}
		}

		if (Object.keys(perSplit).length) {
			findings[country] = perSplit
		}
	}

	return findings
}

type CoverageEntry = TrainingConfig["data"]["required_validation_coverage"][number]

/**
 * Replaces each `country: "*"` entry with one per admitted country,
 * keeping a country's own entry for the split.
 *
 * A country at weight zero admits no row and receives no floor.
 */
export function expandRequirements(
	required: readonly CoverageEntry[],
	countryWeights: Record<string, number>
): CoverageEntry[] {
	const explicit = required.filter((entry) => entry.country !== EVERY_ADMITTED_COUNTRY)
	const named = new Set(explicit.map((entry) => `${entry.country}\u0000${entry.split}`))
	const expanded = [...explicit]

	for (const template of required) {
		if (template.country !== EVERY_ADMITTED_COUNTRY) continue

		for (const [country, weight] of Object.entries(countryWeights).toSorted(([a], [b]) =>
			a < b ? -1 : a > b ? 1 : 0
		)) {
			if (weight > 0 && !named.has(`${country}\u0000${template.split}`)) {
				expanded.push({ ...template, country })
			}
		}
	}

	return expanded
}

/**
 * Each declared floor the measured splits miss, with both numbers beside it.
 *
 * A country absent from a split counts as zero rows.
 * A split the report does not hold is its own finding.
 */
export function failingRequirements(splits: Record<string, SplitScan>, required: readonly CoverageEntry[]) {
	const failures: Array<Record<string, unknown>> = []
	const count = (n: number) => n.toLocaleString("en-US")

	for (const entry of required) {
		const measured = splits[entry.split]

		if (!measured) {
			failures.push({
				country: entry.country,
				split: entry.split,
				because: `the report carries no ${entry.split} split`,
			})

			continue
		}

		const observed = measured.by_country[entry.country] ?? { rows: 0, street_rows: 0 }
		const shortfalls: string[] = []

		if (observed.rows < entry.min_rows) {
			shortfalls.push(`${count(observed.rows)} rows against a floor of ${count(entry.min_rows)}`)
		}

		if (observed.street_rows < entry.min_street_rows) {
			shortfalls.push(`${count(observed.street_rows)} street rows against a floor of ${count(entry.min_street_rows)}`)
		}

		if (shortfalls.length) {
			failures.push({
				country: entry.country,
				split: entry.split,
				rows: observed.rows,
				street_rows: observed.street_rows,
				min_rows: entry.min_rows,
				min_street_rows: entry.min_street_rows,
				because: shortfalls.join("; "),
			})
		}
	}

	return failures
}

/**
 * Scans the held-out splits and judges the config's declared coverage floors.
 *
 * The report is complete before a refusal, so the caller writes it either way.
 */
export function validationCoverageReport(
	mtf: MTFNode,
	config: TrainingConfig,
	options: { countries: readonly string[]; corpusDir?: string; splits?: readonly string[] }
) {
	const corpusDir = options.corpusDir ?? config.data.corpus_dir
	const configJSON = samplerConfigJSON(config, { corpusDir })

	const splits = Object.fromEntries(
		(options.splits ?? ["val", "test"]).map((split) => [split, scanSplit(mtf, configJSON, split)])
	)

	const blind = blindCountries(splits, options.countries)
	const required = expandRequirements(config.data.required_validation_coverage, config.data.country_weights)
	const failures = required.length ? failingRequirements(splits, required) : []

	const report = {
		corpus_dir: corpusDir,
		splits,
		blind,
		required_validation_coverage: {
			declared: required.map((entry) => ({
				country: entry.country,
				split: entry.split,
				min_rows: entry.min_rows,
				min_street_rows: entry.min_street_rows,
			})),
			failures,
		},
	}

	const error = failures.length
		? new AuditFloorError(
				`${failures.length} of ${required.length} declared validation-coverage floors are not met:\n` +
					failures.map((f) => `  ${f.country} / ${f.split}: ${f.because}`).join("\n"),
				report
			)
		: null

	return { report, required, error }
}
