/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Evaluates a release-requirement specification against the paired per-row outcomes the held-out grader
 *   writes (`heldout/per/country`), returning pass, fail or insufficient evidence.
 *
 *   Uncertainty comes from a paired grouped bootstrap. Each resample draws, within every country, as many
 *   independent groups as the country holds, with replacement, and applies the same draw to both arms. Every
 *   country's exact parse rate, every capability rate and the equal-country objective Q are recomputed from
 *   that draw. A row's group is its `group` field when the outcome carries one, else its row identity; the
 *   result records which.
 *
 *   Bounds are two-sided percentile intervals, adjusted for the number of checks the specification declares
 *   (every check counts, registered threshold or not) by the registered correction. The lower percentile index
 *   is `floor(p (n - 1))` and the upper `ceil((1 - p) (n - 1))` of the sorted resample values, which widens
 *   rather than narrows an interval on discrete scores.
 *
 *   Boundary comparisons are inclusive on the passing side. A check passes when its lower bound is at least
 *   its threshold and its point estimate is at least its threshold. It fails when its upper bound is below the
 *   threshold. Anything between is insufficient evidence. A missing threshold or confidence level, a check
 *   without rows, an unregistered artifact identity, or a resample in which a check's rows were all drawn
 *   away is insufficient evidence; none of these is ever read as zero loss or a pass.
 */

import { mulberry32 } from "@mailwoman/core/random"

import type { HeldoutProvenance, HeldoutRowKind, HeldoutRowOutcome } from "#tools/eval-harness/heldout/per/country"
import {
	MultipleComparisonMethod,
	type ReleaseRequirementSpec,
	type RowSelector,
} from "#tools/eval-harness/release/requirements"

/**
 * One row's paired outcome, as read from both arms.
 */
export interface PairedRow {
	rowID: string
	country: string
	source: string
	kind: HeldoutRowKind
	provenance: HeldoutProvenance
	group: string | null
	published: boolean
	candidate: boolean
}

/**
 * The per-row outcome fields this evaluator reads, with the optional grouping metadata.
 */
export type OutcomeRow = Pick<HeldoutRowOutcome, "rowID" | "country" | "source" | "kind" | "provenance" | "exact"> & {
	group?: string | null
}

/**
 * The three release outcomes of the confirmed release-quality policy.
 *
 * Only `pass` permits promotion; `fail` means the evidence establishes an unmet
 * requirement, `insufficient_evidence` that it cannot decide.
 */
export const ReleaseOutcome = {
	Pass: "pass",
	Fail: "fail",
	Insufficient: "insufficient_evidence",
} as const

export type ReleaseOutcome = (typeof ReleaseOutcome)[keyof typeof ReleaseOutcome]

export interface CheckResult {
	id: string
	/**
	 * `minimum`: candidate rate against a minimum.
	 *
	 * `max_loss`: candidate minus published against the negated permitted loss.
	 * `objective`: Q improvement against the required improvement.
	 */
	check: "minimum" | "max_loss" | "objective"
	threshold: number | null
	rows: number
	groups: number
	estimate: number | null
	publishedEstimate: number | null
	lower: number | null
	upper: number | null
	failedResamples: number
	outcome: ReleaseOutcome
	reasons: string[]
}

export interface ProvenanceClassReport {
	provenance: HeldoutProvenance
	admitted: boolean
	rows: number
	countries: Array<{
		country: string
		rows: number
		published: number
		candidate: number
	}>
	/**
	 * Equal-weight Q over the objective set on this class's rows, or `null` when a country in C has none.
	 */
	qPublished: number | null
	qCandidate: number | null
}

export interface ReleaseVerdict {
	specVersion: string
	outcome: ReleaseOutcome
	reasons: string[]
	checks: CheckResult[]
	provenance: ProvenanceClassReport[]
	statistics: {
		confidenceLevel: number | null
		method: MultipleComparisonMethod
		simultaneousChecks: number
		percentile: number | null
		resamples: number
		seed: number
		grouping: "metadata" | "row_identity" | "mixed"
		groupingAssumption: string
	}
	artifacts: { published: string; candidate: string }
}

/**
 * Joins two arms' outcomes into paired rows, refusing arms whose rows differ in identity, order or metadata.
 */
