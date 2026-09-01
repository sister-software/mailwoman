/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Pairwise cluster scoring for the NPPES benchmark — precision/recall/F1 and adjusted Rand of recovered clusters
 *   against a truth labelling, plus the over-merge / under-merge shape counts.
 */

import type { ResolvedEntity, SourceRecord } from "#index"

/**
 * Pairs within a group of `n`.
 */
export const choose2 = (n: number): number => (n * (n - 1)) / 2

/**
 * One clustering scored against one truth labelling.
 */
export interface Score {
	precision: number
	recall: number
	f1: number
	ari: number
	clusters: number
	singletons: number
	overMergedClusters: number
	recordsInOverMerged: number
	maxNpisFused: number
	splitNpis: number
}

/**
 * Score recovered clusters against a truth labelling.
 *
 * Pairwise, not set-matching: a true pair is two records carrying the same `labelOf`, a predicted pair is two records
 * in the same entity. `totalRecords` is the labelled population and only feeds the adjusted-Rand expectation, so it
 * must be the whole record set rather than the clustered subset — a smaller value inflates ARI.
 */
export function scoreEntities(
	entities: readonly ResolvedEntity[],
	labelOf: (rec: SourceRecord) => string,
	totalRecords: number
): Score {
	const npiTotals = new Map<string, number>()
	const npiClusters = new Map<string, Set<number>>()
	let sumCK = 0 // Σ C(n_ck, 2)
	let sumCluster = 0 // Σ_c C(|c|, 2)
	let singletons = 0
	let overMergedClusters = 0
	let recordsInOverMerged = 0
	let maxNpisFused = 0

	entities.forEach((e, ci) => {
		const byNPI = new Map<string, number>()

		for (const rec of e.records) {
			const lbl = labelOf(rec)
			byNPI.set(lbl, (byNPI.get(lbl) ?? 0) + 1)
		}

		sumCluster += choose2(e.records.length)

		if (e.records.length === 1) {
			singletons++
		}

		if (byNPI.size > 1) {
			overMergedClusters++
			recordsInOverMerged += e.records.length
			maxNpisFused = Math.max(maxNpisFused, byNPI.size)
		}

		for (const [npi, n] of byNPI) {
			sumCK += choose2(n)
			npiTotals.set(npi, (npiTotals.get(npi) ?? 0) + n)
		}

		for (const rec of e.records) {
			const lbl = labelOf(rec)
			const s = npiClusters.get(lbl) ?? new Set<number>()
			s.add(ci)
			npiClusters.set(lbl, s)
		}
	})

	let sumClass = 0

	// Σ_k C(|k|, 2)
	for (const total of npiTotals.values()) {
		sumClass += choose2(total)
	}

	const tp = sumCK
	const precision = tp + (sumCluster - tp) > 0 ? tp / sumCluster : 0
	const recall = sumClass > 0 ? tp / sumClass : 0
	const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0
	const expected = (sumCluster * sumClass) / choose2(totalRecords)
	const maxIndex = (sumCluster + sumClass) / 2
	const ari = maxIndex - expected !== 0 ? (tp - expected) / (maxIndex - expected) : 1
	const splitNpis = [...npiClusters.values()].filter((s) => s.size > 1).length

	return {
		precision,
		recall,
		f1,
		ari,
		clusters: entities.length,
		singletons,
		overMergedClusters,
		recordsInOverMerged,
		maxNpisFused,
		splitNpis,
	}
}
