/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   PFX1 round-trip + doctrine tests. The doctrine cases are the point, and each pins one property
 *   the arc document earned with a measurement: a coordinate may never travel without its
 *   `radiusP95Km` (M-3's 200× spread between a US band and a GB outward code), the ancestry-only
 *   tier must survive the round trip as ABSENCE rather than `0,0` (M-2b's coordinate-less BT
 *   districts), and a duplicate prefix must throw rather than silently keep one of two counts.
 */

import { describe, expect, it } from "vitest"

import {
	PostcodePrefixIndexResolver,
	serializePostcodePrefixIndex,
	type PostcodePrefixHeader,
	type PostcodePrefixNode,
} from "./postcode-prefix-index.ts"

const header: PostcodePrefixHeader = {
	country: "gb",
	scope: "gb-esw",
	schemaVersion: 1,
	levels: ["outward"],
	source: "Ordnance Survey Code-Point Open",
	sourceMD5s: ["d41d8cd98f00b204e9800998ecf8427e"],
	buildDate: "2026-08-05T00:00:00.000Z",
	tier: "shipped",
	attribution: "Contains OS data © Crown copyright and database right 2026.",
	coverageNote: "England, Scotland and Wales only.",
}

const uk = { placetype: "country", wofID: 85_633_159, name: "United Kingdom" }
const england = { placetype: "macroregion", wofID: 404_227_469, name: "England" }
const northernIreland = { placetype: "macroregion", wofID: 404_227_473, name: "Northern Ireland" }

const nodes: PostcodePrefixNode[] = [
	{ prefix: "SW1A", ancestors: [uk, england], lat: 51.501, lon: -0.1416, radiusP95Km: 1.23, unitCount: 232 },
	{ prefix: "M1", ancestors: [uk, england], lat: 53.4808, lon: -2.2426, radiusP95Km: 2.5, unitCount: 1040 },
	// The ancestry-only tier: ancestors, a count, and NO coordinate.
	{ prefix: "BT9", ancestors: [uk, northernIreland], unitCount: 121 },
	// A prefix whose area straddles a border asserts the country and nothing finer.
	{ prefix: "TD1", ancestors: [uk], lat: 55.6, lon: -2.8, radiusP95Km: 4.75, unitCount: 300 },
]

describe("PFX1 postcode-prefix index", () => {
	it("round-trips nodes, ancestry and header through the binary", () => {
		const resolver = new PostcodePrefixIndexResolver(serializePostcodePrefixIndex(header, nodes))

		expect(resolver.size).toBe(4)
		expect(resolver.country).toBe("gb")
		expect(resolver.header.scope).toBe("gb-esw")
		expect(resolver.header.levels).toEqual(["outward"])
		expect(resolver.header.delta).toBeUndefined()

		const sw1a = resolver.probe("SW1A")!

		expect(sw1a.unitCount).toBe(232)
		expect(sw1a.radiusP95Km).toBeCloseTo(1.23, 4)
		// i16 quantization, ~300 m — the PCB1 grid.
		expect(sw1a.lat).toBeCloseTo(51.501, 2)
		expect(sw1a.lon).toBeCloseTo(-0.1416, 2)
		expect(sw1a.ancestors.map((a) => a.name)).toEqual(["United Kingdom", "England"])
		expect(sw1a.ancestors[0]!.wofID).toBe(85_633_159)
	})

	it("preserves a coordinate-less node as ABSENCE, never as 0,0", () => {
		const resolver = new PostcodePrefixIndexResolver(serializePostcodePrefixIndex(header, nodes))
		const bt9 = resolver.probe("BT9")!

		expect(bt9.lat).toBeUndefined()
		expect(bt9.lon).toBeUndefined()
		expect(bt9.radiusP95Km).toBeUndefined()
		expect(bt9.unitCount).toBe(121)
		expect(bt9.ancestors.map((a) => a.name)).toEqual(["United Kingdom", "Northern Ireland"])
	})

	it("sums unitCount across every node, coordinate-bearing or not", () => {
		const resolver = new PostcodePrefixIndexResolver(serializePostcodePrefixIndex(header, nodes))
		const total = [...resolver.nodes()].reduce((sum, node) => sum + node.unitCount, 0)

		expect(total).toBe(232 + 1040 + 121 + 300)
	})

	it("is neutral on an unknown prefix", () => {
		const resolver = new PostcodePrefixIndexResolver(serializePostcodePrefixIndex(header, nodes))

		expect(resolver.probe("ZZ99")).toBeNull()
	})

	it("refuses a coordinate without its radiusP95Km", () => {
		expect(() =>
			serializePostcodePrefixIndex(header, [{ prefix: "SW1A", ancestors: [uk], lat: 51.5, lon: -0.14, unitCount: 1 }])
		).toThrow(/radiusP95Km/)
	})

	it("refuses a radiusP95Km without a coordinate", () => {
		expect(() =>
			serializePostcodePrefixIndex(header, [{ prefix: "BT9", ancestors: [uk], radiusP95Km: 3.2, unitCount: 1 }])
		).toThrow(/no coordinate/)
	})

	it("refuses half a coordinate", () => {
		expect(() =>
			serializePostcodePrefixIndex(header, [
				{ prefix: "BT9", ancestors: [uk], lat: 54.5, radiusP95Km: 3.2, unitCount: 1 },
			])
		).toThrow(/half a coordinate/)
	})

	it("refuses duplicate prefixes rather than keeping one", () => {
		expect(() =>
			serializePostcodePrefixIndex(header, [
				{ prefix: "M1", ancestors: [uk], unitCount: 10 },
				{ prefix: "M1", ancestors: [uk], unitCount: 20 },
			])
		).toThrow(/duplicate prefix/)
	})

	it("rejects non-PFX1 bytes", () => {
		const bytes = serializePostcodePrefixIndex(header, nodes)

		bytes[0] = 0

		expect(() => new PostcodePrefixIndexResolver(bytes)).toThrow(/bad magic/)
	})
})