export function pairOutcomes(published: readonly OutcomeRow[], candidate: readonly OutcomeRow[]): PairedRow[] {
	if (published.length !== candidate.length) {
		throw new Error(`the published arm holds ${published.length} rows and the candidate ${candidate.length}`)
	}

	const seen = new Set<string>()

	return published.map((p, i) => {
		const c = candidate[i]!

		for (const [name, row] of [
			["published", p],
			["candidate", c],
		] as const) {
			if (typeof row.rowID !== "string" || !row.rowID || typeof row.exact !== "boolean") {
				throw new Error(`${name} outcome ${i} is unreadable: it lacks a rowID or a boolean exact flag`)
			}

			if (typeof row.country !== "string" || typeof row.source !== "string") {
				throw new TypeError(`${name} outcome ${row.rowID} lacks a country or source`)
			}

			if (row.provenance !== "verified_unseen" && row.provenance !== "known_overlap" && row.provenance !== "unknown") {
				throw new Error(`${name} outcome ${row.rowID} has provenance ${String(row.provenance)}`)
			}
		}

		if (p.rowID !== c.rowID)
			throw new Error(`row ${i} is ${p.rowID} in the published arm and ${c.rowID} in the candidate`)

		for (const field of ["country", "source", "kind", "provenance"] as const) {
			if (p[field] !== c[field]) throw new Error(`row ${p.rowID} differs between arms in ${field}`)
		}

		if ((p.group ?? null) !== (c.group ?? null)) throw new Error(`row ${p.rowID} differs between arms in group`)

		if (seen.has(p.rowID)) throw new Error(`two rows share the identity ${p.rowID}`)
		seen.add(p.rowID)

		return {
			rowID: p.rowID,
			country: p.country,
			source: p.source,
			kind: p.kind,
			provenance: p.provenance,
			group: p.group ?? null,
			published: p.exact,
			candidate: c.exact,
		}
	})
}

/**
 * The per-check percentile under the registered correction, for two-sided simultaneous bounds.
 */
export function adjustedPercentile(confidenceLevel: number, checks: number, method: MultipleComparisonMethod): number {
	const alpha = 1 - confidenceLevel

	switch (method) {
		case MultipleComparisonMethod.Bonferroni:
			return alpha / checks / 2
		case MultipleComparisonMethod.Sidak:
			return (1 - (1 - alpha) ** (1 / checks)) / 2
		default:
			throw new Error(`unknown multiple-comparison method ${String(method)}`)
	}
}

function selects(row: PairedRow, select: RowSelector | undefined): boolean {
	if (!select) return true

	if (select.kinds && !select.kinds.includes(row.kind)) return false

	if (select.sources && !select.sources.includes(row.source)) return false

	if (select.countries && !select.countries.includes(row.country)) return false

	return true
}

/**
 * A statistic over row weights, returning `null` when the weighted rows it needs are empty.
 */
type Statistic = (weights: Float64Array) => number | null

interface CheckPlan {
	id: string
	check: CheckResult["check"]
	threshold: number | null
	rowIndices: number[]
	/**
	 * Countries whose rows the statistic needs; a missing one makes the check insufficient.
	 */
	missingCountries: string[]
	candidate: Statistic
	published: Statistic | null
	/**
	 * The quantity compared with the threshold.
	 */
	compared: Statistic
}

function rate(rows: readonly PairedRow[], indices: readonly number[], arm: "published" | "candidate"): Statistic {
	return (weights) => {
		let n = 0
		let hit = 0

		for (const i of indices) {
			const w = weights[i]!

			n += w

			if (rows[i]![arm]) {
				hit += w
			}
		}

		return n > 0 ? hit / n : null
	}
}

function equalCountryMean(perCountry: readonly Statistic[]): Statistic {
	return (weights) => {
		if (!perCountry.length) return null

		let sum = 0

		for (const stat of perCountry) {
			const value = stat(weights)

			if (value == null) return null
			sum += value
		}

		return sum / perCountry.length
	}
}

function difference(a: Statistic, b: Statistic): Statistic {
	return (weights) => {
		const x = a(weights)
		const y = b(weights)

		return x == null || y == null ? null : x - y
	}
}

/**
 * Builds a paired grouped resampler: each call returns row weights drawn by resampling
 * groups within each country, with replacement, from a seeded generator.
 */
export function groupedResampler(
	rows: readonly PairedRow[],
	seed: number
): { draw: () => Float64Array; groups: Map<string, number> } {
	const strata = new Map<string, Map<string, number[]>>()

	for (const [i, row] of rows.entries()) {
		const groups = strata.get(row.country) ?? new Map<string, number[]>()
		const key = row.group ?? row.rowID
		const members = groups.get(key) ?? []

		members.push(i)
		groups.set(key, members)
		strata.set(row.country, groups)
	}

	const stratumGroups = [...strata.entries()]
		.toSorted(([a], [b]) => a.localeCompare(b))
		.map(([, groups]) => [...groups.values()])

	const random = mulberry32(seed)

	return {
		groups: new Map([...strata.entries()].map(([country, groups]) => [country, groups.size])),
		draw: () => {
			const weights = new Float64Array(rows.length)

			for (const groups of stratumGroups) {
				for (const _ of groups) {
					for (const i of groups[Math.floor(random() * groups.length)]!) {
						weights[i]!++
					}
				}
			}

			return weights
		},
	}
}

