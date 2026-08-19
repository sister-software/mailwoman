/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the placetype specificity scale. The load-bearing case is the one that created the file: a
 *   `neighbourhood` must NOT count as covering a `locality`, because reading a surviving child as covering its own
 *   dead parent is what #1746 was.
 */

import { describe, expect, it } from "vitest"

import { isAtLeastAsSpecific, isStrictlyFiner, PLACETYPE_SPECIFICITY, placetypeSpecificity } from "./specificity.ts"

describe("placetypeSpecificity", () => {
	it("orders the admin ladder coarse to fine", () => {
		const ladder = ["country", "macroregion", "region", "county", "localadmin", "locality"]
		const ranks = ladder.map((p) => placetypeSpecificity(p)!)

		expect(ranks).toEqual([...ranks].toSorted((a, b) => a - b))
		expect(new Set(ranks).size).toBeGreaterThan(1)
	})

	it("ranks a neighbourhood FINER than the locality that contains it — the #1746 case", () => {
		expect(placetypeSpecificity("neighbourhood")!).toBeGreaterThan(placetypeSpecificity("locality")!)
	})

	it("returns undefined for an unranked placetype rather than defaulting it to coarse", () => {
		expect(placetypeSpecificity("bookstore")).toBeUndefined()
		expect(placetypeSpecificity(null)).toBeUndefined()
		expect(placetypeSpecificity(undefined)).toBeUndefined()
		expect(placetypeSpecificity("")).toBeUndefined()
	})
})

describe("isAtLeastAsSpecific", () => {
	it("says a neighbourhood does not cover a locality — the refusal #1746 turned on", () => {
		expect(isAtLeastAsSpecific("neighbourhood", "locality")).toBe(true)
		expect(isAtLeastAsSpecific("locality", "neighbourhood")).toBe(false)
	})

	it("treats an equal rung as covering, including the deliberate localadmin/borough tie", () => {
		expect(isAtLeastAsSpecific("locality", "locality")).toBe(true)
		expect(isAtLeastAsSpecific("borough", "localadmin")).toBe(true)
		expect(isAtLeastAsSpecific("localadmin", "borough")).toBe(true)
	})

	it("says a region does not cover a locality", () => {
		expect(isAtLeastAsSpecific("region", "locality")).toBe(false)
		expect(isAtLeastAsSpecific("country", "locality")).toBe(false)
	})

	it("returns undefined when either side is unranked, so a caller cannot silently get a boolean", () => {
		expect(isAtLeastAsSpecific("bookstore", "locality")).toBeUndefined()
		expect(isAtLeastAsSpecific("locality", "bookstore")).toBeUndefined()
	})
})

describe("isStrictlyFiner", () => {
	it("separates a child rung from the SAME rung — the distinction a negated isAtLeastAsSpecific loses", () => {
		expect(isStrictlyFiner("neighbourhood", "locality")).toBe(true)
		// The equal case is the one that matters: a live locality covers a dead locality, so it is NOT strictly finer.
		expect(isStrictlyFiner("locality", "locality")).toBe(false)
		expect(isStrictlyFiner("region", "locality")).toBe(false)
	})

	it("gates differently from a negated isAtLeastAsSpecific at the EQUAL rung — the 955-row conflation", () => {
		// The currency backfill blocks a resurrection when a live row covers the dead one. Written the wrong way round
		// it reads "block when the live row is strictly COARSER", which stops a live locality from blocking a dead
		// locality of the same name. Measured on the real artifact that took blocked rows 973 → 18.
		const wrong = (live: string, dead: string) => isAtLeastAsSpecific(live, dead) !== true
		const right = (live: string, dead: string) => isStrictlyFiner(live, dead) !== true

		// The equal rung is where they diverge, and where the damage was.
		expect(wrong("locality", "locality")).toBe(false)
		expect(right("locality", "locality")).toBe(true)

		// They agree everywhere else, which is why the bug survived a read.
		for (const [live, dead] of [
			["neighbourhood", "locality"],
			["region", "locality"],
			["country", "locality"],
		] as const) {
			expect(wrong(live, dead), `${live} vs ${dead}`).toBe(right(live, dead))
		}
	})

	it("returns undefined for an unranked placetype so a gate can choose to block on it", () => {
		expect(isStrictlyFiner("bookstore", "locality")).toBeUndefined()
	})
})

describe("the table", () => {
	it("carries no duplicate rank except the rungs documented as deliberate ties", () => {
		const byRank = new Map<number, string[]>()

		for (const [placetype, rank] of Object.entries(PLACETYPE_SPECIFICITY)) {
			byRank.set(rank!, [...(byRank.get(rank!) ?? []), placetype])
		}

		const ties = [...byRank.values()].filter((names) => names.length > 1).map((names) => names.toSorted().join("+"))

		expect(ties.toSorted()).toEqual([
			"borough+localadmin",
			"building+campus+venue",
			"country+dependency",
			"county+macrocounty",
		])
	})
})
