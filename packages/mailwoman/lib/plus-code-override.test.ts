// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file A plus code is a coordinate claim, never a component: the override evicts the token from the slot the parse
 *   gave it and the next span of that tag takes the slot, in both projections.
 */

import type { BIOLabel } from "@mailwoman/codex/component"
import { buildAddressTree, type DecoderToken } from "@mailwoman/core/decoder"
import type { GeocodeResult } from "@mailwoman/core/geocode"
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
		} as GeocodeResult

		applyPlusCodeOverride(result, RAW, tree)

		expect(result.postcode).toBe("IM2 4RE")
		expect(result.components.postcode).toBe("IM2 4RE")
		expect(result.venue).toBe("Simpson's Field")
	})

	it("clears the register row's stamp once the plus code replaces its coordinate", () => {
		const tree = buildAddressTree(RAW, [
			tok("Simpson's Field", 0, 15, "B-venue"),
			tok("5G8H+8F5", 17, 25, "B-postcode"),
			tok("Douglas", 27, 34, "B-locality"),
		])

		const result = {
			components: { venue: "Simpson's Field", postcode: "5G8H+8F5", locality: "Douglas" },
			lat: 54.15,
			lon: -4.48,
			resolution_tier: "address_point",
			epistemic_status: "observed",
			coordinate_source: { source: "openstreetmap:im", release: "2026-08-06" },
			uncertainty_m: 1,
		} as GeocodeResult

		applyPlusCodeOverride(result, RAW, tree)

		expect(result.resolution_tier).toBe("plus_code")
		expect(result.coordinate_source).toBeNull()
	})

	function resultFor(postcode: string): GeocodeResult {
		return {
			components: { postcode, locality: "El Sauce" },
			lat: 12.9,
			lon: -86.5,
			resolution_tier: "admin",
			epistemic_status: "derived",
			uncertainty_m: null,
			locality: "El Sauce",
			postcode,
			coordinate_source: null,
		} as GeocodeResult
	}

	it("decodes a full code beside punctuation, which the specification reads as a code", () => {
		for (const [input, start] of [
			["El Sauce, (764MVFQ6+92P)", 11],
			["El Sauce 764MVFQ6+92P.", 9],
			["El Sauce, 764MVFQ6+92P", 10],
		] as const) {
			const tree = buildAddressTree(input, [
				tok("El Sauce", 0, 8, "B-locality"),
				tok("764MVFQ6+92P", start, start + 12, "B-postcode"),
			])

			const result = resultFor("764MVFQ6+92P")

			applyPlusCodeOverride(result, input, tree)

			expect(result.resolution_tier, input).toBe("plus_code")
			expect(result.lat, input).toBeCloseTo(12.8884, 3)
			expect(result.lon, input).toBeCloseTo(-86.5399, 3)
			expect(result.postcode, input).toBeNull()
		}
	})

	it("removes a token with an odd count of digits before the separator and decodes nothing", () => {
		// The validator rejects 3, 5 and 7 digits with `invalid_prefix_length`; the override still evicts the token.
		for (const code of ["VFQ+92P", "VFQ6M+92", "VFQ6M7X+92"]) {
			const input = `El Sauce, ${code}`

			const tree = buildAddressTree(input, [
				tok("El Sauce", 0, 8, "B-locality"),
				tok(code, 10, 10 + code.length, "B-postcode"),
			])

			const result = resultFor(code)

			applyPlusCodeOverride(result, input, tree)

			expect(result.postcode, code).toBeNull()
			expect(result.resolution_tier, code).toBe("admin")
			expect(result.lat, code).toBe(12.9)
		}
	})

	it("leaves a result alone when the input holds no plus code", () => {
		const input = "El Sauce, 11001"
		const tree = buildAddressTree(input, [tok("El Sauce", 0, 8, "B-locality"), tok("11001", 10, 15, "B-postcode")])
		const result = resultFor("11001")

		applyPlusCodeOverride(result, input, tree)

		expect(result.postcode).toBe("11001")
		expect(result.resolution_tier).toBe("admin")
	})
})
