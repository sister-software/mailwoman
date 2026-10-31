/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The full-epoch audit of the source and country mixture: what the sampler draws, and what the trainer reads.
 *
 *   A prefix audit ends before any source exhausts, so it misses a mixture that drifts mid-epoch. This audit reads
 *   one row-limited epoch at two levels. The draw level counts the mixture's own rows per fixed window of draws,
 *   the stationarity receipt: every window must hold every source at its requested share. The emitted level runs
 *   the same stream through the trainer's emit step and counts what fills the row budget, where augmented copies
 *   compete with originals and `distortion_vs_draw_share` measures each source's realized-weight distortion.
 *
 *   A config's `required_corpus_receipts` name row shapes its corpus must hold: a source, a country and a
 *   contiguous component sequence, each with a floor of draws per epoch. The audit refuses an epoch below a floor.
 *   A passing audit is bound to the config's and the manifest's bytes by {@linkcode corpusReceiptBinding}.
 */

import { pySum } from "@mailwoman/core/numeric"
import { countInto, mostCommon } from "@mailwoman/core/stats"
import type { TrainingConfig } from "@mailwoman/corpus/training/config/schema"
import type { MTFNode } from "@mailwoman/mtf/tools/sampler/native"

import { samplerConfigJSON } from "../sampler.ts"
import { auditAugment, drawnRows, emittedRows } from "./census.ts"
import { AuditFloorError, sortedByKey } from "./receipt.ts"

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

	const receiptReport = receipts.map((receipt) => ({
		name: receipt.name,
		required_draws: receipt.min_draws,
		observed_draws: receiptCounts.get(receipt.name) ?? 0,
		source: receipt.source,
		country: receipt.country,
		component_sequence: receipt.component_sequence,
	}))

	const failures = receiptReport.filter((r) => r.observed_draws < r.required_draws)
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
			corpus_receipt_status: failures.length ? "fail" : "pass",
		} as Record<string, unknown>,
		required_corpus_receipts: receiptReport,
	}

	const count = (n: number) => n.toLocaleString("en-US")

	const error = failures.length
		? new AuditFloorError(
				"required corpus receipts failed: " +
					failures
						.map((r) => `${r.name}: observed ${count(r.observed_draws)} of required ${count(r.required_draws)} draws`)
						.join("; "),
				report
			)
		: null

	return { report, error, derivation }
}
