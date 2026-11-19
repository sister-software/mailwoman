// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import {
	type ArtifactIdentity,
	type ReleaseRequirementSpec,
	validateReleaseSpec,
} from "#tools/eval-harness/release/requirements"

/**
 * What a new specification version records about the candidate it registers.
 */
export interface CandidateRegistration {
	/**
	 * The exact `model.onnx` that will ship: its sha256, and which run, seed,
	 * checkpoint and quantization produced it.
	 */
	candidate: ArtifactIdentity
	/**
	 * Why the version exists, and every read of the source version that section 6.5
	 * of HOLDOUT_AND_EVALUATION requires it to list.
	 */
	rationale: string
	/**
	 * The new version.
	 * One more than the source's when omitted.
	 */
	specVersion?: string
}

/**
 * The version after an integer version.
 */
function nextVersion(version: string): string {
	const number = Number(version)

	if (!Number.isInteger(number)) {
		throw new TypeError(`source specVersion ${version} isn't an integer: name the new version`)
	}

	return String(number + 1)
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
	{ candidate, rationale, specVersion: requested }: CandidateRegistration
): ReleaseRequirementSpec {
	const specVersion = requested || nextVersion(source.specVersion)

	if (specVersion === source.specVersion) {
		throw new Error(`the new version must differ from the source's ${source.specVersion}`)
	}

	if (!rationale.trim()) throw new Error("a registration needs a rationale")

	const copy = structuredClone(source)

	const derived: ReleaseRequirementSpec = {
		...copy,
		specVersion,
		rationale: `${rationale.trim()} Every other value is v${source.specVersion}'s.`,
		identities: { ...copy.identities, candidate },
	}

	return validateReleaseSpec(derived, `release spec v${specVersion}`)
}
