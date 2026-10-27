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

	it("orders a region named inside its locality's name by the region's own span, as the aligner does", () => {
		const raw = "ہیرسبرک، شمالی کیرولائنا, کاباریس کاؤنٹی، شمالی کیرولینا, شمالی کیرولائنا"

		expect(
			renderedTagOrder(raw, {
				locality: "ہیرسبرک، شمالی کیرولائنا",
				subregion: "کاباریس کاؤنٹی، شمالی کیرولینا",
				region: "شمالی کیرولائنا",
			})
		).toBe("locality subregion region")
	})

	it("returns null for a row whose component the aligner cannot place", () => {
		expect(renderedTagOrder("Brooklyn", { locality: "Brooklyn", region: "New York" })).toBeNull()
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
			sampler.observe(r, r)
		}

		const kept = [...sampler.kept()]
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
				sampler.observe(r, r)
			}

			return [...sampler.kept()].map((r) => r.sourceID)
		}

		expect(keptWith(7)).toEqual(keptWith(7))
		expect(keptWith(7)).not.toEqual(keptWith(8))
	})

	it("emits no row of a held-out cell, and holds at most heldOutPerCell of its rows out instead", () => {
		const sampler = new RowSampler({
			cellFloor: 3,
			rowsPerCountry: 50,
			holdOutCells: ["US|locality|preferred"],
			heldOutPerCell: 2,
		})

		for (const r of rows) {
			sampler.observe(r, r)
		}

		const kept = [...sampler.kept()]
		const heldOut = [...sampler.heldOut()]

		expect(kept.some((r) => r.slotKey === "name-fin-x-preferred")).toBe(false)
		expect(heldOut).toHaveLength(2)
		expect(heldOut.every((r) => r.slotKey === "name-fin-x-preferred")).toBe(true)
		expect(sampler.cellCounts.get("US|locality|preferred|fin")).toBe(4)
	})

	it("holds a whole order out under every name-slot kind when the entry names only country and order", () => {
		const sampler = new RowSampler({ cellFloor: 3, rowsPerCountry: 50, holdOutCells: ["US|locality"] })

		for (const r of rows) {
			sampler.observe(r, r)
		}

		expect([...sampler.kept()]).toHaveLength(0)
		expect([...sampler.heldOut()]).toHaveLength(20)
	})

	it("leaves out a held-out row whose case-folded text matches a kept row", () => {
		const sample = { cellFloor: 3, rowsPerCountry: 50, holdOutCells: ["US|locality|preferred"], heldOutPerCell: 5 }
		const first = new RowSampler(sample)

		for (const r of rows) {
			first.observe(r, r)
		}

		const keptRow = [...first.kept()][0]!
		// A preferred-slot row sharing a kept row's text, under a hash low enough to be held out.
		const twin = { ...keptRow, sourceID: "twin", slotKey: "name-fin-x-preferred", raw: keptRow.raw.toUpperCase() }
		const sampler = new RowSampler(sample)

		for (const r of [...rows, twin]) {
			sampler.observe(r, r)
		}

		const heldOut = [...sampler.heldOut()]

		expect(heldOut.some((r) => r.sourceID === "twin")).toBe(false)
		expect(heldOut).toHaveLength(4)
	})

	it("writes comparison rows from a kept cell that the sample does not emit", () => {
		const sampler = new RowSampler({
			cellFloor: 3,
			rowsPerCountry: 50,
			compareCells: ["US|locality|default"],
			heldOutPerCell: 10,
		})

		for (const r of rows) {
			sampler.observe(r, r)
		}

		const kept = new Set([...sampler.kept()].map((r) => r.sourceID))
		const comparison = [...sampler.comparison()]

		expect(comparison).toHaveLength(10)
		expect(comparison.every((r) => !kept.has(r.sourceID) && r.slotKey === "default")).toBe(true)
	})

	it("keeps in one pass the rows a second pass over the final thresholds would keep, in observed order", () => {
		const sampler = new RowSampler({ cellFloor: 3, rowsPerCountry: 50, seed: 11 })

		for (const r of rows) {
			sampler.observe(r, r)
		}

		const kept = [...sampler.kept()].map((r) => r.sourceID)
		const order = rows.map((r) => r.sourceID)

		expect(kept).toEqual(order.filter((id) => kept.includes(id)))
		expect(kept.length).toBeGreaterThanOrEqual(50)
	})
})
