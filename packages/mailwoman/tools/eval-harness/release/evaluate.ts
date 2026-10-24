/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Evaluates a release-requirement specification against the paired per-row outcomes the held-out grader
 *   writes (`heldout/per/country`), returning pass, fail or insufficient evidence.
 *
 *   Independent units. A row's unit is its `group` within its country. A row without a group is its own unit
 *   only when the specification declares rows independent (`statistics.rowsIndependent: true`); otherwise any
 *   check that reads an ungrouped row is insufficient evidence and reports no bounds, because bounds computed
 *   as if correlated variants were independent are too narrow (the 2026-10-20 simulation measured 33% joint
 *   coverage against a nominal 95%).
 *
 *   Admission. A minimum check reads the rows whose provenance class `provenance.admitted.minimum` lists (rows
 *   the candidate never trained on, whatever the published model saw). The objective and max-loss checks read
 *   only `provenance.admitted.comparative` (rows neither model trained on), because a row one model trained on
 *   favors that model in a comparison. The verdict also records the inference rule the outcomes were produced
 *   under. Outcomes that record none, or rows without a weights locale package, are insufficient evidence.
 *
 *   Capability probes. A source a capability requirement selects is read only by capability checks. Country
 *   checks, the objective and the per-class country report leave its rows out.
 *
 *   Simultaneous bounds. Every check the specification declares counts toward the registered correction
 *   (Bonferroni or Sidak), registered threshold or not, giving one per-side tail probability for every bound.
 *
 *   A minimum check (a candidate rate against a minimum) uses a Clopper–Pearson interval on the effective
 *   count. The cluster (sandwich, ratio-estimator) variance of the rate over units gives the design effect
 *   `deff = V_cluster / (p (1 - p) / n)`, and the effective count is `n / deff`, clamped to `[units, n]`.
 *   When the rate is 0 or 1 the design effect cannot be estimated and the effective count is the number of
 *   units, the most conservative value the clamp admits. Clopper–Pearson was chosen over a percentile
 *   bootstrap and over Wilson because it is exact (never below nominal) on independent binomial counts,
 *   discrete samples included, and its bound away from 0 or 1 never collapses: ten exact rows of ten give a
 *   lower bound well below 1, where every bootstrap resample of them is 1 and the percentile interval was
 *   [1, 1]. Its conservatism costs power at small samples, which the policy accepts: a small sample that
 *   cannot show a minimum is met is insufficient evidence.
 *
 *   A difference check (a capability's loss against its permitted loss, and the equal-country objective's Q
 *   improvement) uses an analytic cluster (sandwich) variance of the paired difference. Within each stratum (one
 *   per objective country, or one for a capability's pooled rows) the variance of the mean paired difference is
 *   `G / (G - 1) * sum_g (d_g - D m_g)^2 / n^2` over its G units, and Q's variance is the sum of the
 *   per-country variances over K^2. The bound is the estimate plus or minus a Student t quantile whose degrees
 *   of freedom are the Welch–Satterthwaite combination of the strata's `G - 1`. A stratum with fewer than two
 *   units has no variance estimate and makes the check insufficient. A stratum whose estimated variance is zero
 *   (in practice, when no unit is discordant) is degenerate: its variance is replaced by the exact zero-event bound,
 *   `q / G` with `q = 1 - tail^(1/G)` the Clopper–Pearson upper bound on the share of discordant units, since
 *   a unit's mean paired difference lies in [-1, 1]. A degenerate sample therefore never reports zero width,
 *   and it decides only once its unit count makes that bound narrow enough. A bound that is still zero width
 *   is insufficient evidence.
 *
 *   Boundary comparisons are inclusive on the passing side. A check passes when its lower bound is at least
 *   its threshold and its point estimate is at least its threshold. It fails when its upper bound is below the
 *   threshold. Anything between is insufficient evidence. A missing threshold or confidence level, a check
 *   without rows, an unregistered artifact identity, or ungrouped rows without a declaration of independence
 *   is insufficient evidence. None of these is ever read as zero loss or a pass.
 */

import type { HeldoutProvenance, HeldoutRowKind, HeldoutRowOutcome } from "#tools/eval-harness/heldout/per/country"
import { clopperPearson, studentTUpperQuantile } from "#tools/eval-harness/release/bounds"
import {
	capabilityProbeSources,
	HELDOUT_PROVENANCE_CLASSES,
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
	/**
	 * The weights locale package that parsed the row in both arms, `null` when the outcomes do not record it.
	 */
	weightsLocale: string | null
	published: boolean
	candidate: boolean
}

/**
 * The per-row outcome fields this evaluator reads, with the optional grouping and package metadata.
 */
export type OutcomeRow = Pick<HeldoutRowOutcome, "rowID" | "country" | "source" | "kind" | "provenance" | "exact"> & {
	group?: string | null
	weightsLocale?: string | null
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

/**
 * How a check's bounds were computed.
 */
export const BoundMethod = {
	ClopperPearson: "clopper_pearson_design_effect",
	ClusterRobustT: "cluster_robust_t",
} as const

export type BoundMethod = (typeof BoundMethod)[keyof typeof BoundMethod]

export interface CheckResult {
	id: string
	/**
	 * `minimum`: candidate rate against a minimum.
	 *
	 * `max_loss`: candidate minus published against the negated permitted loss.
	 * `objective`: Q improvement against the required improvement.
	 */
	check: "minimum" | "max_loss" | "objective"
	method: BoundMethod
	threshold: number | null
	rows: number
	groups: number
	estimate: number | null
	publishedEstimate: number | null
	lower: number | null
	upper: number | null
	/**
	 * Minimum checks: the effective count the Clopper–Pearson interval used.
	 */
	effectiveRows: number | null
	/**
	 * Difference checks: the Welch–Satterthwaite degrees of freedom of the t quantile.
	 */
	degreesOfFreedom: number | null
	/**
	 * Strata whose zero estimated variance was replaced by the zero-event bound.
	 */
	degenerateStrata: string[]
	outcome: ReleaseOutcome
	reasons: string[]
}

export interface ProvenanceClassReport {
	provenance: HeldoutProvenance
	/**
	 * Whether minimum checks, and comparative checks, read this class.
	 */
	admitted: { minimum: boolean; comparative: boolean }
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
	/**
	 * The inference rule that produced the outcomes, as the held-out report records it,
	 * and how many rows each weights locale package parsed.
	 */
	inference: { rule: string | null; rowsByWeightsLocale: Record<string, number> }
	statistics: {
		confidenceLevel: number | null
		method: MultipleComparisonMethod
		simultaneousChecks: number
		/**
		 * The per-side tail probability of every bound under the correction.
		 */
		percentile: number | null
		rowsIndependent: boolean
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

			if (!(HELDOUT_PROVENANCE_CLASSES as readonly string[]).includes(row.provenance)) {
				throw new Error(`${name} outcome ${row.rowID} has provenance ${String(row.provenance)}`)
			}
		}

		if (p.rowID !== c.rowID)
			throw new Error(`row ${i} is ${p.rowID} in the published arm and ${c.rowID} in the candidate`)

		for (const field of ["country", "source", "kind", "provenance"] as const) {
			if (p[field] !== c[field]) throw new Error(`row ${p.rowID} differs between arms in ${field}`)
		}

		if ((p.weightsLocale ?? null) !== (c.weightsLocale ?? null)) {
			throw new Error(`row ${p.rowID} was parsed by different weights locale packages in the two arms`)
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
			weightsLocale: p.weightsLocale ?? null,
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
 * One independent unit's totals: rows, candidate exact rows and published exact rows.
 */
interface Unit {
	rows: number
	candidate: number
	published: number
}

/**
 * Groups rows into independent units keyed by country and group, a row without a group being its own unit.
 */
function independentUnits(rows: readonly PairedRow[], indices: readonly number[]): Unit[] {
	const units = new Map<string, Unit>()

	for (const i of indices) {
		const row = rows[i]!
		const key = `${row.country}\u0000${row.group == null ? `row\u0000${row.rowID}` : `group\u0000${row.group}`}`
		const unit = units.get(key) ?? { rows: 0, candidate: 0, published: 0 }

		unit.rows++
		unit.candidate += Number(row.candidate)
		unit.published += Number(row.published)
		units.set(key, unit)
	}

	return [...units.values()]
}

interface RateBound {
	estimate: number
	publishedEstimate: number
	lower: number
	upper: number
	effectiveRows: number
}

/**
 * Clopper–Pearson bounds on the candidate rate at the design-effect-adjusted effective count.
 */
function rateBound(units: readonly Unit[], tail: number): RateBound | null {
	const G = units.length
	let n = 0
	let hits = 0
	let published = 0

	for (const unit of units) {
		n += unit.rows
		hits += unit.candidate
		published += unit.published
	}

	if (!n) return null

	const p = hits / n
	const binomial = (p * (1 - p)) / n
	let effectiveRows = G

	if (binomial > 0 && G > 1) {
		let squares = 0

		for (const unit of units) {
			squares += (unit.candidate - p * unit.rows) ** 2
		}

		const cluster = ((G / (G - 1)) * squares) / (n * n)
		const designEffect = cluster / binomial

		effectiveRows = Math.min(n, Math.max(G, designEffect > 0 ? n / designEffect : n))
	}

	const { lower, upper } = clopperPearson(p * effectiveRows, effectiveRows, tail)

	return { estimate: p, publishedEstimate: published / n, lower, upper, effectiveRows }
}

interface DifferenceStratum {
	label: string
	weight: number
	units: Unit[]
}

interface DifferenceBound {
	estimate: number
	publishedEstimate: number
	lower: number
	upper: number
	degreesOfFreedom: number
	degenerateStrata: string[]
}

/**
 * Cluster-variance t bounds on a weighted sum of per-stratum mean paired
 * differences (candidate minus published).
 *
 * Returns the strata that hold fewer than two units instead when any does.
 */
function differenceBound(
	strata: readonly DifferenceStratum[],
	tail: number
): DifferenceBound | { tooFewUnits: string[] } {
	const tooFewUnits = strata.filter((s) => s.units.length < 2).map((s) => s.label)

	if (tooFewUnits.length || !strata.length) return { tooFewUnits }

	let estimate = 0
	let publishedEstimate = 0
	let variance = 0
	let satterthwaite = 0
	const degenerateStrata: string[] = []

	for (const { label, weight, units } of strata) {
		const G = units.length
		let n = 0
		let diff = 0
		let published = 0

		for (const unit of units) {
			n += unit.rows
			diff += unit.candidate - unit.published
			published += unit.published
		}

		const D = diff / n
		let squares = 0

		for (const unit of units) {
			squares += (unit.candidate - unit.published - D * unit.rows) ** 2
		}

		let v = ((G / (G - 1)) * squares) / (n * n)

		if (!(v > 0)) {
			v = (1 - tail ** (1 / G)) / G
			degenerateStrata.push(label)
		}

		const contribution = weight * weight * v

		estimate += weight * D
		publishedEstimate += (weight * published) / n
		variance += contribution
		satterthwaite += (contribution * contribution) / (G - 1)
	}

	const degreesOfFreedom = Math.max(1, (variance * variance) / satterthwaite)
	const half = studentTUpperQuantile(tail, degreesOfFreedom) * Math.sqrt(variance)

	return {
		estimate,
		publishedEstimate,
		lower: Math.max(-1, estimate - half),
		upper: Math.min(1, estimate + half),
		degreesOfFreedom,
		degenerateStrata,
	}
}

interface CheckPlan {
	id: string
	check: CheckResult["check"]
	threshold: number | null
	/**
	 * The admitted rows this check kind reads; `rowIndices` and the strata index into it.
	 */
	rows: readonly PairedRow[]
	rowIndices: number[]
	/**
	 * Countries whose rows the statistic needs.
	 * A missing one makes the check insufficient.
	 */
	missingCountries: string[]
	/**
	 * Minimum checks read the pooled rows.
	 * Difference checks read these strata.
	 */
	strata: Array<{ label: string; weight: number; indices: number[] }>
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
	artifacts: { published: string; candidate: string },
	inference: { rule: string | null }
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

	if (!inference.rule) {
		globalReasons.push("the outcomes record no inference rule, so the configuration that produced them is unknown")
	}

	const unrecordedLocale = pairedRows.filter((row) => row.weightsLocale == null).length

	if (unrecordedLocale) {
		globalReasons.push(`${unrecordedLocale} of ${pairedRows.length} rows record no weights locale package`)
	}

	const admittedFor = {
		minimum: new Set(spec.provenance.admitted.minimum),
		comparative: new Set(spec.provenance.admitted.comparative),
	}

	for (const kind of ["minimum", "comparative"] as const) {
		if (!admittedFor[kind].size) {
			globalReasons.push(`the specification admits no provenance class for ${kind} checks`)
		}
	}

	// Minimum checks read rows unseen by the candidate.
	// Comparative checks read rows unseen by both models.
	const rowsFor = {
		minimum: pairedRows.filter((row) => admittedFor.minimum.has(row.provenance)),
		comparative: pairedRows.filter((row) => admittedFor.comparative.has(row.provenance)),
	}

	const plans: CheckPlan[] = []

	// A country requirement and the objective measure a country's ordinary addresses,
	// so they leave out the rows a capability requirement selects.
	const probes = capabilityProbeSources(spec)

	const selectIndices = (rows: readonly PairedRow[], select: RowSelector, withoutProbes: boolean) => {
		const indices = rows.flatMap((row, i) =>
			selects(row, select) && !(withoutProbes && probes.has(row.source)) ? [i] : []
		)

		const missingCountries = (select.countries ?? []).filter(
			(country) => !indices.some((i) => rows[i]!.country === country)
		)

		return { indices, missingCountries }
	}

	for (const req of spec.requirements) {
		const select: RowSelector = req.kind === "country" ? { ...req.select, countries: [req.country] } : req.select
		const minimum = selectIndices(rowsFor.minimum, select, req.kind === "country")

		plans.push({
			id: req.id,
			check: "minimum",
			threshold: req.minimum,
			rows: rowsFor.minimum,
			rowIndices: minimum.indices,
			missingCountries: minimum.missingCountries,
			strata: [],
		})

		if (req.kind === "capability" && req.maxLoss != null) {
			const comparative = selectIndices(rowsFor.comparative, select, false)

			plans.push({
				id: req.id,
				check: "max_loss",
				threshold: -req.maxLoss,
				rows: rowsFor.comparative,
				rowIndices: comparative.indices,
				missingCountries: comparative.missingCountries,
				strata: [{ label: req.id, weight: 1, indices: comparative.indices }],
			})
		}
	}

	const objective = selectIndices(
		rowsFor.comparative,
		{
			...spec.objective.select,
			countries: spec.objective.countries,
		},
		true
	)

	plans.push({
		id: "objective",
		check: "objective",
		threshold: spec.objective.minimumImprovement,
		rows: rowsFor.comparative,
		rowIndices: objective.indices,
		missingCountries: objective.missingCountries,
		strata: spec.objective.countries.map((country) => ({
			label: country,
			weight: 1 / spec.objective.countries.length,
			indices: objective.indices.filter((i) => rowsFor.comparative[i]!.country === country),
		})),
	})

	const { confidenceLevel, multipleComparison, rowsIndependent } = spec.statistics

	const percentile =
		confidenceLevel == null ? null : adjustedPercentile(confidenceLevel, plans.length, multipleComparison)

	if (confidenceLevel == null) {
		globalReasons.push("the confidence level is unregistered")
	}

	const checks = plans.map((plan): CheckResult => {
		const reasons: string[] = []
		const { rows } = plan
		const ungrouped = plan.rowIndices.filter((i) => rows[i]!.group == null).length
		const unitsValid = rowsIndependent || ungrouped === 0

		if (plan.threshold == null) {
			reasons.push("threshold unregistered")
		}

		if (!plan.rowIndices.length) {
			reasons.push("no admitted rows")
		}

		for (const country of plan.missingCountries) {
			reasons.push(`required country ${country} has no admitted rows`)
		}

		if (!unitsValid) {
			reasons.push(
				`${ungrouped} of ${plan.rowIndices.length} rows carry no group and the specification does not declare rows independent`
			)
		}

		let estimate: number | null = null
		let publishedEstimate: number | null = null
		let lower: number | null = null
		let upper: number | null = null
		let effectiveRows: number | null = null
		let degreesOfFreedom: number | null = null
		let degenerateStrata: string[] = []
		const boundable = percentile != null && plan.rowIndices.length > 0 && !plan.missingCountries.length

		if (plan.check === "minimum") {
			const bound = plan.rowIndices.length
				? rateBound(independentUnits(rows, plan.rowIndices), percentile ?? 0.025)
				: null

			estimate = bound?.estimate ?? null
			publishedEstimate = bound?.publishedEstimate ?? null

			if (bound && boundable && unitsValid) {
				lower = bound.lower
				upper = bound.upper
				effectiveRows = bound.effectiveRows
			}
		} else if (!plan.missingCountries.length && plan.strata.length) {
			const bound = differenceBound(
				plan.strata.map((s) => ({ label: s.label, weight: s.weight, units: independentUnits(rows, s.indices) })),
				percentile ?? 0.025
			)

			if ("tooFewUnits" in bound) {
				for (const label of bound.tooFewUnits) {
					reasons.push(`${label} holds fewer than two independent units, so its variance cannot be estimated`)
				}
			} else {
				estimate = bound.estimate
				publishedEstimate = bound.publishedEstimate

				if (boundable && unitsValid) {
					lower = bound.lower
					upper = bound.upper
					degreesOfFreedom = bound.degreesOfFreedom
					degenerateStrata = bound.degenerateStrata
				}
			}
		}

		if (lower != null && upper != null && !(upper > lower)) {
			reasons.push(`the interval [${lower}, ${upper}] has zero width`)
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

		return {
			id: plan.id,
			check: plan.check,
			method: plan.check === "minimum" ? BoundMethod.ClopperPearson : BoundMethod.ClusterRobustT,
			threshold: plan.threshold,
			rows: plan.rowIndices.length,
			groups: independentUnits(rows, plan.rowIndices).length,
			estimate,
			publishedEstimate,
			lower,
			upper,
			effectiveRows,
			degreesOfFreedom,
			degenerateStrata,
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
	const rowsByWeightsLocale: Record<string, number> = {}

	for (const row of pairedRows) {
		const key = row.weightsLocale ?? "unrecorded"

		rowsByWeightsLocale[key] = (rowsByWeightsLocale[key] ?? 0) + 1
	}

	return {
		specVersion: spec.specVersion,
		outcome,
		reasons: globalReasons,
		checks,
		provenance: reportProvenanceClasses(spec, pairedRows),
		inference: {
			rule: inference.rule,
			rowsByWeightsLocale,
		},
		statistics: {
			confidenceLevel,
			method: multipleComparison,
			simultaneousChecks: plans.length,
			percentile,
			rowsIndependent,
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
	const probes = capabilityProbeSources(spec)

	return HELDOUT_PROVENANCE_CLASSES.map((provenance) => {
		const members = rows.filter(
			(row) => row.provenance === provenance && selects(row, spec.objective.select) && !probes.has(row.source)
		)

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
			admitted: {
				minimum: spec.provenance.admitted.minimum.includes(provenance),
				comparative: spec.provenance.admitted.comparative.includes(provenance),
			},
			rows: members.length,
			countries: [...byCountry.entries()]
				.toSorted(([a], [b]) => a.localeCompare(b))
				.map(([country, cell]) => ({ country, ...cell })),
			qPublished: q("published"),
			qCandidate: q("candidate"),
		}
	})
}
