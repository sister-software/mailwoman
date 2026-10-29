/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Splits paired held-out outcomes by row kind and by training-overlap provenance.
 *
 *   A pooled exact-parse difference mixes rows that answer different questions. Gazetteer name strings are scored
 *   beside addresses, and rows the published model trained on are scored beside rows neither model saw. Each split
 *   here reports the baseline's exact-parse rate, each candidate's rate, the difference in points, and the rows
 *   only the candidate gets right (fixes) and only the baseline gets right (breaks).
 */

import type { HeldoutProvenance, HeldoutRowKind, HeldoutRowOutcome } from "#tools/eval-harness/heldout/per/country"

/**
 * One candidate's paired result on one split.
 */
export interface PairedSplitArm {
	exact: number
	/**
	 * Rows the candidate parses exactly and the baseline does not.
	 */
	fixes: number
	/**
	 * Rows the baseline parses exactly and the candidate does not.
	 */
	breaks: number
}

/**
 * Paired outcomes on the rows one split selects.
 */
export interface PairedSplit {
	split: string
	rows: number
	baselineExact: number
	candidates: PairedSplitArm[]
}

/**
 * The split a row belongs to, or `null` to leave it out.
 */
export type PairedSplitKey = (outcome: HeldoutRowOutcome) => string | null

/**
 * Reads the outcome of row `i` in every arm, throwing when the arms are not paired by row identity.
 */
function pairedRow(arms: readonly (readonly HeldoutRowOutcome[])[], i: number): HeldoutRowOutcome[] {
	const row = arms.map((arm) => arm[i]!)
	const first = row[0]!

	for (const [index, outcome] of row.entries()) {
		if (outcome.rowID !== first.rowID) {
			throw new Error(`arm ${index} row ${i} is ${outcome.rowID}; arm 0 row ${i} is ${first.rowID}`)
		}
	}

	return row
}

/**
 * Groups paired outcomes by `keyOf` and totals each split.
 *
 * @param arms Every arm's outcomes in row order.
 * The first arm is the baseline.
 * @returns One entry per split, ordered by split name.
 */
export function splitPairedOutcomes(
	arms: readonly (readonly HeldoutRowOutcome[])[],
	keyOf: PairedSplitKey
): PairedSplit[] {
	const [baseline, ...candidates] = arms

	if (!baseline || !candidates.length) throw new Error("a paired split needs a baseline and at least one candidate")

	for (const [index, arm] of arms.entries()) {
		if (arm.length !== baseline.length) {
			throw new Error(`arm ${index} has ${arm.length} outcomes; the baseline has ${baseline.length}`)
		}
	}

	const splits = new Map<string, PairedSplit>()

	for (let i = 0; i < baseline.length; i++) {
		const [base, ...others] = pairedRow(arms, i)
		const key = keyOf(base!)

		if (key == null) continue

		let split = splits.get(key)

		if (!split) {
			split = {
				split: key,
				rows: 0,
				baselineExact: 0,
				candidates: candidates.map(() => ({ exact: 0, fixes: 0, breaks: 0 })),
			}

			splits.set(key, split)
		}

		split.rows++

		if (base!.exact) {
			split.baselineExact++
		}

		for (const [index, outcome] of others.entries()) {
			const arm = split.candidates[index]!

			if (outcome.exact) {
				arm.exact++
			}

			if (outcome.exact && !base!.exact) {
				arm.fixes++
			}

			if (base!.exact && !outcome.exact) {
				arm.breaks++
			}
		}
	}

	return [...splits.values()].toSorted((a, b) => a.split.localeCompare(b.split))
}

/**
 * Splits by row kind.
 */
export const byRowKind: PairedSplitKey = (outcome) => outcome.kind

/**
 * Splits by provenance class.
 */
export const byProvenance: PairedSplitKey = (outcome) => outcome.provenance

/**
 * Splits by row kind and provenance class together, as `<kind>/<provenance>`.
 */
export const byKindAndProvenance: PairedSplitKey = (outcome) => `${outcome.kind}/${outcome.provenance}`

/**
 * Splits the rows of one kind and provenance class by source, leaving every other row out.
 */
export function bySourceWithin(kind: HeldoutRowKind, provenance: HeldoutProvenance): PairedSplitKey {
	return (outcome) => (outcome.kind === kind && outcome.provenance === provenance ? outcome.source : null)
}

/**
 * One arm's equal-country exact-parse rate: the mean over countries of each
 * country's exact-parse rate on the rows `keep` admits.
 */
export interface EqualCountryRate {
	countries: number
	rows: number
	/**
	 * Per arm, the mean of the per-country rates, in arm order.
	 */
	rates: number[]
}

/**
 * Computes every arm's equal-country exact-parse rate over the rows `keep` admits,
 * so a country with 990 rows weighs the same as a country with 9.
 */
export function equalCountryExactRate(
	arms: readonly (readonly HeldoutRowOutcome[])[],
	keep: (outcome: HeldoutRowOutcome) => boolean
): EqualCountryRate {
	const [baseline] = arms

	if (!baseline) throw new Error("no arms")

	const perCountry = new Map<string, { rows: number; exact: number[] }>()

	for (let i = 0; i < baseline.length; i++) {
		const row = pairedRow(arms, i)

		if (!keep(row[0]!)) continue

		const cell = perCountry.get(row[0]!.country) ?? { rows: 0, exact: arms.map(() => 0) }

		cell.rows++

		for (const [index, outcome] of row.entries()) {
			if (outcome.exact) {
				cell.exact[index]!++
			}
		}

		perCountry.set(row[0]!.country, cell)
	}

	const cells = [...perCountry.values()]

	return {
		countries: cells.length,
		rows: cells.reduce((sum, cell) => sum + cell.rows, 0),
		rates: arms.map((_, index) =>
			cells.length ? cells.reduce((sum, cell) => sum + cell.exact[index]! / cell.rows, 0) / cells.length : Number.NaN
		),
	}
}

const percent = (n: number, d: number) => (d ? ((100 * n) / d).toFixed(2) : "n/a")

/**
 * Renders paired splits as tab-separated lines: split, rows, baseline exact percent,
 * then per candidate its exact percent, its difference in points, its fixes and its breaks.
 */
export function formatPairedSplits(title: string, splits: readonly PairedSplit[], candidateCount: number): string[] {
	const header = ["split", "rows", "baseline %"]

	for (let i = 1; i <= candidateCount; i++) {
		header.push(`cand${i} %`, `cand${i} Δ pts`, `cand${i} fixes`, `cand${i} breaks`)
	}

	const lines = [`# ${title}`, header.join("\t")]

	for (const split of splits) {
		const cells = [split.split, String(split.rows), percent(split.baselineExact, split.rows)]

		for (const arm of split.candidates) {
			cells.push(
				percent(arm.exact, split.rows),
				split.rows ? ((100 * (arm.exact - split.baselineExact)) / split.rows).toFixed(2) : "n/a",
				String(arm.fixes),
				String(arm.breaks)
			)
		}

		lines.push(cells.join("\t"))
	}

	return lines
}
