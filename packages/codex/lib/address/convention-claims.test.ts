/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Claim arity, pairwise reordering, and the layout reading of the streetless and script-order claims.
 */

import { describe, expect, it } from "vitest"

import {
	CLAIM_ARITY,
	ClaimArity,
	ConventionClaimID,
	ObservationStance,
	reorderedPairs,
	stanceFromLayout,
} from "#address/convention-claims"
import { conventionClaimForCountry, layoutForCountry } from "#address/layouts"

describe("reorderedPairs", () => {
	it("reports a moved component without requiring a full reversal", () => {
		expect(reorderedPairs(["street", "house_number", "locality"], ["house_number", "street", "locality"])).toEqual([
			["street", "house_number"],
		])

		expect(
			reorderedPairs(["region", "locality", "street", "house_number"], ["house_number", "street", "locality", "region"])
		).toHaveLength(6)

		expect(reorderedPairs(["street", "locality"], ["street", "postcode", "locality"])).toEqual([])
	})
})

describe("CLAIM_ARITY", () => {
	it("marks the script-order claim relational and every other claim unary", () => {
		const relational = Object.values(ConventionClaimID).filter((id) => CLAIM_ARITY[id] === ClaimArity.Relational)

		expect(relational).toEqual([ConventionClaimID.OrderingReversesWithScript])
	})
})

describe("stanceFromLayout", () => {
	const layout = layoutForCountry("US")!

	it("reads streetless premise identity only from a numbered layout without a street slot", () => {
		const claim = ConventionClaimID.StreetlessPremiseIdentity

		expect(stanceFromLayout(claim, layout, ["house_number", "dependent_locality", "locality"])).toBe(
			ObservationStance.Supports
		)

		// A street slot can be left empty, so a street-bearing layout is no evidence against the claim.
		expect(stanceFromLayout(claim, layout, ["house_number", "street", "locality"])).toBe(ObservationStance.Silent)
		// A layout printing only a locality and a region describes a locality and falls outside the claim.
		expect(stanceFromLayout(claim, layout, ["locality", "region"])).toBe(ObservationStance.Silent)
	})
})

describe("ordering-reverses-with-script", () => {
	const libaddressinput = (code: string): string[] =>
		conventionClaimForCountry(ConventionClaimID.OrderingReversesWithScript, code)!
			.observations.filter(
				(entry) => entry.stance !== ObservationStance.Silent && entry.stance !== ObservationStance.Unread
			)
			.map((entry) => entry.stance)

	it("supports the claim where the native and Latin layouts order a shared pair differently", () => {
		expect(libaddressinput("CN")).toEqual([ObservationStance.Supports])
		expect(libaddressinput("JP")).toEqual([ObservationStance.Supports])
	})

	it("states nothing for a jurisdiction with one layout", () => {
		expect(libaddressinput("US")).toEqual([])
	})
})