function quantileIndex(n: number, p: number, side: "lower" | "upper"): number {
	const position = side === "lower" ? p * (n - 1) : (1 - p) * (n - 1)

	return Math.min(n - 1, Math.max(0, side === "lower" ? Math.floor(position + 1e-12) : Math.ceil(position - 1e-12)))
}

function countGroups(rows: readonly PairedRow[], indices: readonly number[]): number {
	return new Set(indices.map((i) => `${rows[i]!.country}\u0000${rows[i]!.group ?? rows[i]!.rowID}`)).size
}

/**
 * Evaluates the specification against paired rows.
 *
 * @param artifacts The sha256 digests measured from the two evaluated artifacts.
 * A digest that differs from a registered one is refused.
 */
export function evaluateReleaseSpec(
	spec: ReleaseRequirementSpec,
	pairedRows: readonly PairedRow[],
	artifacts: { published: string; candidate: string }
): ReleaseVerdict {
	const globalReasons: string[] = []

	for (const arm of ["published", "candidate"] as const) {
		const registered = spec.identities[arm].sha256

		if (registered == null) {
			globalReasons.push(`the ${arm} artifact identity is unregistered`)
		} else if (registered !== artifacts[arm]) {
			throw new Error(`the ${arm} artifact sha256 ${artifacts[arm]} does not match the registered ${registered}`)
		}
	}

	const admitted = new Set(spec.provenance.admitted)

	if (!admitted.size) {
		globalReasons.push("the specification admits no provenance class for comparative claims")
	}

	const rows = pairedRows.filter((row) => admitted.has(row.provenance))
	const allIndices = rows.map((_, i) => i)
	const plans: CheckPlan[] = []

	for (const req of spec.requirements) {
		const select: RowSelector = req.kind === "country" ? { ...req.select, countries: [req.country] } : req.select
		const indices = allIndices.filter((i) => selects(rows[i]!, select))
		const candidate = rate(rows, indices, "candidate")
		const published = rate(rows, indices, "published")

		const missingCountries = (select.countries ?? []).filter(
			(country) => !indices.some((i) => rows[i]!.country === country)
		)

		plans.push({
			id: req.id,
			check: "minimum",
			threshold: req.minimum,
			rowIndices: indices,
			missingCountries,
			candidate,
			published,
			compared: candidate,
		})

		if (req.kind === "capability" && req.maxLoss != null) {
			plans.push({
				id: req.id,
				check: "max_loss",
				threshold: -req.maxLoss,
				rowIndices: indices,
				missingCountries,
				candidate,
				published,
				compared: difference(candidate, published),
			})
		}
	}

	const objectiveIndices = allIndices.filter((i) =>
		selects(rows[i]!, {
			...spec.objective.select,
			countries: spec.objective.countries,
		})
	)

	const perCountry = (arm: "published" | "candidate") =>
		spec.objective.countries.map((country) =>
			rate(
				rows,
				objectiveIndices.filter((i) => rows[i]!.country === country),
				arm
			)
		)

	const qCandidate = equalCountryMean(perCountry("candidate"))
	const qPublished = equalCountryMean(perCountry("published"))
	const objectiveCountriesWithRows = new Set(objectiveIndices.map((i) => rows[i]!.country))

	plans.push({
		id: "objective",
		check: "objective",
		threshold: spec.objective.minimumImprovement,
		rowIndices: objectiveIndices,
		missingCountries: spec.objective.countries.filter((country) => !objectiveCountriesWithRows.has(country)),
		candidate: qCandidate,
		published: qPublished,
		compared: difference(qCandidate, qPublished),
	})

	const { confidenceLevel, multipleComparison, resamples, seed } = spec.statistics

	const percentile =
		confidenceLevel == null ? null : adjustedPercentile(confidenceLevel, plans.length, multipleComparison)

	if (confidenceLevel == null) {
		globalReasons.push("the confidence level is unregistered")
	}

	const samples = plans.map(() => [] as number[])
	const failures = plans.map(() => 0)
	const resampler = groupedResampler(rows, seed)

	if (percentile != null && rows.length) {
		for (let r = 0; r < resamples; r++) {
			const weights = resampler.draw()

			for (const [k, plan] of plans.entries()) {
				const value = plan.compared(weights)

				if (value == null) {
					failures[k]!++
				} else {
					samples[k]!.push(value)
				}
			}
		}
	}

	const ones = new Float64Array(rows.length).fill(1)

	const checks = plans.map((plan, k): CheckResult => {
		const reasons: string[] = []
		const estimate = plan.compared(ones)
		const sorted = samples[k]!.toSorted((a, b) => a - b)
		const bounded = percentile != null && sorted.length > 0 && failures[k] === 0
		const lower = bounded ? sorted[quantileIndex(sorted.length, percentile, "lower")]! : null
		const upper = bounded ? sorted[quantileIndex(sorted.length, percentile, "upper")]! : null

		if (plan.threshold == null) {
			reasons.push("threshold unregistered")
		}

		if (!plan.rowIndices.length) {
			reasons.push("no admitted rows")
		}

		for (const country of plan.missingCountries) {
			reasons.push(`required country ${country} has no admitted rows`)
		}

		if (failures[k]) {
			reasons.push(`${failures[k]} resamples drew none of this check's rows`)
		}

		let outcome: ReleaseOutcome = ReleaseOutcome.Insufficient

		if (!reasons.length && plan.threshold != null && lower != null && upper != null && estimate != null) {
			if (upper < plan.threshold) {
				outcome = ReleaseOutcome.Fail
				reasons.push(`upper bound ${upper} is below ${plan.threshold}`)
			} else if (lower >= plan.threshold && estimate >= plan.threshold) {
				outcome = ReleaseOutcome.Pass
			} else {
				reasons.push(`interval [${lower}, ${upper}] crosses ${plan.threshold}`)
			}
		} else if (percentile == null) {
			reasons.push("no confidence bounds without a registered confidence level")
		}

		const publishedEstimate = plan.published?.(ones) ?? null

		return {
			id: plan.id,
			check: plan.check,
			threshold: plan.threshold,
			rows: plan.rowIndices.length,
			groups: countGroups(rows, plan.rowIndices),
			estimate,
			publishedEstimate,
			lower,
			upper,
			failedResamples: failures[k]!,
			outcome,
			reasons,
		}
	})

	const anyFail = checks.some((check) => check.outcome === ReleaseOutcome.Fail)
	const allPass = checks.every((check) => check.outcome === ReleaseOutcome.Pass)

	const outcome = anyFail
		? ReleaseOutcome.Fail
		: allPass && !globalReasons.length
			? ReleaseOutcome.Pass
			: ReleaseOutcome.Insufficient

	const grouped = pairedRows.filter((row) => row.group != null).length

	return {
		specVersion: spec.specVersion,
		outcome,
		reasons: globalReasons,
		checks,
		provenance: reportProvenanceClasses(spec, pairedRows),
		statistics: {
			confidenceLevel,
			method: multipleComparison,
			simultaneousChecks: plans.length,
			percentile,
			resamples,
			seed,
			grouping: grouped === 0 ? "row_identity" : grouped === pairedRows.length ? "metadata" : "mixed",
			groupingAssumption: spec.statistics.groupingAssumption,
		},
		artifacts,
	}
}

