/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, expectTypeOf, test } from "vitest"

import { admittedClaims, type Claim, ClaimAxis, claimsFor, derivationOf } from "#claims"
import { HOUSE } from "#test/fixtures/example-house"

const observed: Claim<number> = {
	id: "c1",
	subject: HOUSE,
	axis: ClaimAxis.Premises,
	predicate: "storeys",
	value: 13,
	status: "observed",
	evidence: { source: "permit-2021", observedAt: "2021-05-10", validFrom: null, validTo: null },
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
	evidence: { source: "survey-2022", observedAt: null, validFrom: null, validTo: null },
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

	test("derivationOf lists a derived or inferred claim's parents and no parent for any other claim", () => {
		expect(derivationOf(inferred)).toEqual(["c1"])
		expect(derivationOf(observed)).toEqual([])
	})
})

describe("admittedClaims", () => {
	const base = { subject: HOUSE, axis: ClaimAxis.Engineering, predicate: "riser_route", value: "unknown" }

	// The late record supplies `parent`.
	// `child` infers from it and `grandchild` derives from `child` and `own`, both on the
	// early record, and they are listed before the claims they derive from.
	const grandchild: Claim = {
		...base,
		id: "grandchild",
		status: "derived",
		derivedFrom: ["child", "own"],
		evidence: { source: "early", observedAt: null, validFrom: null, validTo: null },
	}

	const child: Claim = {
		...base,
		id: "child",
		status: "inferred",
		derivedFrom: ["parent"],
		explanation: "A riser shown on the parent's plan may not reach the roof.",
		evidence: { source: "early", observedAt: null, validFrom: null, validTo: null },
	}

	const parent: Claim = {
		...base,
		id: "parent",
		status: "observed",
		evidence: { source: "late", observedAt: null, validFrom: null, validTo: null },
	}

	const own: Claim = {
		...base,
		id: "own",
		status: "designated",
		evidence: { source: "early", observedAt: null, validFrom: null, validTo: null },
	}

	const claims = [grandchild, child, parent, own]

	test("admits every claim, in the supplied order, when every source is admitted", () => {
		expect(admittedClaims(claims, new Set(["early", "late"])).map((claim) => claim.id)).toEqual([
			"grandchild",
			"child",
			"parent",
			"own",
		])
	})

	test("admits a derived or inferred claim only when it admits every claim that claim derives from", () => {
		expect(admittedClaims(claims, new Set(["early"])).map((claim) => claim.id)).toEqual(["own"])
	})

	test("drops a claim whose own source is not admitted", () => {
		expect(admittedClaims(claims, new Set(["late"])).map((claim) => claim.id)).toEqual(["parent"])
	})

	test("drops a claim that derives from an identifier no supplied claim has", () => {
		expect(admittedClaims([child], new Set(["early", "late"]))).toEqual([])
	})
})
