/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   This module grades comparisons only when their truth data supports a verdict.
 *
 *   `checkCase` grades individual cases. `toGauntletResult` projects the result. This module
 *   determines whether a set has truth data. It interprets a two-arm delta and calculates the
 *   smallest effect the current row count could detect.
 *
 *   A set without truth data receives the `ungradeable` grade. The grade keeps it out of passing cases.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import type { SeedCase } from "mailwoman/tools/eval-harness/gauntlet/cases/seed-case"
import type { GauntletResult } from "mailwoman/tools/eval-harness/gauntlet/harness"
import type { GauntletCaseTable } from "mailwoman/tools/eval-harness/gauntlet/schema"

/**
 * The z at which a two-sided 95% test rejects.
 * This matches `holdout.ts`'s `Z_CRITICAL_95_TWO_SIDED`.
 */
const Z_CRITICAL_95 = 1.96

/**
 * Written with explicit fields on purpose: `build-regression-db.ts` inserts the
 * same mapping positionally for bulk-load speed, so it cannot be shared as-is,
 * but listing every field means a column added to {@link GauntletCaseTable} is a
 * compile error here rather than a silently-null column at grade time.
 */
export function seedToCaseTable(seed: SeedCase): GauntletCaseTable {
	return {
		id: seed.id,
		input: seed.input,
		source: seed.source,
		address_kind: seed.addressKind,
		country: seed.country,
		status: seed.status,
		expect_components: seed.expectComponents ? stringifyJSON(seed.expectComponents) : null,
		expect_place_id: seed.expectPlaceID ?? null,
		expect_place_name: seed.expectPlaceName ?? null,
		expect_lat: seed.expectLat ?? null,
		expect_lon: seed.expectLon ?? null,
		expect_tolerance_m: seed.expectToleranceM ?? null,
		expect_tier: seed.expectTier ?? null,
		default_country: seed.defaultCountry ?? null,
		added_at: seed.addedAt,
		bug_ref: seed.bugRef ?? null,
		note: seed.note ?? null,
		ablation_expect: seed.ablationExpect ? stringifyJSON(seed.ablationExpect) : null,
		expect_component_renderings: seed.expectComponentRenderings ? stringifyJSON(seed.expectComponentRenderings) : null,
		locale: seed.locale ?? null,
		expect_abstain: seed.expectAbstain ? 1 : null,
	}
}

/**
 * A row with no expectations is ungradeable.
 *
 * Every sum keeps ungradeable rows separate from passing rows.
 */
export function caseCarriesTruth(seed: SeedCase): boolean {
	return Boolean(
		seed.expectComponents ||
		seed.expectComponentRenderings ||
		seed.expectPlaceID ||
		seed.expectPlaceName ||
		seed.expectTier ||
		seed.expectAbstain ||
		(typeof seed.expectLat === "number" && typeof seed.expectLon === "number")
	)
}

export type RowGrade = "improved" | "regressed" | "neutral" | "ungradeable"

/**
 * `checkCase` returns the list of issues, so fewer is better.
 *
 * Count comparison is deliberate because an arm that trades one wrong component
 * for a different wrong one has not improved.
 */
export function gradeRow(
	seed: SeedCase | undefined,
	a: GauntletResult,
	b: GauntletResult,
	check: (c: GauntletCaseTable, r: GauntletResult) => string[]
): { grade: RowGrade; issuesA: string[]; issuesB: string[] } {
	if (!seed || !caseCarriesTruth(seed)) return { grade: "ungradeable", issuesA: [], issuesB: [] }

	const table = seedToCaseTable(seed)
	const issuesA = check(table, a)
	const issuesB = check(table, b)

	if (issuesB.length < issuesA.length) return { grade: "improved", issuesA, issuesB }

	if (issuesB.length > issuesA.length) return { grade: "regressed", issuesA, issuesB }

	return { grade: "neutral", issuesA, issuesB }
}

export interface SignificanceReading {
	test: "two-proportion z"
	/**
	 * Successes are rows the arm graded clean, so the proportions are directly comparable.
	 */
	successes_a: number
	successes_b: number
	n: number
	z: number | null
	p: number | null
	verdict: "a_better" | "b_better" | "indistinguishable" | "untestable"
	/**
	 * Always reported, especially under an `indistinguishable` verdict, because
	 * without it that verdict cannot be told from "no effect".
	 */
	mde_pp_at_this_n: number | null
	sentence: string
}

/**
 * Normal CDF via the Abramowitz–Stegun 7.1.26 erf approximation.
 *
 * Its maximum absolute error is 1.5e-7, four orders of magnitude below the precision of decisions made here.
 */
export function normalCDF(z: number): number {
	const sign = z < 0 ? -1 : 1
	const x = Math.abs(z) / Math.SQRT2
	const t = 1 / (1 + 0.3275911 * x)

	const y =
		1 -
		((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)

	return 0.5 * (1 + sign * y)
}

/**
 * The MDE is the effect this n would detect with 80% power at α = 0.05.
 *
 * This threshold follows a statistical convention rather than a measurement.
 *
 * It reports the smallest effect the test could detect when the observed effect is zero.
 */
export function significance(successesA: number, successesB: number, n: number): SignificanceReading {
	if (n === 0) {
		return {
			test: "two-proportion z",
			successes_a: 0,
			successes_b: 0,
			n: 0,
			z: null,
			p: null,
			verdict: "untestable",
			mde_pp_at_this_n: null,
			sentence: "No rows were gradeable in both arms, so no test was run. This is not a tie.",
		}
	}

	const pA = successesA / n
	const pB = successesB / n
	const pooled = (successesA + successesB) / (2 * n)
	const standardError = Math.sqrt(2 * pooled * (1 - pooled) * (1 / n))

	// 1.96 (α=0.05, two-sided) + 0.84 (80% power) is the standard MDE multiplier.
	const mde = 2.8 * Math.sqrt((2 * 0.25) / n) * 100

	if (standardError === 0) {
		return {
			test: "two-proportion z",
			successes_a: successesA,
			successes_b: successesB,
			n,
			z: null,
			p: null,
			verdict: "indistinguishable",
			mde_pp_at_this_n: mde,
			sentence: `Both arms graded identically on all ${n} rows, so the test has no variance to work with. At this n the smallest detectable difference is ${mde.toFixed(1)}pp.`,
		}
	}

	const z = (pB - pA) / standardError
	const p = 2 * (1 - normalCDF(Math.abs(z)))
	const significant = Math.abs(z) >= Z_CRITICAL_95
	const verdict = significant ? (z > 0 ? "b_better" : "a_better") : "indistinguishable"
	const deltaPP = (pB - pA) * 100

	return {
		test: "two-proportion z",
		successes_a: successesA,
		successes_b: successesB,
		n,
		z,
		p,
		verdict,
		mde_pp_at_this_n: mde,
		sentence: significant
			? `${deltaPP >= 0 ? "B" : "A"} is better by ${Math.abs(deltaPP).toFixed(1)}pp (z = ${z.toFixed(2)}, p = ${p.toFixed(4)}, n = ${n}).`
			: `Indistinguishable at n = ${n}: the ${Math.abs(deltaPP).toFixed(1)}pp gap sits inside noise (z = ${z.toFixed(2)}, p = ${p.toFixed(4)}). This run could not have detected an effect smaller than ${mde.toFixed(1)}pp, so it does not show the arms are equivalent.`,
	}
}
