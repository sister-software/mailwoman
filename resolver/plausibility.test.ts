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
import type { CountryBBoxFact } from "@mailwoman/core/resolver"
import { describe, expect, test } from "vitest"

import {
	COUNTRY_BBOX,
	finestResolvedCoordinate,
	isImplausibleResolution,
	outsideExpectedCountry,
} from "./plausibility.ts"

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
		const t = tree([node({ tag: "region", value: "Texas", lat: 31, lon: -100, placeID: "wof:tx" })], "Texas 76013")

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

describe("outsideExpectedCountry — artifact-declared bboxes (survey candidate #2)", () => {
	const fact = (country: string, latMin: number, latMax: number, lonMin: number, lonMax: number): CountryBBoxFact => ({
		country,
		latMin,
		latMax,
		lonMin,
		lonMax,
		source: "test",
	})

	test("no bboxes argument → the code constant, byte-identical (the pre-manifest fallback)", () => {
		// Every constant entry answers identically through the 3-arg legacy call and the explicit-undefined call.
		for (const [cc, b] of Object.entries(COUNTRY_BBOX)) {
			const inside: [number, number] = [(b[0] + b[1]) / 2, (b[2] + b[3]) / 2]
			const outside: [number, number] = [b[1] + 5, b[3] + 5]

			expect(outsideExpectedCountry(cc, inside[0], inside[1])).toBe(false)
			expect(outsideExpectedCountry(cc, inside[0], inside[1], undefined)).toBe(false)
			expect(outsideExpectedCountry(cc, outside[0], outside[1])).toBe(true)
			expect(outsideExpectedCountry(cc, outside[0], outside[1], undefined)).toBe(true)
		}
	})

	test("artifact boxes REPLACE the constant wholesale — an artifact-absent country fails open even when the constant has a box", () => {
		const artifact = new Map([["FR", fact("FR", 41, 51.5, -5.5, 9.8)]])

		// FR present in the artifact: behaves like the constant.
		expect(outsideExpectedCountry("FR", 48.86, 2.35, artifact)).toBe(false)
		expect(outsideExpectedCountry("FR", -6.3, 155.6, artifact)).toBe(true)
		// US absent from the artifact's table → fail-open, even though the constant carries a US box.
		expect(outsideExpectedCountry("US", -6.3, 155.6, artifact)).toBe(false)
		expect(outsideExpectedCountry("US", -6.3, 155.6)).toBe(true)
	})

	test("isImplausibleResolution threads countryBBoxes through to guard B", () => {
		const t = tree([node({ tag: "locality", value: "Ia", lat: -6.3, lon: 155.6, placeID: "wof:ia-png" })])
		const artifact = new Map([["US", fact("US", 18, 72, -180, -66)]])

		expect(isImplausibleResolution(t, { expectedCountry: "US", countryBBoxes: artifact }).reason).toBe(
			"outside-expected-country"
		)

		// An artifact WITHOUT a US box → fail-open, overriding the constant.
		expect(isImplausibleResolution(t, { expectedCountry: "US", countryBBoxes: new Map() }).implausible).toBe(false)
	})
})
