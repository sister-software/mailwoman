// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { CURRENT_RELEASE_SPEC } from "#tools/eval-harness/release/current-spec"
import { deriveCandidateSpec } from "#tools/eval-harness/release/register-candidate"
import { readReleaseSpec } from "#tools/eval-harness/release/requirements"

const SHA256 = "3017222708d1ddb67139d128006a11da6b7aed64b7a08d6ce28f1f428537ce89"

describe("deriveCandidateSpec", () => {
	it("changes only the version, the rationale and the candidate identity", async () => {
		const source = await readReleaseSpec(CURRENT_RELEASE_SPEC)

		const derived = deriveCandidateSpec(source, {
			sha256: SHA256,
			description: "seed 42 int8",
			rationale: "Version N registers the candidate.",
		})

		expect(derived.specVersion).toBe(String(Number(source.specVersion) + 1))
		expect(derived.identities.candidate).toEqual({ description: "seed 42 int8", sha256: SHA256 })
		expect(derived.rationale).toMatch(/^Version N registers the candidate\. identities\.candidate registers/u)

		const unchanged = (spec: typeof source) => ({
			...spec,
			specVersion: null,
			rationale: null,
			identities: { ...spec.identities, candidate: null },
		})

		expect(unchanged(derived)).toEqual(unchanged(source))
		expect(source.identities.candidate.sha256).toBeNull()
	})

	it("refuses a malformed digest, an empty rationale and the source's own version", async () => {
		const source = await readReleaseSpec(CURRENT_RELEASE_SPEC)
		const registration = { sha256: SHA256, description: "seed 42 int8", rationale: "Why." }

		expect(() => deriveCandidateSpec(source, { ...registration, sha256: "ABC" })).toThrow(/candidate.sha256/u)
		expect(() => deriveCandidateSpec(source, { ...registration, rationale: " " })).toThrow(/rationale/u)

		expect(() => deriveCandidateSpec(source, { ...registration, specVersion: source.specVersion })).toThrow(
			/must differ/u
		)
	})
})
