/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Where a graded confidence comes from — the surfaces `reliability.ts` curves; each reports what it could not grade,
 * because a curve over part of a set and a curve over all of it differ in ways the ECE alone cannot tell apart.
 */

import type { DecoderToken } from "@mailwoman/core/decoder"
import { pathExists } from "@mailwoman/core/fs/readers"
import { stringifyJSON } from "@mailwoman/core/json"
import { componentMatches } from "mailwoman/eval-harness/gauntlet/check-case"
import { JSONSpliterator } from "spliterator"

import type { ResolvedInput } from "#input-sets"
import type { Observation } from "#reliability/index"

/**
 * What to do with a produced component the truth row never mentions; `exclude`
 * counts it separately, correct on the partial truth every wired corpus carries,
 * while `wrong` grades it as an error that measures the corpus rather than the model.
 */
export const UnassertedPolicy = {
	Exclude: "exclude",
	Wrong: "wrong",
} as const

/**
 * The policy for grading a produced component no truth row asserts.
 */
export type UnassertedPolicy = (typeof UnassertedPolicy)[keyof typeof UnassertedPolicy]

/**
 * How a component's confidence is folded out of its tokens; `min` is the default
 * weakest-link reading an eval should use, while `mean` matches the `AddressNode.confidence`
 * a tree consumer reads, so the choice travels with every result.
 */
export const ComponentAggregate = {
	Min: "min",
	Mean: "mean",
} as const

/**
 * The fold applied to a component's token confidences.
 */
export type ComponentAggregate = (typeof ComponentAggregate)[keyof typeof ComponentAggregate]

/**
 * Rows a surface could not grade, with the reason and a few examples.
 */
export interface ExcludedRows {
	reason: string
	n: number
	examples: string[]
}

/**
 * Produced components no truth row asserted — confidence mass riding on unverified output,
 * reported beside the curve because folding it in as errors measures the corpus
 * and dropping it hides how much the curve does not cover.
 */
export interface UnassertedCohort {
	n: number
	mean_confidence: number | null
	by_tag: Record<string, number>
}

/**
 * A surface's graded observations plus what it could not grade.
 */
export interface SurfaceSample {
	observations: Observation[]
	/**
	 * Rows the surface could not grade, and why; reported rather than deducted in silence.
	 */
	excluded: ExcludedRows[]
	/**
	 * `null` when the caller chose `wrong`, since the cohort is then inside `observations` instead.
	 */
	unasserted: UnassertedCohort | null
	notes: string[]
}

/**
 * The subset of a geocode run's fields this file reads, declared structurally
 * so the surface can be exercised without a warm engine.
 */
export interface GeocodeRunLike {
	result: { components?: Record<string, string | undefined> }
	trace?: { parse?: { tokens: DecoderToken[] } }
}

/**
 * The engine surface {@link decodeReliabilitySample} needs.
 */
export interface EngineLike {
	session: { geocode(input: string): Promise<GeocodeRunLike> }
}

/**
 * Reliability of the decode distribution at the unit a consumer reads: the per-token softmax
 * folded across the tokens carrying each tag ({@link ComponentAggregate}) and graded
 * against the input set's component labels with the harness's own `componentMatches`.
 *
 * Unasserted produced tags are counted as their own cohort rather than folded in
 * or thrown away, because no corpus wired here asserts every component;
 * {@link UnassertedPolicy.Wrong} restores strict validation for one that does.
 */
