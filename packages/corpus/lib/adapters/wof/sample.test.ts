/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The sampler keeps every cell's floor and fills each country, from two passes over the same rows.
 */

import { describe, expect, it } from "vitest"

import { LowestValues, renderedTagOrder, RowSampler, type SampledRow } from "#adapters/wof/sample"

describe("LowestValues", () => {
	it("keeps the lowest values seen, and lets every value pass until it is full", () => {
		const values = new LowestValues(3)

		expect(values.threshold).toBe(Number.POSITIVE_INFINITY)

		for (const value of [9, 4, 7, 1, 8, 2]) {
			values.add(value)
		}

		expect(values.threshold).toBe(4)
	})

	it("counts a repeated text once, so the threshold covers that many distinct texts", () => {
		const values = new LowestValues(3)

		for (const [value, text] of [
			[1, 10],
			[2, 10],
			[3, 11],
			[4, 12],
			[5, 13],
		] as const) {
			values.add(value, text)
		}

		expect(values.threshold).toBe(4)
	})

	it("passes no value when it holds none", () => {
		expect(new LowestValues(0).threshold).toBe(Number.NEGATIVE_INFINITY)
	})
})

describe("renderedTagOrder", () => {
	it("orders tags by where the text shows them, for smallest-first and largest-first rows", () => {
		expect(
			renderedTagOrder("Brooklyn, New York, USA", { country: "USA", locality: "Brooklyn", region: "New York" })
		).toBe("locality region country")

		expect(renderedTagOrder("日本 東京", { region: "東京", country: "日本" })).toBe("country region")
	})
})

describe("RowSampler", () => {
	const row = (index: number, slotKey: string, components: SampledRow["components"]): SampledRow => ({
		sourceID: `wof-admin-${index}-${slotKey}-self`,
		country: "US",
		slotKey,
		raw: Object.values(components).join(", "),
		components,
	})

	const rows = [
		...Array.from({ length: 2000 }, (_, i) => row(i, "default", { locality: `Place ${i}` })),
		...Array.from({ length: 4 }, (_, i) => row(10_000 + i, "name-fin-x-preferred", { locality: `Paikka ${i}` })),
	]

	it("keeps a rare language cell's rows that a 50-row country fill alone would miss", () => {
		const sampler = new RowSampler({ cellFloor: 3, rowsPerCountry: 50 })

		for (const r of rows) {
			sampler.observe(r)
		}

		const kept = rows.filter((r) => sampler.keeps(r))
		const finnish = kept.filter((r) => r.slotKey === "name-fin-x-preferred")

		expect(finnish.length).toBeGreaterThanOrEqual(3)
		expect(kept.length).toBeLessThanOrEqual(50 + 3 + 3)
		expect(sampler.cellCounts.get("US|locality|default|default")).toBe(2000)
		expect(sampler.cellCounts.get("US|locality|preferred|fin")).toBe(4)
	})

	it("keeps the same rows for the same seed", () => {
		const keptWith = (seed: number) => {
			const sampler = new RowSampler({ cellFloor: 3, rowsPerCountry: 50, seed })

			for (const r of rows) {
				sampler.observe(r)
			}

			return rows.filter((r) => sampler.keeps(r)).map((r) => r.sourceID)
		}

		expect(keptWith(7)).toEqual(keptWith(7))
		expect(keptWith(7)).not.toEqual(keptWith(8))
	})
})
