/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the fragment board's interval math and fixture contract (#727 stage-2, Tier 1c).
 *
 *   The interval is the whole reason this board exists — it is what turns "3/15" into "somewhere
 *   between 4% and 48%, so stop quoting it". If the math is wrong the board is worse than no board,
 *   because it launders an anecdote into a decimal.
 */

import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { FRAGMENT_BOARD_FIXTURES, type FragmentFixture, wilson } from "./fragment-board.ts"

const fixtures = readFileSync(FRAGMENT_BOARD_FIXTURES, "utf8")
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line) as FragmentFixture)

describe("wilson", () => {
	it("brackets the point estimate", () => {
		const ci = wilson(154, 267)

		expect(ci.low).toBeLessThan(154 / 267)
		expect(ci.high).toBeGreaterThan(154 / 267)
	})

	it("matches a hand-computed value — 3/15 is the Paris cell that motivated this board", () => {
		// Standard Wilson, z=1.96, computed independently:
		//   p=0.2, denom=1+3.8416/15=1.25611, centre=0.32805, spread=1.96*sqrt(0.010667+0.004268)=0.23953
		//   => [(0.32805-0.23953)/1.25611, (0.32805+0.23953)/1.25611] = [0.070474, 0.451859]
		// i.e. "3/15" means "somewhere between 7% and 45%". That is not a measurement, and the whole
		// point of this board is to stop anyone quoting it as one.
		const ci = wilson(3, 15)

		expect(ci.low).toBeCloseTo(0.070474, 5)
		expect(ci.high).toBeCloseTo(0.451859, 5)
	})

	it("stays inside [0,1] at the extremes, where the normal approximation breaks", () => {
		// 0/400: the normal approximation gives a NEGATIVE lower bound and zero width.
		const zero = wilson(0, 400)

		expect(zero.low).toBe(0)
		expect(zero.high).toBeGreaterThan(0)
		expect(zero.high).toBeLessThan(0.02)

		const all = wilson(400, 400)

		expect(all.high).toBe(1)
		expect(all.low).toBeLessThan(1)
		expect(all.low).toBeGreaterThan(0.98)
	})

	it("narrows as n grows at a fixed rate", () => {
		const small = wilson(30, 60)
		const large = wilson(300, 600)

		expect(large.high - large.low).toBeLessThan(small.high - small.low)
	})

	it("returns a degenerate interval on an empty cell rather than dividing by zero", () => {
		expect(wilson(0, 0)).toEqual({ low: 0, high: 0 })
	})
})

describe("the FR fragment board fixture", () => {
	it("carries every phenomenon class the review named", () => {
		const classes = new Set(fixtures.map((f) => f.klass))

		expect(classes).toContain("bare-street")
		expect(classes).toContain("street-particle")
		expect(classes).toContain("street-housenumber")
		expect(classes).toContain("alnum-housenumber")
		expect(classes).toContain("date-name")
		expect(classes).toContain("admin-street-homonym")
	})

	it("carries the NEGATIVE class — the one every other street harness drops", () => {
		const negative = fixtures.filter((f) => f.expect_no_street)

		expect(negative.length).toBeGreaterThan(100)
		// A negative row must NOT carry a street gold, or the positive scorer would pick it up.
		for (const row of negative) {
			expect(row.expect.street, `${row.id} is negative but carries a street gold`).toBeUndefined()
		}
	})

	it("gives every cell enough n to say something", () => {
		const counts = new Map<string, number>()

		for (const f of fixtures) counts.set(f.klass, (counts.get(f.klass) ?? 0) + 1)

		for (const [klass, n] of counts) {
			// The bar: a 50% cell must resolve to better than ±5pp.
			const width = wilson(Math.round(n / 2), n).high - wilson(Math.round(n / 2), n).low

			expect(
				width,
				`class ${klass} (n=${n}) has a ±${((width / 2) * 100).toFixed(1)}pp interval at p=0.5`
			).toBeLessThan(0.1)
		}
	})

	it("applies the label policy — the street gold is the FULL phrase, affix included", () => {
		const bare = fixtures.filter((f) => f.klass === "bare-street")

		for (const row of bare.slice(0, 50)) {
			// Input IS the street on this class, so gold must equal the input verbatim.
			expect(row.expect.street!.join(" ")).toBe(row.input)
		}

		const particle = fixtures.filter((f) => f.klass === "street-particle")

		// The particle must live INSIDE the street span, never be split out.
		for (const row of particle.slice(0, 50)) {
			expect(row.expect.street!.join(" ")).toBe(row.input)
		}
	})

	it("splits the house number off the street on the numbered classes", () => {
		for (const row of fixtures.filter((f) => f.klass === "street-housenumber").slice(0, 30)) {
			expect(row.expect.house_number).toBeDefined()
			expect(row.input).toBe(`${row.expect.house_number!.join(" ")} ${row.expect.street!.join(" ")}`)
		}

		for (const row of fixtures.filter((f) => f.klass === "alnum-housenumber").slice(0, 30)) {
			expect(row.expect.house_number).toBeDefined()
			expect(row.input).toBe(`${row.expect.house_number!.join(" ")} ${row.expect.street!.join(" ")}`)
		}
	})

	it("reserves every street surface it uses, so a shard can exclude them", () => {
		const reserved = new Set(
			readFileSync("mailwoman/eval-harness/fixtures/ban-fragments-fr.surfaces.txt", "utf8")
				.split("\n")
				.filter((line) => line && !line.startsWith("#"))
		)

		for (const row of fixtures) {
			if (!row.surface) continue

			expect(reserved.has(row.surface), `surface "${row.surface}" is on the board but not reserved`).toBe(true)
		}
	})

	it("never repeats a street surface across classes", () => {
		// A surface appearing in two classes would correlate the cells and break the intervals.
		const surfaces = fixtures.map((f) => f.surface).filter(Boolean)

		expect(new Set(surfaces).size).toBe(surfaces.length)
	})
})
