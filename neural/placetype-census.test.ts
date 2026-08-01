/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   PCN1 round-trip + doctrine tests. The doctrine cases are the point: `probe` on an unknown parent
 *   must be neutral (null), `share`/`lift` must never manufacture evidence out of a missing
 *   denominator, and the serializer must refuse duplicate parents rather than silently keeping one.
 */

import { describe, expect, it } from "vitest"

import {
	PlacetypeCensusResolver,
	serializePlacetypeCensus,
	type PlacetypeCensusHeader,
	type PlacetypeCensusNode,
} from "./placetype-census.ts"

const header: PlacetypeCensusHeader = {
	country: "gb",
	schemaVersion: 1,
	foldVersion: 1,
	sourceMD5s: ["d41d8cd98f00b204e9800998ecf8427e"],
	buildDate: "2026-08-01T00:00:00.000Z",
	baseRates: { locality: 0.9, dependent_locality: 0.1 },
}

const nodes: PlacetypeCensusNode[] = [
	{ parent: "london", counts: { dependent_locality: 675, locality: 25 }, total: 700 },
	{ parent: "manchester", counts: { dependent_locality: 134, locality: 66 }, total: 200 },
	{ parent: "st helens", counts: { dependent_locality: 3 }, total: 3 },
]

describe("PCN1 placetype census", () => {
	it("round-trips nodes, counts and header through the binary", () => {
		const resolver = new PlacetypeCensusResolver(serializePlacetypeCensus(header, nodes))

		expect(resolver.size).toBe(3)
		expect(resolver.header.country).toBe("gb")
		expect(resolver.header.baseRates.dependent_locality).toBe(0.1)

		expect(resolver.probe("london")).toEqual({
			parent: "london",
			counts: { dependent_locality: 675, locality: 25 },
			total: 700,
		})
	})

	it("computes share and lift against the header's base rates", () => {
		const resolver = new PlacetypeCensusResolver(serializePlacetypeCensus(header, nodes))

		expect(resolver.share("manchester", "dependent_locality")).toBeCloseTo(0.67, 2)
		// 0.67 share against a 0.1 country base rate.
		expect(resolver.lift("manchester", "dependent_locality")).toBeCloseTo(6.7, 1)
	})

	it("treats an unknown parent as NEUTRAL, never as a prohibition", () => {
		const resolver = new PlacetypeCensusResolver(serializePlacetypeCensus(header, nodes))

		expect(resolver.probe("narnia")).toBeNull()
		expect(resolver.share("narnia", "dependent_locality")).toBe(0)
		expect(resolver.lift("narnia", "dependent_locality")).toBe(0)
	})

	it("returns 0 lift — not Infinity — when the base rate is missing", () => {
		const noRates = serializePlacetypeCensus({ ...header, baseRates: {} }, nodes)
		const resolver = new PlacetypeCensusResolver(noRates)

		expect(resolver.share("london", "dependent_locality")).toBeCloseTo(0.964, 3)
		expect(resolver.lift("london", "dependent_locality")).toBe(0)
	})

	it("refuses duplicate parents rather than silently dropping counts", () => {
		expect(() =>
			serializePlacetypeCensus(header, [...nodes, { parent: "london", counts: { locality: 1 }, total: 1 }])
		).toThrow(/duplicate parent "london"/)
	})

	it("drops zero and negative counts at serialize time", () => {
		const resolver = new PlacetypeCensusResolver(
			serializePlacetypeCensus(header, [{ parent: "ghost", counts: { dependent_locality: 0, venue: 4 }, total: 4 }])
		)

		expect(resolver.probe("ghost")).toEqual({ parent: "ghost", counts: { venue: 4 }, total: 4 })
	})

	it("rejects bytes that are not a PCN1 artifact", () => {
		expect(() => new PlacetypeCensusResolver(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/bad magic/)
	})

	it("preserves non-ASCII parent surfaces byte-for-byte", () => {
		const resolver = new PlacetypeCensusResolver(
			serializePlacetypeCensus(header, [{ parent: "münchen", counts: { dependent_locality: 25 }, total: 25 }])
		)

		expect(resolver.probe("münchen")?.counts.dependent_locality).toBe(25)
	})
})
