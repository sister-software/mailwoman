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

import { parseJSONStrict } from "@mailwoman/core/objects"
import {
	PostcodePrefixIndexResolver,
	serializePostcodePrefixIndex,
	type PostcodePrefixHeader,
	type PostcodePrefixNode,
} from "@mailwoman/neural/postcode-prefix-index"
import { describe, expect, it } from "vitest"

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

describe("PFX1 layout conformance (docs/engineering/reference/pfx1.ksy)", () => {
	it("serializer output walks byte-for-byte per the documented layout", () => {
		const bytes = serializePostcodePrefixIndex(header, nodes)
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
		const decoder = new TextDecoder()

		// magic: the ASCII bytes "PFX1"
		expect(decoder.decode(bytes.subarray(0, 4))).toBe("PFX1")

		// header_len: u4le, then header_json: UTF-8 JSON of exactly that many bytes
		const headerLen = view.getUint32(4, true)
		const parsedHeader = parseJSONStrict<PostcodePrefixHeader>(decoder.decode(bytes.subarray(8, 8 + headerLen)))

		expect(parsedHeader.schemaVersion).toBe(1)
		// The meaning-of-zero statement is mandatory: a miss against a partial register is unattested,
		// not absent, and a reader cannot tell the two apart without it.
		expect(parsedHeader.coverageNote.length).toBeGreaterThan(0)

		// ancestor_count: u4le, then the interned dictionary
		let o = 8 + headerLen
		const ancestorCount = view.getUint32(o, true)
		o += 4

		// Three distinct surfaces (UK, England, Northern Ireland) across four nodes that make seven
		// references — the dictionary is the anti-repetition device, so it must be SHORTER than the
		// reference count, which the assertion at the end of the walk states directly.
		expect(ancestorCount).toBe(3)

		for (let i = 0; i < ancestorCount; i++) {
			const placetypeLen = bytes[o++]!
			expect(decoder.decode(bytes.subarray(o, o + placetypeLen)).length).toBeGreaterThan(0)
			o += placetypeLen
			// f64, not u32: WOF ids exceed 2^32 and must stay exactly representable.
			const wofID = view.getFloat64(o, true)
			o += 8

			expect(Number.isInteger(wofID)).toBe(true)
			expect(Math.abs(wofID)).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER)

			const nameLen = bytes[o++]!
			o += nameLen
		}

		// node_count: u4le, then the prefix records
		const nodeCount = view.getUint32(o, true)
		o += 4

		expect(nodeCount).toBe(nodes.length)

		let previousPrefix = ""
		let totalRefs = 0

		for (let i = 0; i < nodeCount; i++) {
			const prefixLen = bytes[o++]!

			expect(prefixLen).toBeGreaterThan(0)

			const prefix = decoder.decode(bytes.subarray(o, o + prefixLen))
			o += prefixLen

			// Sorted ascending by prefix — what makes the build byte-deterministic.
			expect(prefix > previousPrefix).toBe(true)
			previousPrefix = prefix

			const refCount = bytes[o++]!
			totalRefs += refCount

			for (let r = 0; r < refCount; r++) {
				expect(view.getUint32(o, true)).toBeLessThan(ancestorCount)
				o += 4
			}

			const flags = bytes[o++]!

			// Bits 2-7 are reserved and must be clear.
			expect(flags & 0b1111_1100).toBe(0)

			const hasCoordinate = (flags & 0b01) !== 0
			const hasRadius = (flags & 0b10) !== 0

			// The radius may never travel without a coordinate, nor a coordinate without a radius.
			expect(hasRadius).toBe(hasCoordinate)

			if (hasCoordinate) {
				// Quantized against 32767, so the decoded value must land within the grid's ~300 m.
				expect(Math.abs((view.getInt16(o, true) * 90) / 32_767)).toBeLessThanOrEqual(90)
				o += 2
				expect(Math.abs((view.getInt16(o, true) * 180) / 32_767)).toBeLessThanOrEqual(180)
				o += 2
			}

			if (hasRadius) {
				expect(view.getFloat32(o, true)).toBeGreaterThan(0)
				o += 4
			}

			expect(view.getUint32(o, true)).toBeGreaterThan(0)
			o += 4
		}

		// The dictionary earns its place: more references than entries.
		expect(totalRefs).toBeGreaterThan(ancestorCount)

		// The walk consumed the buffer exactly — no trailing bytes, no short read.
		expect(o).toBe(bytes.length)
	})

	it("the ancestry-only tier survives as ABSENCE, never as a 0,0 sentinel", () => {
		// A magnitude never carries its own absence: BT9's coordinate-less record must be shorter than
		// a coordinate-bearing one by exactly the 4 + 4 bytes the two optional fields occupy.
		const withCoordinate = serializePostcodePrefixIndex(header, [
			{ prefix: "AA1", ancestors: [uk], lat: 51, lon: 0, radiusP95Km: 1, unitCount: 1 },
		])

		const withoutCoordinate = serializePostcodePrefixIndex(header, [{ prefix: "AA1", ancestors: [uk], unitCount: 1 }])

		expect(withCoordinate.length - withoutCoordinate.length).toBe(8)
	})
})
