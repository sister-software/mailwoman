/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A plus code is a coordinate claim, never a component: the override evicts the token from the slot the parse
 *   gave it and the next span of that tag takes the slot, in both projections.
 */

import type { GeocodeOutcomeLike } from "@mailwoman/api"
import { buildAddressTree, type DecoderToken } from "@mailwoman/core/decoder"
import type { BIOLabel } from "@mailwoman/core/types/component"
import { describe, expect, it } from "vitest"

import { applyPlusCodeOverride } from "#plus-code-override"

function tok(piece: string, start: number, end: number, label: BIOLabel): DecoderToken {
	return { piece, start, end, label, confidence: 0.9 }
}

const RAW = "Simpson's Field, 5G8H+8F5, Douglas, Isle of Man IM2 4RE, Isle of Man"

describe("applyPlusCodeOverride", () => {
	it("evicts the code from the postcode slot and seats the real postcode in both projections", () => {
		const tree = buildAddressTree(RAW, [
			tok("Simpson's Field", 0, 15, "B-venue"),
			tok("5G8H+8F5", 17, 25, "B-postcode"),
			tok("Douglas", 27, 34, "B-locality"),
			tok("Isle of Man", 36, 47, "B-region"),
			tok("IM2 4RE", 48, 55, "B-postcode"),
			tok("Isle of Man", 57, 68, "B-country"),
		])

		const result = {
			components: { venue: "Simpson's Field", postcode: "5G8H+8F5", locality: "Douglas" },
			lat: 54.15,
			lon: -4.48,
			resolution_tier: "admin",
			epistemic_status: "derived",
			uncertainty_m: null,
			locality: "Douglas",
			region: "Isle of Man",
			postcode: "5G8H+8F5",
			house_number: null,
			street: null,
			venue: "Simpson's Field",
			dependent_locality: null,
			unit: null,
		} as GeocodeOutcomeLike

		applyPlusCodeOverride(result, RAW, tree)

		expect(result.postcode).toBe("IM2 4RE")
		expect(result.components.postcode).toBe("IM2 4RE")
		expect(result.venue).toBe("Simpson's Field")
	})
})
