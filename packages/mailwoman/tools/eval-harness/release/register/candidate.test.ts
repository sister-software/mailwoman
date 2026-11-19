// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { releaseSpecPath } from "#tools/eval-harness/release/current-spec"
import { deriveCandidateSpec } from "#tools/eval-harness/release/register/candidate"
import { readReleaseSpec } from "#tools/eval-harness/release/requirements"

/**
 * A committed version registered with no candidate identity.
 */
const SOURCE_SPEC = releaseSpecPath(11)

const candidate = {
	description: "seed 42 int8",
	sha256: "3017222708d1ddb67139d128006a11da6b7aed64b7a08d6ce28f1f428537ce89",
}

describe("deriveCandidateSpec", () => {
	it("changes only the version, the rationale and the candidate identity", async () => {
		const source = await readReleaseSpec(SOURCE_SPEC)
		const derived = deriveCandidateSpec(source, { candidate, rationale: "Version N registers the candidate." })

		expect(derived.specVersion).toBe(String(Number(source.specVersion) + 1))
		expect(derived.identities.candidate).toEqual(candidate)

		const unchanged = (spec: typeof source) => ({
			...spec,
			specVersion: null,
			rationale: null,
			identities: { ...spec.identities, candidate: null },
		})

		expect(source.identities.candidate.sha256).toBeNull()
		expect(unchanged(derived)).toEqual(unchanged(source))
	})

	it("refuses a malformed digest, an empty rationale, the source's own version and a non-integer source", async () => {
		const source = await readReleaseSpec(SOURCE_SPEC)
		const registration = { candidate, rationale: "Why." }

		expect(() => deriveCandidateSpec(source, { ...registration, candidate: { ...candidate, sha256: "ABC" } })).toThrow(
			/candidate.sha256/u
		)

		expect(() => deriveCandidateSpec(source, { ...registration, rationale: " " })).toThrow(/rationale/u)

		expect(() => deriveCandidateSpec(source, { ...registration, specVersion: source.specVersion })).toThrow(
			/must differ/u
		)

		expect(() => deriveCandidateSpec({ ...source, specVersion: "11a" }, registration)).toThrow(/isn't an integer/u)
	})
})
