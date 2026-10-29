/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Parses a frozen OpenStreetMap suite with one model across worker threads and totals exact parse
 *   correctness per country. Model inference takes milliseconds per row, the per-row cost at which
 *   `parallelMapWorkers` pays for its dispatch.
 */

import { parallelMapWorkers } from "spliterator"

import type { HeldoutRowOutcome } from "#tools/eval-harness/heldout/per/country"
import type { OSMSuiteRow } from "#tools/eval-harness/osm-suites/extract"
import type { SuiteParseWorkerData } from "#tools/eval-harness/osm-suites/parse-worker"

/**
 * One country's total in one suite.
 */
export interface SuiteCountryTotal {
	country: string
	rows: number
	exact: number
	goldRecovered: number
}

/**
 * Parse every row with the model in `data.cacheRoot` across `concurrency` workers.
 *
 * Outcomes arrive in completion order, each keyed by its row identity.
 */
export function gradeOSMSuite(
	rows: readonly OSMSuiteRow[],
	data: SuiteParseWorkerData,
	concurrency: number
): AsyncIterableIterator<HeldoutRowOutcome> {
	return parallelMapWorkers<OSMSuiteRow, HeldoutRowOutcome>(rows, {
		worker: import.meta.resolve("#tools/eval-harness/osm-suites/parse-worker"),
		concurrency,
		batchSize: 16,
		workerData: data,
	})
}

/**
 * Per-country totals of a suite's outcomes, sorted by country.
 */
export function totalSuiteOutcomes(outcomes: readonly HeldoutRowOutcome[]): SuiteCountryTotal[] {
	const totals = new Map<string, SuiteCountryTotal>()

	for (const outcome of outcomes) {
		const total = totals.get(outcome.country) ?? { country: outcome.country, rows: 0, exact: 0, goldRecovered: 0 }

		total.rows++
		total.exact += outcome.exact ? 1 : 0
		total.goldRecovered += outcome.goldRecovered ? 1 : 0
		totals.set(outcome.country, total)
	}

	return [...totals.values()].toSorted((a, b) => a.country.localeCompare(b.country))
}
