/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Where a graded confidence comes from — the surfaces `reliability.ts` curves.
 *
 *   Two are wired, and they are genuinely different measurements rather than one function over two inputs, which the
 *   shared curve can hide. The DECODE surface reads the per-token softmax the parser already computes, folded to the
 *   unit a consumer reads (the assembled component); its truth is an input set's component labels. The COARSE-PLACER
 *   surface reads a calibrated classifier's own output probability against a held-out country label. They share a
 *   reliability diagram because a reliability diagram is the same diagram; they share nothing else. A third surface —
 *   the locale head, the kind verdict, an evidence channel — should be added the same way rather than by widening
 *   either of these.
 *
 *   Both report what they COULD NOT grade. A curve over 40 of 558 rows and a curve over 558 are different
 *   measurements, and the ECE alone cannot tell them apart.
 */

import type { DecoderToken } from "@mailwoman/core/decoder"
import { pathExists } from "@mailwoman/core/fs/readers"
import { componentMatches } from "mailwoman/eval-harness/gauntlet/check-case"
import { JSONSpliterator } from "spliterator"

import type { ResolvedInput } from "#input-sets"
import type { Observation } from "#reliability"

/**
 * What to do with a produced component the truth row never mentions.
 *
 * `exclude` (default) keeps it out of the curve and counts it separately — correct whenever truth is PARTIAL, which is
 * every corpus wired here. `wrong` grades it as an error, correct only against COMPLETE truth; on a partial corpus it
 * measures the corpus rather than the model.
 */
export const UnassertedPolicy = {
	Exclude: "exclude",
	Wrong: "wrong",
} as const

export type UnassertedPolicy = (typeof UnassertedPolicy)[keyof typeof UnassertedPolicy]

/**
 * How a component's confidence is folded out of its tokens.
 *
 * `min` is the weakest link — a span is only as trustworthy as its least certain piece — and is the default because
 * that is the reading an eval should use. `mean` exists because it is what `AddressNode.confidence` already reports
 * (`build-tree.ts`), so a caller calibrating the number a tree consumer actually reads can ask for it. The two diverge
 * most on long spans, which is where an eval decision is usually being made, so the choice travels with every result
 * rather than being assumed.
 */
export const ComponentAggregate = {
	Min: "min",
	Mean: "mean",
} as const

export type ComponentAggregate = (typeof ComponentAggregate)[keyof typeof ComponentAggregate]

export interface ExcludedRows {
	reason: string
	n: number
	examples: string[]
}

/**
 * Produced components no truth row asserted — the confidence mass riding on unverified output.
 *
 * Reported beside the curve rather than inside it. On a partial-truth corpus these are mostly correct components nobody
 * wrote an assertion for, so folding them in as errors measures the corpus; dropping them silently hides how much of
 * the parse the curve does not cover. Neither is a number worth quoting, so both facts are returned.
 */
export interface UnassertedCohort {
	n: number
	mean_confidence: number | null
	by_tag: Record<string, number>
}

export interface SurfaceSample {
	observations: Observation[]
	/**
	 * Rows the surface could not grade, and why. Reported rather than deducted in silence.
	 */
	excluded: ExcludedRows[]
	/**
	 * `null` when the caller chose `wrong`, since the cohort is then inside `observations` instead.
	 */
	unasserted: UnassertedCohort | null
	notes: string[]
}

/**
 * The slice of a geocode run this file reads. Declared structurally so the surface can be exercised without a warm
 * engine — a full `GeocodeSession` is several gigabytes of prerequisite to test a fold.
 */
export interface GeocodeRunLike {
	result: { components?: Record<string, string | undefined> }
	trace?: { parse?: { tokens: DecoderToken[] } }
}

export interface EngineLike {
	session: { geocode(input: string): Promise<GeocodeRunLike> }
}

/**
 * Reliability of the DECODE distribution, at the unit a consumer reads.
 *
 * The model emits a per-token softmax; a consumer reads an assembled component. So the confidence is folded across the
 * tokens carrying each tag ({@link ComponentAggregate}) and graded against the input set's component labels with the
 * harness's own rule — `componentMatches`, exact case-folded equality, SHARED rather than re-typed, because a local
 * copy of the correctness rule is how a calibration number quietly stops describing what the board describes.
 *
 * A produced tag the truth row does not mention is NOT graded by default. The strict reading — predicting a component
 * that should not exist is exactly the error a calibrated confidence must not hide — holds only against COMPLETE truth,
 * and no corpus wired here carries it: the regression board asserts a median of ONE component key per row (534 of 591
 * rows assert any, max 8), golden a median of 4 and parity a median of 2, against the ~7 keys a full US address has. On
 * truth that partial, a row asserting `locality` alone would grade six correctly-parsed components as hallucinations.
 *
 * So the unasserted tags are counted as their own cohort rather than folded in or thrown away: a reader asking the
 * hallucination question can see how much confidence rides on unverified components without that mass setting the
 * curve. {@link UnassertedPolicy.Wrong} restores the strict rule for a corpus that genuinely asserts every component.
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

			// Both BIO positions. A tag appearing in two separate spans folds into ONE observation, because the result
			// shape holds one value per tag — so one confidence is what a consumer sees, and splitting it here would
			// weight a fragmented span more heavily than a clean one.
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
 * Reliability of the coarse placer's own output probability against a held-out country label.
 *
 * A DIFFERENT surface from the decode softmax, needing its own curve before anyone fits a correction to it: the two are
 * separate heads over separate features, and a correction fitted to one does nothing for the other.
 *
 * `abstainBelow: 0` so every row yields a confidence. Production sets that to the threshold under test, which would
 * censor exactly the low-confidence rows the curve is about — a curve measured at the production threshold reports only
 * the region where the eval already agreed with itself.
 *
 * The default corpus is the held-out `test` split, held out from BOTH the training set and the `val` split the
 * temperature was fit on, so the number is not the fit reporting on itself. Pointing this at `val` or `train` destroys
 * that property without any other symptom, so the resolved path travels with the result.
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

	// Streamed rather than read whole: the held-out split is ~146k rows, and splitting it materializes every line
	// before the first prediction runs.
	for await (const row of JSONSpliterator.fromAsync<{ raw?: string; country?: string }>(corpusPath)) {
		if (!row?.raw || !row.country) {
			unusable.push(JSON.stringify(row).slice(0, 60))

			continue
		}

		const prediction = placer.predict(row.raw)

		observations.push({
			confidence: prediction.confidence,
			correct: prediction.country === row.country,
			// An abstain is a PREDICTION here, named rather than dropped: at abstainBelow 0 the placer still declines on
			// an out-of-set input, and dropping those rows would report a precision the eval does not deliver.
			strata: { expected: row.country, predicted: prediction.country ?? "(abstain)" },
		})
	}

	return {
		observations,
		excluded: [excludedRows("line carried no raw/country pair", unusable)].filter((entry) => entry.n > 0),
		// No analogue here: the placer emits exactly one prediction per row against exactly one label, so there is no
		// unasserted output for the truth to be silent about.
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
