/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the v7 hybrid-gate resolution-plausibility guard (#38). The guard trips only when a
 *   resolved tree's finest place is a bare country centroid — the garbage-geocode archetype the
 *   coordinate-parity study surfaced (`California` / `6000, NSW, Australia` → a country centroid).
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { describe, expect, test } from "vitest"

import { finestResolvedCoordinate, isImplausibleResolution } from "./plausibility.ts"

const node = (over: Partial<AddressNode> & Pick<AddressNode, "tag" | "value">): AddressNode => ({
	start: 0,
	end: over.value.length,
	confidence: 1,
	children: [],
	...over,
})

const tree = (roots: AddressNode[], raw = ""): AddressTree => ({ raw, roots })

describe("finestResolvedCoordinate", () => {
	test("returns the deepest resolved tier when several nodes resolved", () => {
		const t = tree([
			node({
				tag: "locality",
				value: "Paris",
				lat: 48.86,
				lon: 2.35,
				placeID: "wof:101751119",
				children: [node({ tag: "street", value: "Rue de Rivoli", lat: 48.86, lon: 2.34, placeID: "wof:street" })],
			}),
			node({ tag: "country", value: "France", lat: 46.2, lon: 2.2, placeID: "wof:france" }),
		])

		expect(finestResolvedCoordinate(t)?.tag).toBe("street")
	})

	test("returns null when nothing carries a coordinate", () => {
		expect(finestResolvedCoordinate(tree([node({ tag: "street", value: "Nowhere St" })]))).toBeNull()
	})
})

describe("isImplausibleResolution", () => {
	test("country-only resolution is implausible (the garbage archetype)", () => {
		const t = tree(
			[node({ tag: "country", value: "Australia", lat: -25.7, lon: 134.5, placeID: "wof:au" })],
			"6000, NSW, Australia"
		)
		const verdict = isImplausibleResolution(t)

		expect(verdict.implausible).toBe(true)
		expect(verdict.reason).toBe("country-centroid")
		expect(verdict.coordinate?.tag).toBe("country")
	})

	test("a locality resolution alongside a country is plausible", () => {
		const t = tree([
			node({ tag: "locality", value: "Melbourne", lat: -37.8, lon: 144.96, placeID: "wof:melb" }),
			node({ tag: "country", value: "Australia", lat: -25.7, lon: 134.5, placeID: "wof:au" }),
		])

		expect(isImplausibleResolution(t).implausible).toBe(false)
	})

	test("a region-only (US state) resolution is plausible — a legitimate coarse geocode", () => {
		const t = tree([node({ tag: "region", value: "Texas", lat: 31.0, lon: -100.0, placeID: "wof:tx" })], "Texas 76013")

		expect(isImplausibleResolution(t).implausible).toBe(false)
	})

	test("guard B: a coordinate outside the expected country's bbox is implausible (the cross-country jump)", () => {
		// The V1 finding (PR #1147): "1210a IA 10 W IA" resolved ~10,000 km outside the US — locality-tier,
		// so guard A (country-centroid) structurally cannot catch it. Guard B does, given the expected country.
		const t = tree(
			[node({ tag: "locality", value: "Ia", lat: -6.3, lon: 155.6, placeID: "wof:ia-png" })],
			"1210a IA 10 W IA"
		)
		const verdict = isImplausibleResolution(t, { expectedCountry: "US" })

		expect(verdict.implausible).toBe(true)
		expect(verdict.reason).toBe("outside-expected-country")
	})

	test("guard B does NOT trip when the coordinate is inside the expected country", () => {
		const t = tree([node({ tag: "locality", value: "Des Moines", lat: 41.59, lon: -93.62, placeID: "wof:dsm" })])

		expect(isImplausibleResolution(t, { expectedCountry: "US" }).implausible).toBe(false)
	})

	test("guard B is fail-open for a country without a bbox", () => {
		const t = tree([node({ tag: "locality", value: "Reykjavík", lat: 64.15, lon: -21.9 })])

		expect(isImplausibleResolution(t, { expectedCountry: "IS" }).implausible).toBe(false)
	})

	test("guard B never runs without expectedCountry (backward-compatible default)", () => {
		const t = tree([node({ tag: "locality", value: "Ia", lat: -6.3, lon: 155.6 })])

		expect(isImplausibleResolution(t).implausible).toBe(false)
	})

	test("an unresolved tree is not implausible (nothing to serve, not garbage)", () => {
		const verdict = isImplausibleResolution(tree([node({ tag: "street", value: "Epleskogen" })], "Epleskogen 39A"))

		expect(verdict.implausible).toBe(false)
		expect(verdict.coordinate).toBeUndefined()
	})
})