export async function decodeReliabilitySample(
	engine: EngineLike,
	inputs: readonly ResolvedInput[],
	aggregate: ComponentAggregate,
	unassertedPolicy: UnassertedPolicy = UnassertedPolicy.Exclude
): Promise<SurfaceSample> {
	const observations: Observation[] = []
	const unassertedConfidences: number[] = []
	const unassertedByTag: Record<string, number> = {}
	const noTruth: string[] = []
	const noTrace: string[] = []
	const noLocatableSpan: string[] = []

	for (const item of inputs) {
		const truth = item.expectComponents ?? item.seed?.expectComponents

		if (!truth || !Object.keys(truth).length) {
			noTruth.push(item.id)

			continue
		}

		const run = await engine.session.geocode(item.input)
		const tokens = run.trace?.parse?.tokens

		if (!tokens) {
			noTrace.push(item.id)

			continue
		}

		const produced = run.result.components ?? {}
		let scored = 0

		for (const [tag, value] of Object.entries(produced)) {
			if (!value) continue

			// Both BIO positions, because the result shape holds one value per tag
			// and one confidence is what a consumer sees.
			const carrying = tokens.filter((token) => token.label === `B-${tag}` || token.label === `I-${tag}`)

			if (!carrying.length) continue

			const confidences = carrying.map((token) => token.confidence)

			const confidence =
				aggregate === ComponentAggregate.Mean
					? confidences.reduce((sum, entry) => sum + entry, 0) / confidences.length
					: Math.min(...confidences)

			const expected = truth[tag]

			if (expected === undefined && unassertedPolicy === UnassertedPolicy.Exclude) {
				unassertedConfidences.push(confidence)

				unassertedByTag[tag] = (unassertedByTag[tag] ?? 0) + 1

				continue
			}

			observations.push({
				confidence,
				correct: expected !== undefined && componentMatches(value, expected),
				strata: {
					tag,
					...(item.country ? { country: item.country } : {}),
					...(item.addressKind ? { address_kind: item.addressKind } : {}),
				},
			})

			scored++
		}

		if (!scored) {
			noLocatableSpan.push(item.id)
		}
	}

	return {
		observations,
		excluded: [
			excludedRows("row carries no component truth — nothing to grade a confidence against", noTruth),
			excludedRows("engine returned no parse trace, so no per-token confidence exists", noTrace),
			excludedRows("no produced component was both asserted by truth and locatable in the trace", noLocatableSpan),
		].filter((entry) => entry.n > 0),
		unasserted:
			unassertedPolicy === UnassertedPolicy.Wrong
				? null
				: {
						n: unassertedConfidences.length,
						mean_confidence: unassertedConfidences.length
							? unassertedConfidences.reduce((sum, entry) => sum + entry, 0) / unassertedConfidences.length
							: null,
						by_tag: unassertedByTag,
					},
		notes: [
			`component confidence folded as ${aggregate} over the tokens carrying each tag` +
				(aggregate === ComponentAggregate.Min
					? " (the weakest link; AddressNode.confidence reports the MEAN, so the two differ on long spans)"
					: " (matching AddressNode.confidence, which is also a mean)"),
			unassertedPolicy === UnassertedPolicy.Wrong
				? "unasserted produced components are graded WRONG — only sound against a corpus asserting EVERY component"
				: "unasserted produced components are counted separately, not curved: no wired corpus asserts every component",
		],
	}
}

/**
 * Reliability of the coarse placer's own output probability against a held-out country label,
 * measured at `abstainBelow: 0` so every row yields a confidence — the production
 * threshold would censor exactly the low-confidence rows the curve is about.
 *
 * The default corpus is the held-out `test` split, held out from both the training set
 * and the `val` split the temperature was fit on; pointing this at `val`
 * or `train` destroys that property without any other symptom.
 */
export async function coarsePlacerReliabilitySample(corpusPath: string): Promise<SurfaceSample> {
	if (!(await pathExists(corpusPath))) {
		throw new Error(
			`No coarse-placer corpus at ${corpusPath}. This split is a LOCAL artifact — it is not tracked in git, so a ` +
				"fresh worktree does not carry it. Pass `corpus` pointing at a checkout that has it. An absent corpus is " +
				"absence; a curve over whichever rows happened to be on disk is not this measurement."
		)
	}

	const { CoarsePlacer } = await import("@mailwoman/core/coarse-placer")
	const placer = await CoarsePlacer.fromBundled({ abstainBelow: 0, openSet: true })

	const observations: Observation[] = []
	const unusable: string[] = []

	// Streamed rather than read whole, because the held-out split is ~146k rows
	// and splitting it materializes every line before the first prediction.
	for await (const row of JSONSpliterator.fromAsync<{ raw?: string; country?: string }>(corpusPath)) {
		if (!row?.raw || !row.country) {
			unusable.push(stringifyJSON(row).slice(0, 60))

			continue
		}

		const prediction = placer.predict(row.raw)

		observations.push({
			confidence: prediction.confidence,
			correct: prediction.country === row.country,
			// An abstain is a prediction here, named rather than dropped, because at
			// abstainBelow 0 the placer still declines on an out-of-set input and dropping
			// those rows would report a precision the eval does not deliver.
			strata: { expected: row.country, predicted: prediction.country ?? "(abstain)" },
		})
	}

	return {
		observations,
		excluded: [excludedRows("line carried no raw/country pair", unusable)].filter((entry) => entry.n > 0),
		// No analogue here: the placer emits exactly one prediction per row against one label,
		// so there is no unasserted output for the truth to be silent about.
		unasserted: null,
		notes: [
			`corpus: ${corpusPath}`,
			"abstainBelow forced to 0 — the production threshold would censor the rows this curve is about",
			"open-set prediction; an abstain counts as an incorrect prediction rather than being dropped",
		],
	}
}

function excludedRows(reason: string, ids: readonly string[]): ExcludedRows {
	return { reason, n: ids.length, examples: ids.slice(0, 5) }
}