/**
 * Point estimates per provenance class, reported separately whether or not the class is admitted.
 */
function reportProvenanceClasses(spec: ReleaseRequirementSpec, rows: readonly PairedRow[]): ProvenanceClassReport[] {
	return (["verified_unseen", "known_overlap", "unknown"] as const).map((provenance) => {
		const members = rows.filter((row) => row.provenance === provenance && selects(row, spec.objective.select))
		const byCountry = new Map<string, { rows: number; published: number; candidate: number }>()

		for (const row of members) {
			const cell = byCountry.get(row.country) ?? {
				rows: 0,
				published: 0,
				candidate: 0,
			}

			cell.rows++

			if (row.published) {
				cell.published++
			}

			if (row.candidate) {
				cell.candidate++
			}

			byCountry.set(row.country, cell)
		}

		const q = (arm: "published" | "candidate") => {
			if (!spec.objective.countries.length) return null

			let sum = 0

			for (const country of spec.objective.countries) {
				const cell = byCountry.get(country)

				if (!cell) return null
				sum += cell[arm] / cell.rows
			}

			return sum / spec.objective.countries.length
		}

		return {
			provenance,
			admitted: spec.provenance.admitted.includes(provenance),
			rows: members.length,
			countries: [...byCountry.entries()]
				.toSorted(([a], [b]) => a.localeCompare(b))
				.map(([country, cell]) => ({ country, ...cell })),
			qPublished: q("published"),
			qCandidate: q("candidate"),
		}
	})
}
