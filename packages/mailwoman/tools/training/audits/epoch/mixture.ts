// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The full-epoch audit of the source and country mixture: what the sampler draws,
 *   and what the trainer reads.
 *
 *   A prefix audit ends before any source exhausts, so it misses a mixture that drifts mid-epoch.
 *   This audit reads one row-limited epoch at two levels.
 *
 *   The draw level counts the mixture's own rows per fixed window of draws,
 *   the stationarity receipt: every window must hold every source at its requested share.
 *   The emitted level runs the same stream through the trainer's emit step
 *   and counts what fills the row budget, where augmented copies compete with originals
 *   and `distortion_vs_draw_share` measures each source's realized-weight distortion.
 *
 *   A config's `required_corpus_receipts` name row shapes its corpus must hold: a source,
 *   a country and a contiguous component sequence, each with a floor of draws per epoch.
 *   The audit refuses an epoch below a floor.
 *
 *   Each source-scoped receipt's expected draws come from the configured weights and the corpus:
 *   the source's requested share of the epoch times the fraction of its train rows the receipt matches.
 *   A floor may be stated as a fraction of that expectation (`min_fraction_of_expected`),
 *   so it moves with the weight, and an absolute `min_draws` above the expectation is refused (#2391).
 *
 *   A passing audit is bound to the config's and the manifest's bytes by {@linkcode corpusReceiptBinding}.
 */

import { pySum } from "@mailwoman/core/numeric"
import { countInto, mostCommon } from "@mailwoman/core/stats"
import type { TrainingConfig } from "@mailwoman/corpus/training/config/schema"
import type { MTFNode } from "@mailwoman/mtf/tools/sampler/native"

import { samplerConfigJSON } from "../../sampler.ts"
import { auditAugment, drawnRows, emittedRows } from "../census.ts"
import { AuditFloorError, sortedByKey } from "../receipt.ts"

type ReceiptConfig = TrainingConfig["data"]["required_corpus_receipts"][number]

/**
 * A source whose per-row exposure exceeds this multiple of the median is almost certainly a mistake.
 *
 * The #1677 case was 33 times the sources weighted six times higher,
 * A guard that checks only that case would be too tight.
 */
export const REPS_OUTLIER_MULTIPLE = 8

/**
 * A row's labels collapsed to its ordered component-span sequence.
 *
 * @throws For a malformed or orphan label, so a parse failure cannot read as a corpus shortfall.
 */
export function componentSequence(labels: readonly string[]): string[] {
	const sequence: string[] = []
	let active: string | null = null

	for (const label of labels) {
		if (label === "O") {
			active = null

			continue
		}

		const dash = label.indexOf("-")
		const prefix = dash === -1 ? "" : label.slice(0, dash)
		const component = dash === -1 ? "" : label.slice(dash + 1)

		if (dash === -1 || (prefix !== "B" && prefix !== "I") || !component) {
			throw new Error(`malformed BIO label '${label}': expected O, B-<component>, or I-<component>`)
		}

		if (prefix === "I" && active !== component) {
			throw new Error(`orphan BIO label '${label}': active component is ${active == null ? "None" : `'${active}'`}`)
		}

		if (prefix === "B") {
			sequence.push(component)
		}

		active = component
	}

	return sequence
}

/**
 * Whether `expected` appears as a contiguous run in `sequence`.
 * An empty `expected` matches.
 */
export function containsContiguous(sequence: readonly string[], expected: readonly string[]): boolean {
	if (!expected.length) return true

	for (let start = 0; start + expected.length <= sequence.length; start++) {
		if (expected.every((item, i) => sequence[start + i] === item)) return true
	}

	return false
}

/**
 * Whether a drawn row matches a receipt's source, country and component sequence.
 */
export function matchesReceipt(
	row: { source?: string | null; country?: string | null; labels?: readonly string[] },
	receipt: ReceiptConfig
): boolean {
	if (receipt.source != null && row.source !== receipt.source) return false

	if (receipt.country != null && row.country !== receipt.country) return false

	return containsContiguous(componentSequence(row.labels ?? []), receipt.component_sequence)
}

/**
 * The configured weights as the shares they ask for, sorted by source.
 * A weight at or below zero asks for none.
 */
export function requestedShares(weights: ReadonlyArray<[string, number]> | null): Map<string, number> {
	if (!weights) return new Map()

	// Summed in the listed order with Python's compensated `sum`, because a float sum depends on both.
	const total = pySum(weights.flatMap(([, w]) => (w > 0 ? [w] : [])))

	return new Map(sortedByKey(weights.filter(([, w]) => w > 0)).map(([source, w]) => [source, w / total]))
}

/**
 * The train mixture's weights with each `source_reps` target derived from the corpus,
 * in the merged order, and the launch-log lines that record each derivation.
 */
export function resolveSourceWeights(mtf: MTFNode, config: TrainingConfig, corpusDir: string) {
	const { data, train } = config
	const fixed = data.source_weights ? Object.entries(data.source_weights) : null
	const reps = Object.entries(data.source_reps ?? {})

	if (!reps.length) return { weights: fixed, derivation: "" }

	const rows = mtf.sourceRowCounts(samplerConfigJSON(config, { corpusDir }), "train")
	const samples = train.max_steps * train.batch_size * train.grad_accum_steps

	const { merged, derived } = mtf.deriveSourceWeights(
		fixed?.map(([source, weight]) => ({ source, weight })) ?? null,
		reps.map(([source, weight]) => ({ source, weight })),
		rows,
		samples
	)

	const lines = ["source_reps → source_weights (#1677):"]

	for (const d of derived) {
		lines.push(
			`  ${d.source.padEnd(32)} ${d.targetRepsPerRow.toFixed(3).padStart(9)} reps/row × ${d.rows.toLocaleString("en-US").padStart(9)} rows → weight ${d.weight.toFixed(4)}`
		)
	}

	return {
		weights: merged.map(({ source, weight }) => [source, weight] as [string, number]),
		derivation: lines.join("\n"),
	}
}

/**
 * A receipt's source rows as the sampler can draw them: each row counted at its country's
 * admission probability, `weight / max weight`, and the part of that mass the receipt matches.
 */
export interface ReceiptPopulation {
	rows: number
	matching: number
}

/**
 * Whether a receipt narrows its source, so its expectation needs the source's matching fraction.
 */
export function receiptNarrowsSource(receipt: ReceiptConfig): boolean {
	return receipt.country != null || receipt.component_sequence.length > 0
}

/**
 * Counts each source-scoped receipt's population over train rows, weighting a row
 * by the chance the sampler admits its country.
 *
 * A row the sampler never draws, with no country or a country weighted at zero, counts nowhere.
 * The coarse filter isn't applied, so a row it would drop still counts.
 *
 * Such a row holds no active component and matches no receipt, so the expectation reads slightly low.
 */
export function countReceiptPopulations(
	rows: Iterable<{ source: string | null; country: string | null; labels: readonly string[] | null }>,
	receipts: readonly ReceiptConfig[],
	countryWeights: Readonly<Record<string, number>>
): Map<string, ReceiptPopulation> {
	const scoped = receipts.filter((receipt) => receipt.source != null)
	const populations = new Map(scoped.map((receipt) => [receipt.name, { rows: 0, matching: 0 }]))
	const maxWeight = Math.max(0, ...Object.values(countryWeights))

	for (const row of rows) {
		const weight = row.country == null ? 0 : (countryWeights[row.country] ?? 0)

		if (!(weight > 0)) continue

		const admission = weight / maxWeight

		for (const receipt of scoped) {
			if (row.source !== receipt.source) continue

			const population = populations.get(receipt.name)!

			population.rows += admission

			if (matchesReceipt({ source: row.source, country: row.country, labels: row.labels ?? [] }, receipt)) {
				population.matching += admission
			}
		}
	}

	return populations
}

/**
 * The train rows of `sources`, over the columns a receipt reads.
 */
function* sourceRows(mtf: MTFNode, config: TrainingConfig, sources: ReadonlySet<string>) {
	// The addon compares the uppercased column with these values, and drops every other row before converting it.
	const reader = new mtf.SplitColumns(samplerConfigJSON(config), "train", ["source", "country", "labels"], {
		column: "source",
		values: [...sources].map((source) => source.toUpperCase()),
	})

	for (let chunk = reader.nextChunk(); chunk; chunk = reader.nextChunk()) {
		const source = chunk.strings["source"] ?? []
		const country = chunk.strings["country"] ?? []
		const labels = chunk.lists["labels"] ?? []

		for (let i = 0; i < chunk.rows; i++) {
			yield { source: source[i] ?? null, country: country[i] ?? null, labels: labels[i] ?? null }
		}
	}
}

/**
 * A receipt's expected draws over `draws`, and how it was derived.
 */
export interface ReceiptExpectation {
	expected_draws: number | null
	/**
	 * The share of the receipt's source rows it matches, or `null` when the
	 * receipt states no country or sequence.
	 */
	matching_fraction: number | null
	/**
	 * Why no expectation was derived, when none was.
	 */
	unexpected_reason: string | null
}

/**
 * Expected draws for a receipt: `draws × share(source) × matching fraction`.
 *
 * The source's share is what its weight requests.
 * Over seeds, each of a source's rows is equally likely to be drawn, so the receipt's
 * matching rows take their fraction of the source's draws in expectation.
 *
 * An epoch that reads part of a source takes the same fraction of each row group it visits,
 * in one shuffled sweep over all of the source's files, so each epoch also draws a
 * receipt near its expectation when its rows sit in a few row groups.
 * The fraction is raised until the largest group gives 256 rows.
 *
 * Where that floor binds, as for `usgov-nad`, an epoch visits about `expected draws / 256` random
 * row groups, and a receipt confined to a few groups still varies more than a Poisson count.
 *
 * A source the epoch reads in full is read file by file, each row once per pass.
 *
 * @throws When the receipt narrows its source and no population was counted for it,
 * so a missing count can't read as a zero expectation.
 */
export function expectReceiptDraws(
	receipt: ReceiptConfig,
	requested: ReadonlyMap<string, number>,
	draws: number,
	population: ReceiptPopulation | undefined
): ReceiptExpectation {
	if (receipt.source == null) {
		return { expected_draws: null, matching_fraction: null, unexpected_reason: "the receipt pools every source" }
	}

	const share = requested.get(receipt.source) ?? 0

	if (!receiptNarrowsSource(receipt)) {
		return { expected_draws: draws * share, matching_fraction: null, unexpected_reason: null }
	}

	if (!population) throw new Error(`receipt '${receipt.name}': its source population was not counted`)

	const fraction = population.rows > 0 ? population.matching / population.rows : 0

	return { expected_draws: draws * share * fraction, matching_fraction: fraction, unexpected_reason: null }
}

/**
 * The floor a receipt is held to: `min_draws`, raised to `min_fraction_of_expected`
 * of its expectation when the receipt states one, rounded down.
 */
export function receiptFloor(receipt: ReceiptConfig, expectedDraws: number | null): number {
	const fraction = receipt.min_fraction_of_expected

	if (fraction == null) return receipt.min_draws

	if (expectedDraws == null) {
		throw new Error(`receipt '${receipt.name}' states min_fraction_of_expected and has no expected draws`)
	}

	return Math.max(receipt.min_draws, Math.floor(fraction * expectedDraws))
}

/**
 * A country as a report key: Python writes a `None` key as `null`.
 */
function countryKey(country: string | null | undefined): string {
	return country ?? "null"
}

function dictOf(counter: Map<string, number>): Record<string, number> {
	return Object.fromEntries(counter)
}

/**
 * Options for {@linkcode auditEpochMixture}.
 */
export interface EpochMixtureOptions {
	seed: number
	draws: number
	window: number
	corpusDir: string
}

/**
 * Runs both passes over one epoch and returns the report, with the refusal when a receipt falls short.
 */
export function auditEpochMixture(mtf: MTFNode, config: TrainingConfig, options: EpochMixtureOptions) {
	const { draws, window } = options

	if (draws <= 0 || window <= 0) throw new Error(`draws (${draws}) and window (${window}) must be positive`)

	const augment = auditAugment(config.data)
	const { weights, derivation } = resolveSourceWeights(mtf, config, options.corpusDir)
	const requested = requestedShares(weights)
	const receipts = config.data.required_corpus_receipts
	const census = { seed: options.seed, draws, augment }
	const audited = { ...config, data: { ...config.data, corpus_dir: options.corpusDir } }

	// Pass 1, the draw level.
	const windows: Array<Map<string, number>> = Array.from({ length: Math.ceil(draws / window) }, () => new Map())
	const totals = new Map<string, number>()
	const countries = new Map<string, number>()
	const countriesBySource = new Map<string, Map<string, number>>()
	const receiptCounts = new Map<string, number>()
	let index = 0

	for (const row of drawnRows(mtf, audited, census)) {
		countInto(windows[Math.floor(index / window)]!, row.source)
		countInto(totals, row.source)
		countInto(countries, countryKey(row.country))

		let bySource = countriesBySource.get(row.source)

		if (!bySource) {
			bySource = new Map()
			countriesBySource.set(row.source, bySource)
		}

		countInto(bySource, countryKey(row.country))

		for (const receipt of receipts) {
			if (matchesReceipt(row, receipt)) {
				countInto(receiptCounts, receipt.name)
			}
		}

		index++
	}

	const totalDraws = index
	const fullWindows = windows.filter((w) => [...w.values()].reduce((a, b) => a + b, 0) === window)

	const rowsBySource = new Map(
		mtf.sourceRowCounts(samplerConfigJSON(audited), "train").map(({ source, count }) => [source, count])
	)

	const drawShare = new Map<string, number>()
	const perSource: Record<string, Record<string, number | null>> = {}

	for (const source of [...new Set([...totals.keys(), ...requested.keys()])].toSorted()) {
		const req = requested.get(source)
		const drawn = totals.get(source) ?? 0
		const share = totalDraws ? drawn / totalDraws : 0
		const deviations = req ? fullWindows.map((w) => Math.abs((w.get(source) ?? 0) / window - req) / req) : []
		const rows = rowsBySource.get(source)

		drawShare.set(source, share)

		perSource[source] = {
			requested_share: req == null ? null : req,
			draws: drawn,
			draw_share: share,
			max_window_relative_deviation: deviations.length ? Math.max(...deviations) : 0,
			rows: rows ?? null,
			reps_per_row: rows ? drawn / rows : null,
		}
	}

	// Pass 2, the emitted level.
	const emittedTotals = new Map<string, number>()
	const emittedCountries = new Map<string, number>()
	let augmentedRows = 0
	let emitted = 0

	for (const { row, position } of emittedRows(mtf, audited, census)) {
		countInto(emittedTotals, row.source)
		countInto(emittedCountries, countryKey(row.country))

		if (position > 0) {
			augmentedRows++
		}

		emitted++
	}

	const emittedPerSource: Record<string, Record<string, number | null>> = {}

	for (const source of [...new Set([...emittedTotals.keys(), ...requested.keys()])].toSorted()) {
		const share = emitted ? (emittedTotals.get(source) ?? 0) / emitted : 0
		const drawnShare = drawShare.get(source) ?? 0

		emittedPerSource[source] = {
			emitted: emittedTotals.get(source) ?? 0,
			emitted_share: share,
			distortion_vs_draw_share: drawnShare ? share / drawnShare : null,
		}
	}

	// The expectation: each source-scoped receipt that narrows its source reads that source's train rows once.
	const narrowing = receipts.filter((receipt) => receipt.source != null && receiptNarrowsSource(receipt))
	const scannedSources = new Set(narrowing.map((receipt) => receipt.source!))

	const populations = scannedSources.size
		? countReceiptPopulations(sourceRows(mtf, audited, scannedSources), narrowing, config.data.country_weights)
		: new Map<string, ReceiptPopulation>()

	const receiptReport = receipts.map((receipt) => {
		const expectation = expectReceiptDraws(receipt, requested, totalDraws, populations.get(receipt.name))

		return {
			name: receipt.name,
			required_draws: receiptFloor(receipt, expectation.expected_draws),
			min_draws: receipt.min_draws,
			min_fraction_of_expected: receipt.min_fraction_of_expected,
			observed_draws: receiptCounts.get(receipt.name) ?? 0,
			...expectation,
			source: receipt.source,
			country: receipt.country,
			component_sequence: receipt.component_sequence,
		}
	})

	const failures = receiptReport.filter((r) => r.observed_draws < r.required_draws)

	// An absolute floor above its own expectation refuses most seeds by construction
	// (#2391), so it fails whatever this seed drew.
	const unreachable = receiptReport.filter((r) => r.expected_draws != null && r.min_draws > r.expected_draws)
	const countryCodes = Object.keys(config.data.country_weights).toSorted()

	const report = {
		requested: Object.fromEntries([...requested].map(([source, share]) => [source, share])),
		draw_level: {
			totals: dictOf(totals),
			windows: windows.map(dictOf),
			per_source: perSource,
			by_country: Object.fromEntries(mostCommon(countries)),
			countries_by_source: Object.fromEntries(
				sortedByKey(countriesBySource).map(([source, counts]) => [source, Object.fromEntries(mostCommon(counts))])
			),
			admitted_countries_drawn: Object.fromEntries(countryCodes.map((cc) => [cc, countries.get(cc) ?? 0])),
			admitted_countries_drawing_nothing: countryCodes.filter((cc) => !countries.get(cc)),
		},
		emitted_level: {
			totals: dictOf(emittedTotals),
			per_source: emittedPerSource,
			by_country: Object.fromEntries(mostCommon(emittedCountries)),
			augmented_share: emitted ? augmentedRows / emitted : 0,
		},
		meta: {
			seed: options.seed,
			draws_requested: draws,
			draws_realized: totalDraws,
			window,
			full_windows: fullWindows.length,
			corpus_dir: options.corpusDir,
			corpus_receipt_status: failures.length || unreachable.length ? "fail" : "pass",
		} as Record<string, unknown>,
		required_corpus_receipts: receiptReport,
	}

	const count = (n: number) => n.toLocaleString("en-US")

	const problems = [
		...failures.map(
			(r) => `${r.name}: observed ${count(r.observed_draws)} of required ${count(r.required_draws)} draws`
		),
		...unreachable.map(
			(r) =>
				`${r.name}: min_draws ${count(r.min_draws)} exceeds its expected ${r.expected_draws!.toFixed(1)} draws; ` +
				"lower it or state min_fraction_of_expected"
		),
	]

	const error = problems.length
		? new AuditFloorError("required corpus receipts failed: " + problems.join("; "), report)
		: null

	return { report, error, derivation }
}
