// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { type ReleaseRequirementSpec, validateReleaseSpec } from "#tools/eval-harness/release/requirements"

/**
 * What a new specification version records about the candidate it registers.
 */
export interface CandidateRegistration {
	/**
	 * The sha256 of the exact `model.onnx` that will ship.
	 */
	sha256: string
	/**
	 * Which artifact the digest names: run, seed, checkpoint and quantization.
	 */
	description: string
	/**
	 * The sentence that opens the new version's rationale: why the version exists, and every
	 * read of the source version that section 6.5 of HOLDOUT_AND_EVALUATION requires it to list.
	 */
	rationale: string
	/**
	 * The new version.
	 * One more than the source's when omitted.
	 */
	specVersion?: string
}

/**
 * Derives the specification version that registers a release candidate's identity.
 *
 * A specification that was read is never amended in place, so the candidate is registered by
 * a new version that keeps every other value of the source: each requirement, the objective,
 * the statistics, the provenance admission, both evaluation roles and the other identities.
 * The derived record is validated before it's returned.
 */
export function deriveCandidateSpec(
	source: ReleaseRequirementSpec,
	registration: CandidateRegistration
): ReleaseRequirementSpec {
	const sourceVersion = Number(source.specVersion)
	const specVersion = registration.specVersion ?? String(sourceVersion + 1)

	if (!Number.isInteger(sourceVersion) && !registration.specVersion) {
		throw new Error(`source specVersion ${source.specVersion} isn't an integer: name the new version`)
	}

	if (specVersion === source.specVersion) {
		throw new Error(`the new version must differ from the source's ${source.specVersion}`)
	}

	const rationale = registration.rationale.trim()

	if (!rationale) throw new Error("a registration needs a rationale")

	const derived: ReleaseRequirementSpec = {
		...structuredClone(source),
		specVersion,
		rationale:
			`${rationale} identities.candidate registers ${registration.description} ` +
			`(sha256 ${registration.sha256}). Every other value is v${source.specVersion}'s.`,
	}

	derived.identities.candidate = { description: registration.description, sha256: registration.sha256 }

	return validateReleaseSpec(derived, `release spec v${specVersion}`)
}
