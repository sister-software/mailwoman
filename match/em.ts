/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unsupervised parameter estimation for the Fellegi-Sunter model — the part that makes the matcher
 *   work with no labeled data.
 *
 *   The paradox: to estimate `m`/`u` you need to know which pairs match, but finding matches is the
 *   whole problem. EM (Winkler 1988) breaks it by treating the match/non-match status as a hidden
 *   variable and iterating:
 *
 *   - **E-step** — under the current parameters, compute each pair's posterior responsibility `g =
 *       P(match | its agreement pattern)`.
 *   - **M-step** — re-estimate `λ`, and each level's `m`/`u`, as `g`-weighted (resp. `(1-g)`-weighted)
 *       fractions of the pairs landing in that level.
 *
 *   It converges because true matches agree on most fields and non-matches don't, so the two classes
 *   pull apart. Assumes conditional independence of the comparisons given match status (the
 *   standard F-S assumption). Caveat from the literature: EM can land in a local optimum when the
 *   true match rate is very low — seed from sensible `m`/`u` (the model's existing levels do this)
 *   and sanity- check that the recovered `m` exceeds `u` on the top agreement level.
 */

import type { Comparison, FellegiSunterModel } from "./fellegi-sunter.js"

/**
 * Tiny floor mixed into the M-step so an unobserved level never produces a zero (→ infinite weight).
 */
const EPSILON = 1e-9

/** Reduce a record pair to its agreement pattern — the per-comparison level index (`-1` = missing). */
export function agreementPattern<R>(comparisons: Comparison<R>[], a: R, b: R): number[] {
	return comparisons.map((comparison) => comparison.assess(a, b))
}

/** Options for {@link estimateParameters}. */
export interface EmOptions {
	/** Hard iteration cap. Default 100. */
	maxIterations?: number
	/** Convergence tolerance on the largest parameter change between iterations. Default 1e-6. */
	tolerance?: number
	/** Starting prior match rate. Defaults to the model's `lambda`. */
	initialLambda?: number
}

/** The fitted model plus convergence diagnostics. */
export interface EmResult<R> {
	/** The input model with every level's `m`/`u` and the prior `lambda` re-estimated. */
	model: FellegiSunterModel<R>
	/** The estimated prior match rate. */
	lambda: number
	iterations: number
	converged: boolean
}

/**
 * Estimate `m`/`u` and the prior `λ` from unlabeled agreement patterns via EM. The patterns are per-comparison level
 * indices (as produced by {@link agreementPattern}); a `-1` (missing) field contributes no evidence to either class. The
 * model's existing level `m`/`u` seed the iteration.
 */
export function estimateParameters<R>(
	model: FellegiSunterModel<R>,
	patterns: number[][],
	opts: EmOptions = {}
): EmResult<R> {
	const maxIterations = opts.maxIterations ?? 100
	const tolerance = opts.tolerance ?? 1e-6
	const comparisons = model.comparisons
	const levelCounts = comparisons.map((c) => c.levels.length)

	// Per-comparison, per-level m/u, seeded from the model's current levels.
	const m = comparisons.map((c) => c.levels.map((l) => l.m))
	const u = comparisons.map((c) => c.levels.map((l) => l.u))
	let lambda = opts.initialLambda ?? model.lambda

	let iterations = 0
	let converged = false

	if (patterns.length === 0) {
		return { model, lambda, iterations, converged }
	}

	for (; iterations < maxIterations; iterations++) {
		const mNumerator = comparisons.map((_, i) => new Array<number>(levelCounts[i]!).fill(0))
		const uNumerator = comparisons.map((_, i) => new Array<number>(levelCounts[i]!).fill(0))
		const mDenominator = comparisons.map(() => 0)
		const uDenominator = comparisons.map(() => 0)
		let responsibilitySum = 0

		// E-step: posterior P(match | pattern) for each pair.
		for (const pattern of patterns) {
			let matchLikelihood = lambda
			let nonMatchLikelihood = 1 - lambda

			for (let i = 0; i < comparisons.length; i++) {
				const level = pattern[i]!

				if (level < 0) continue
				matchLikelihood *= m[i]![level]!
				nonMatchLikelihood *= u[i]![level]!
			}
			const total = matchLikelihood + nonMatchLikelihood
			const g = total > 0 ? matchLikelihood / total : 0
			responsibilitySum += g

			for (let i = 0; i < comparisons.length; i++) {
				const level = pattern[i]!

				if (level < 0) continue
				mNumerator[i]![level]! += g
				uNumerator[i]![level]! += 1 - g
				mDenominator[i]! += g
				uDenominator[i]! += 1 - g
			}
		}

		// M-step: re-estimate λ and each level's m/u as (1-)g-weighted fractions.
		const newLambda = responsibilitySum / patterns.length
		let maxDelta = Math.abs(newLambda - lambda)
		lambda = newLambda

		for (let i = 0; i < comparisons.length; i++) {
			const levels = levelCounts[i]!

			for (let l = 0; l < levels; l++) {
				const newM =
					mDenominator[i]! > 0 ? (mNumerator[i]![l]! + EPSILON) / (mDenominator[i]! + EPSILON * levels) : m[i]![l]!
				const newU =
					uDenominator[i]! > 0 ? (uNumerator[i]![l]! + EPSILON) / (uDenominator[i]! + EPSILON * levels) : u[i]![l]!
				maxDelta = Math.max(maxDelta, Math.abs(newM - m[i]![l]!), Math.abs(newU - u[i]![l]!))
				m[i]![l] = newM
				u[i]![l] = newU
			}
		}

		if (maxDelta < tolerance) {
			converged = true
			iterations++
			break
		}
	}

	const fittedComparisons = comparisons.map((c, i) => ({
		...c,
		levels: c.levels.map((level, j) => ({ ...level, m: m[i]![j]!, u: u[i]![j]! })),
	}))

	return { model: { comparisons: fittedComparisons, lambda }, lambda, iterations, converged }
}
