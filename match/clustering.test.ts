/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"
import { cluster, representative } from "./clustering.js"

const r1 = { id: "1" }
const r2 = { id: "2" }
const r3 = { id: "3" }
const r4 = { id: "4" }
const records = [r1, r2, r3, r4]

const shape = (clusters: { id: string }[][]) =>
	clusters
		.map((g) =>
			g
				.map((r) => r.id)
				.sort()
				.join("")
		)
		.sort()

describe("cluster", () => {
	it("merges a transitive chain into one connected component", () => {
		const clusters = cluster(
			records,
			[
				{ a: r1, b: r2, weight: 5 },
				{ a: r2, b: r3, weight: 5 },
			],
			{ threshold: 1 }
		)
		expect(shape(clusters)).toEqual(["123", "4"])
	})

	it("keeps disjoint links in separate clusters", () => {
		const clusters = cluster(
			records,
			[
				{ a: r1, b: r2, weight: 5 },
				{ a: r3, b: r4, weight: 5 },
			],
			{ threshold: 1 }
		)
		expect(shape(clusters)).toEqual(["12", "34"])
	})

	it("does not link below the threshold (the precision/recall knob)", () => {
		const clusters = cluster(records, [{ a: r1, b: r2, weight: 0.5 }], { threshold: 1 })
		expect(shape(clusters)).toEqual(["1", "2", "3", "4"])
	})

	it("places an unlinked record in its own singleton cluster", () => {
		const clusters = cluster(records, [{ a: r1, b: r2, weight: 5 }], { threshold: 1 })
		expect(shape(clusters)).toEqual(["12", "3", "4"])
	})

	it("ignores a link referencing a record outside the set", () => {
		const stranger = { id: "x" }
		const clusters = cluster(records, [{ a: r1, b: stranger, weight: 5 }], { threshold: 1 })
		expect(shape(clusters)).toEqual(["1", "2", "3", "4"])
	})
})

describe("representative", () => {
	it("picks the most complete record in a cluster", () => {
		const sparse = { id: "a", name: null, phone: "" }
		const full = { id: "a", name: "Bob", phone: "555-0100" }
		expect(representative([sparse, full])).toBe(full)
	})

	it("returns undefined for an empty cluster", () => {
		expect(representative([])).toBeUndefined()
	})
})
