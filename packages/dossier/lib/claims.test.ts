/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, expectTypeOf, test } from "vitest"

import { type Claim, ClaimAxis, claimsFor } from "#claims"
import { HOUSE } from "#test/fixtures/example-house"

const observed: Claim<number> = {
	id: "c1",
	subject: HOUSE,
	axis: ClaimAxis.Premises,
	predicate: "storeys",
	value: 13,
	status: "observed",
	evidence: { source: "permit-2021", observedAt: "2021-05-10" },
}

const inferred: Claim<string> = {
	id: "c2",
	subject: HOUSE,
	axis: ClaimAxis.Network,
	predicate: "nearest_cabinet_connects",
	value: "unknown",
	status: "inferred",
	derivedFrom: ["c1"],
	explanation: "A cabinet within 40 m is an observation of proximity, and connection requires its own record.",
	evidence: { source: "survey-2022" },
}

describe("Claim", () => {
	test("an inferred claim is a different union member from an observed one", () => {
		expectTypeOf<Extract<Claim, { status: "inferred" }>>().not.toEqualTypeOf<Extract<Claim, { status: "observed" }>>()
		expectTypeOf<Extract<Claim, { status: "inferred" }>>().toHaveProperty("explanation")
		expectTypeOf<Extract<Claim, { status: "observed" }>>().not.toHaveProperty("explanation")
	})

	test("claimsFor filters by subject and optionally by axis", () => {
		expect(claimsFor(HOUSE, [observed, inferred]).map((claim) => claim.id)).toEqual(["c1", "c2"])
		expect(claimsFor(HOUSE, [observed, inferred], ClaimAxis.Network).map((claim) => claim.id)).toEqual(["c2"])
	})
})
