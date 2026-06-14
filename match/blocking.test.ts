/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"
import { type LatLon, block, conjunction, exactKey, geoCellKey } from "./blocking.js"

type Rec = { id: string; coord?: LatLon; canonical?: string; postcode?: string }

const pairIds = (pairs: Array<[Rec, Rec]>) => pairs.map(([a, b]) => [a.id, b.id].sort().join("-")).sort()
const intersects = (a: string[], b: string[]) => a.some((k) => b.includes(k))

describe("geoCellKey", () => {
	const key = geoCellKey<Rec>((r) => r.coord)

	it("produces no key for a missing or non-finite coordinate", () => {
		expect(key({ id: "x" })).toEqual([])
		expect(key({ id: "x", coord: { latitude: NaN, longitude: 0 } })).toEqual([])
	})

	it("co-locates two nearby coordinates", () => {
		const a = key({ id: "a", coord: { latitude: 45.5152, longitude: -122.6784 } })
		const b = key({ id: "b", coord: { latitude: 45.5153, longitude: -122.6785 } })
		expect(intersects(a, b)).toBe(true)
	})

	it("separates two distant coordinates", () => {
		const a = key({ id: "a", coord: { latitude: 45.52, longitude: -122.68 } })
		const c = key({ id: "c", coord: { latitude: 47.6, longitude: -122.33 } })
		expect(intersects(a, c)).toBe(false)
	})

	it("bridges a cell boundary only with neighbour expansion", () => {
		const p1 = { id: "p1", coord: { latitude: 45.51, longitude: -122.5 } }
		const p2 = { id: "p2", coord: { latitude: 45.56, longitude: -122.5 } } // adjacent cell at 0.05°

		const expanded = geoCellKey<Rec>((r) => r.coord, { neighbors: true })
		const single = geoCellKey<Rec>((r) => r.coord, { neighbors: false })

		expect(intersects(expanded(p1), expanded(p2))).toBe(true)
		expect(intersects(single(p1), single(p2))).toBe(false)
	})
})

describe("exactKey", () => {
	it("normalizes the value to a single key", () => {
		expect(exactKey<Rec>((r) => r.canonical)({ id: "a", canonical: "  123 Main  ST " })).toEqual(["123 main st"])
	})

	it("truncates to a leading prefix", () => {
		expect(exactKey<Rec>((r) => r.postcode, { prefix: 3 })({ id: "a", postcode: "97201" })).toEqual(["972"])
	})

	it("produces no key for a missing value", () => {
		expect(exactKey<Rec>((r) => r.canonical)({ id: "a" })).toEqual([])
	})
})

describe("conjunction", () => {
	it("crosses sub-keys so both must agree", () => {
		const key = conjunction(
			geoCellKey<Rec>((r) => r.coord, { neighbors: false }),
			exactKey<Rec>((r) => r.canonical)
		)
		const k = key({ id: "a", coord: { latitude: 45.5, longitude: -122.6 }, canonical: "main" })
		expect(k).toHaveLength(1)
		expect(k[0]).toContain("&main")
	})

	it("is empty when any sub-key is absent", () => {
		const key = conjunction(
			geoCellKey<Rec>((r) => r.coord),
			exactKey<Rec>((r) => r.canonical)
		)
		expect(key({ id: "a", canonical: "main" })).toEqual([]) // no coordinate
	})
})

describe("block", () => {
	it("pairs records that share a spatial cell, not distant ones", () => {
		const records: Rec[] = [
			{ id: "a", coord: { latitude: 45.5152, longitude: -122.6784 } },
			{ id: "b", coord: { latitude: 45.5153, longitude: -122.6785 } },
			{ id: "c", coord: { latitude: 47.6, longitude: -122.33 } },
		]
		expect(
			pairIds(
				block(
					records,
					geoCellKey((r) => r.coord)
				).pairs
			)
		).toEqual(["a-b"])
	})

	it("deduplicates a pair caught by more than one key (union semantics)", () => {
		const records: Rec[] = [
			{ id: "a", coord: { latitude: 45.5, longitude: -122.6 }, canonical: "123 main" },
			{ id: "b", coord: { latitude: 45.5, longitude: -122.6 }, canonical: "123 main" },
		]
		const result = block(records, [geoCellKey((r) => r.coord), exactKey((r) => r.canonical)])
		expect(result.pairs).toHaveLength(1)
	})

	it("unions keys: a pair sharing either geo or canonical is caught once", () => {
		const records: Rec[] = [
			// same canonical, far apart — geo misses, canonical catches
			{ id: "a", coord: { latitude: 45.5, longitude: -122.6 }, canonical: "shared" },
			{ id: "b", coord: { latitude: 19.4, longitude: -99.1 }, canonical: "shared" },
		]
		expect(pairIds(block(records, [geoCellKey((r) => r.coord), exactKey((r) => r.canonical)]).pairs)).toEqual(["a-b"])
	})

	it("reports an oversized block instead of scanning it", () => {
		const records: Rec[] = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, canonical: "same" }))
		const result = block(
			records,
			exactKey((r) => r.canonical),
			{ maxBlockSize: 4 }
		)
		expect(result.pairs).toEqual([])
		expect(result.droppedBlocks).toEqual([{ key: "same", size: 5 }])
	})

	it("emits no self-pairs", () => {
		const records: Rec[] = [{ id: "only", canonical: "x" }]
		expect(
			block(
				records,
				exactKey((r) => r.canonical)
			).pairs
		).toEqual([])
	})
})
