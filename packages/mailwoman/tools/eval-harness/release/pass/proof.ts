// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The pass proof: whether the release evaluator can return `pass` on a frozen
 *   collection's groups, asked before a re-split commits a training run to that
 *   collection (HOLDOUT_AND_EVALUATION, principle P3).
 *
 *   It reads each collection manifest's row entries (identity, country, source, kind and group)
 *   and the provenance class each row's audit gives it.
 *   It reads no rows file, so no expected span or label, and it scores no model.
 *
 *   Each row's exact flags are synthetic: a hash of the row's identity draws one uniform
 *   value per outcome, and an arm with rate `r` is exact where the value is under `r`.
 *   The two arms share the value, so a candidate rate above the published rate never loses a row.
 *
 *   The specification is evaluated as registered, except where the proof can't read what it needs:
 *
 *   - Each artifact identity the specification leaves unregistered is given a synthetic digest.
 *     The candidate always gets one, distinct from the published digest, so the two arms are two models.
 *   - A `withoutTags` selector needs each row's expected tags.
 *     Those tags are labels.
 *     The proof drops it and lists the requirement, so that check counts every
 *     row of its sources, an upper bound.
 *
 *   An arm whose candidate rate is above its published rate must read `pass` on a
 *   collection that can decide a release, and an arm at the published rate mustn't.
 *   A check that's insufficient on the first arm reports, in rows and groups, what the collection lacks.
 */

import { hashUint32 } from "@mailwoman/corpus/utils/split"

import type { HeldoutDatasetEntry } from "#tools/eval-harness/heldout/dataset/manifest"
import type { HeldoutProvenance, ProvenanceHistory } from "#tools/eval-harness/heldout/per/country"
import {
	evaluateReleaseSpec,
	type PairedRow,
	ReleaseOutcome,
	type ReleaseVerdict,
} from "#tools/eval-harness/release/evaluate"
import type { ReleaseRequirementSpec } from "#tools/eval-harness/release/requirements"

/**
 * One synthetic arm pair: the published and candidate exact rates every row is drawn at.
 */
export interface PassProofArm {
	label: string
	published: number
	candidate: number
}

/**
 * The two arms the proof evaluates by default.
 *
 * A candidate ten points above the published model must pass, and a candidate equal to it mustn't.
 */
export const PASS_PROOF_ARMS: readonly PassProofArm[] = [
	{ label: "candidate above published", published: 0.85, candidate: 0.95 },
	{ label: "candidate equal to published", published: 0.85, candidate: 0.85 },
]

/**
 * The inference rule the synthetic outcomes record.
 */
export const PASS_PROOF_INFERENCE_RULE = "synthetic pass proof: no model parsed a row"

/**
 * The digests the proof gives an unregistered artifact identity.
 */
const SYNTHETIC_DIGEST = { published: "0".repeat(64), candidate: "f".repeat(64) } as const

/**
 * A uniform value in [0, 1) drawn from a row's identity, a seed and the outcome it decides.
 */
function uniform(seed: number, outcome: string, rowID: string): number {
	return hashUint32(`${seed}\u0000${outcome}\u0000${rowID}`) / 2 ** 32
}

/**
 * The paired rows of one arm, from manifest entries and their provenance classes.
 *
 * A row the history doesn't class reads `fallback`, `unknown` unless the caller assumes a class.
 */
export function passProofRows(
	entries: ReadonlyArray<Pick<HeldoutDatasetEntry, "rowID" | "country" | "source" | "kind" | "group">>,
	history: ProvenanceHistory,
	arm: PassProofArm,
	seed: number,
	fallback: HeldoutProvenance = "unknown"
): PairedRow[] {
	return entries.map((entry) => {
		const parse = uniform(seed, "parse", entry.rowID)
		const geocode = uniform(seed, "geocode", entry.rowID)

		return {
			rowID: entry.rowID,
			country: entry.country,
			source: entry.source,
			kind: entry.kind,
			provenance: history.get(entry.rowID)?.provenance ?? fallback,
			group: entry.group,
			weightsLocale: "synthetic",
			tags: [],
			published: parse < arm.published,
			candidate: parse < arm.candidate,
			geocode: { published: geocode < arm.published, candidate: geocode < arm.candidate },
		}
	})
}

/**
 * The specification as the proof evaluates it, and the requirements whose tag selector it dropped.
 */
export function passProofSpec(spec: ReleaseRequirementSpec): {
	spec: ReleaseRequirementSpec
	artifacts: { published: string; candidate: string }
	tagSelectorsDropped: string[]
} {
	const copy = structuredClone(spec)
	const dropped: string[] = []

	for (const requirement of copy.requirements) {
		if (requirement.select?.withoutTags) {
			delete requirement.select.withoutTags
			dropped.push(requirement.id)
		}
	}

	if (copy.objective.select?.withoutTags) {
		delete copy.objective.select.withoutTags
		dropped.push("objective")
	}

	const published = copy.identities.published.sha256 ?? SYNTHETIC_DIGEST.published
	const candidate = published === SYNTHETIC_DIGEST.candidate ? SYNTHETIC_DIGEST.published : SYNTHETIC_DIGEST.candidate

	copy.identities.published.sha256 = published
	copy.identities.candidate.sha256 = candidate

	return { spec: copy, artifacts: { published, candidate }, tagSelectorsDropped: dropped }
}

/**
 * One arm's verdict and whether it is the one the proof expects.
 */
export interface PassProofArmResult {
	arm: PassProofArm
	verdict: ReleaseVerdict
	/**
	 * `pass` for an arm whose candidate rate is above its published rate, anything else otherwise.
	 */
	expected: "pass" | "not pass"
	met: boolean
}

export interface PassProofReport {
	specVersion: string
	seed: number
	rows: number
	groups: number
	tagSelectorsDropped: string[]
	arms: PassProofArmResult[]
	/**
	 * Whether every arm read as expected: the collection can decide a release under the specification.
	 */
	proven: boolean
}

/**
 * Evaluates the specification on each synthetic arm over the entries.
 */
export function runPassProof(input: {
	spec: ReleaseRequirementSpec
	entries: ReadonlyArray<Pick<HeldoutDatasetEntry, "rowID" | "country" | "source" | "kind" | "group">>
	history: ProvenanceHistory
	seed: number
	arms?: readonly PassProofArm[]
	fallback?: HeldoutProvenance
}): PassProofReport {
	const { spec, artifacts, tagSelectorsDropped } = passProofSpec(input.spec)

	const arms = (input.arms ?? PASS_PROOF_ARMS).map((arm): PassProofArmResult => {
		const verdict = evaluateReleaseSpec(
			spec,
			passProofRows(input.entries, input.history, arm, input.seed, input.fallback),
			artifacts,
			{ rule: PASS_PROOF_INFERENCE_RULE }
		)

		const expected = arm.candidate > arm.published ? "pass" : "not pass"
		const met = (verdict.outcome === ReleaseOutcome.Pass) === (expected === "pass")

		return { arm, verdict, expected, met }
	})

	return {
		specVersion: input.spec.specVersion,
		seed: input.seed,
		rows: input.entries.length,
		groups: new Set(input.entries.map((entry) => `${entry.country}\u0000${entry.group}`)).size,
		tagSelectorsDropped,
		arms,
		proven: arms.every((arm) => arm.met),
	}
}
