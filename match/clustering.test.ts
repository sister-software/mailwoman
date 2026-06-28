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

describe("cluster average-linkage (A4)", () => {
	// Two dense pairs (1-2, 3-4) joined by an above-threshold bridge (2-3), with a disagreeing
	// below-threshold edge (1-4) crossing it.
	const bridged = [
		{ a: r1, b: r2, weight: 10 },
		{ a: r3, b: r4, weight: 10 },
		{ a: r2, b: r3, weight: 5 }, // the above-threshold bridge
		{ a: r1, b: r4, weight: -5 }, // a disagreeing below-threshold edge across the bridge
	]

	it("single-linkage merges the whole component through the bridge", () => {
		expect(shape(cluster(records, bridged, { threshold: 4 }))).toEqual(["1234"])
	})

	it("average-linkage splits sub-clusters joined only by a weak/disagreeing bridge", () => {
		expect(shape(cluster(records, bridged, { threshold: 4, linkage: "average" }))).toEqual(["12", "34"])
	})

	it("average-linkage keeps a genuinely cohesive component together", () => {
		const triangle = [
			{ a: r1, b: r2, weight: 10 },
			{ a: r2, b: r3, weight: 8 },
			{ a: r1, b: r3, weight: 9 },
		]
		expect(shape(cluster(records, triangle, { threshold: 4, linkage: "average" }))).toEqual(["123", "4"])
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
