/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The align phase's accumulators as a record a worker writes and a coordinator merges.
 *
 *   A serial build fills one set of accumulators by visiting every source's rows in adapter order. A parallel build
 *   fills one set per align range. Merging those sets in adapter order, then range order, visits the same rows
 *   in the same order, so every sum is equal and every map lists its keys in the order the serial build first saw
 *   them. The build manifest serializes those maps, and a key order that followed worker scheduling would change
 *   its bytes.
 *
 *   Maps are stored as entry arrays rather than objects, because an object lists integer-like keys first.
 */

import type { AlignPhaseResult, AlignTally } from "#build/align"
import type { LicenseRefusalKind } from "#utils/license"
import type { SplitName } from "#utils/split"

/**
 * The align accumulators of one source, one align range, or one whole build.
 */
export interface AlignTotals extends AlignTally {
	counts: Record<SplitName, number>
	licenseCounts: Map<string, number>
	refusedByKind: Map<LicenseRefusalKind, number>
	refusedBySource: Map<string, number>
	rowsBySource: Map<string, { rows: number; license: string }>
	ineligibleSources: Map<string, readonly string[]>
	/**
	 * Every license value the policy refused, with its refusal kind.
	 */
	refusedValues: Map<string, LicenseRefusalKind>
}

/**
 * {@linkcode AlignTotals} as JSON.
 */
export interface AlignTotalsRecord {
	aligned: number
	quarantined: number
	excluded_by_license: number
	admitted_unresolved_license_rows: number
	excluded_by_eligibility: number
	counts: Record<SplitName, number>
	license_counts: [string, number][]
	refused_by_kind: [LicenseRefusalKind, number][]
	refused_by_source: [string, number][]
	rows_by_source: [string, { rows: number; license: string }][]
	ineligible_sources: [string, readonly string[]][]
	refused_license_values: [string, LicenseRefusalKind][]
}

/**
 * The totals of a finished align phase.
 */
export function alignTotalsOf(result: AlignPhaseResult): AlignTotals {
	return {
		aligned: result.aligned,
		quarantined: result.quarantined,
		excludedByLicense: result.excludedByLicense,
		admittedUnresolved: result.admittedUnresolved,
		excludedByEligibility: result.excludedByEligibility,
		counts: { ...result.counts },
		licenseCounts: result.licenseCounts,
		refusedByKind: result.refusedByKind,
		refusedBySource: result.refusedBySource,
		rowsBySource: result.rowsBySource,
		ineligibleSources: result.ineligibleSources,
		refusedValues: result.licenses.refusedValues(),
	}
}

export function serializeAlignTotals(totals: AlignTotals): AlignTotalsRecord {
	return {
		aligned: totals.aligned,
		quarantined: totals.quarantined,
		excluded_by_license: totals.excludedByLicense,
		admitted_unresolved_license_rows: totals.admittedUnresolved,
		excluded_by_eligibility: totals.excludedByEligibility,
		counts: { ...totals.counts },
		license_counts: [...totals.licenseCounts],
		refused_by_kind: [...totals.refusedByKind],
		refused_by_source: [...totals.refusedBySource],
		rows_by_source: [...totals.rowsBySource],
		ineligible_sources: [...totals.ineligibleSources],
		refused_license_values: [...totals.refusedValues],
	}
}

function addCounts<K>(into: Map<K, number>, entries: Iterable<[K, number]>): void {
	for (const [key, count] of entries) {
		into.set(key, (into.get(key) ?? 0) + count)
	}
}

function keepFirst<K, V>(into: Map<K, V>, entries: Iterable<[K, V]>): void {
	for (const [key, value] of entries) {
		if (!into.has(key)) {
			into.set(key, value)
		}
	}
}

/**
 * Merge records in the order their rows would have been aligned by one serial pass.
 *
 * Sums add.
 * `rowsBySource` keeps the license of the last record that saw the source, because the
 * serial align phase records each contributing row's license over the one before.
 *
 * The ineligibility reasons and refused values keep their first sighting, as the serial phase's caches do.
 */
export function mergeAlignTotals(records: readonly AlignTotalsRecord[]): AlignTotals {
	const totals: AlignTotals = {
		aligned: 0,
		quarantined: 0,
		excludedByLicense: 0,
		admittedUnresolved: 0,
		excludedByEligibility: 0,
		counts: { train: 0, val: 0, test: 0 },
		licenseCounts: new Map(),
		refusedByKind: new Map(),
		refusedBySource: new Map(),
		rowsBySource: new Map(),
		ineligibleSources: new Map(),
		refusedValues: new Map(),
	}

	for (const record of records) {
		totals.aligned += record.aligned
		totals.quarantined += record.quarantined
		totals.excludedByLicense += record.excluded_by_license
		totals.admittedUnresolved += record.admitted_unresolved_license_rows
		totals.excludedByEligibility += record.excluded_by_eligibility

		for (const split of ["train", "val", "test"] as const) {
			totals.counts[split] += record.counts[split]
		}

		addCounts(totals.licenseCounts, record.license_counts)
		addCounts(totals.refusedByKind, record.refused_by_kind)
		addCounts(totals.refusedBySource, record.refused_by_source)

		for (const [source, contributed] of record.rows_by_source) {
			const before = totals.rowsBySource.get(source)

			totals.rowsBySource.set(source, { rows: (before?.rows ?? 0) + contributed.rows, license: contributed.license })
		}

		keepFirst(totals.ineligibleSources, record.ineligible_sources)
		keepFirst(totals.refusedValues, record.refused_license_values)
	}

	return totals
}
