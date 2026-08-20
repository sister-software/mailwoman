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

	it("treats an equal rung as covering", () => {
		expect(isAtLeastAsSpecific("locality", "locality")).toBe(true)
		expect(isAtLeastAsSpecific("venue", "building")).toBe(true)
		expect(isAtLeastAsSpecific("building", "venue")).toBe(true)
	})

	it("puts a borough BELOW localadmin rather than level with it", () => {
		// This pair was tied on the reasoning that WOF uses both for the same tier in different countries, which is
		// true — an Alaska borough IS county-tier — but a tie is not a neutral answer. It made each cover the other,
		// and one rung up that same tie let a live NYC-shaped borough cover its own dead parent locality. WOF's own
		// containment ladder commits to sub-locality; a scale that has to pick one answer picks that one, and the
		// Alaska reading stays wrong either way.
		expect(isAtLeastAsSpecific("borough", "localadmin")).toBe(true)
		expect(isAtLeastAsSpecific("localadmin", "borough")).toBe(false)
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
		// Two survive, and neither is an admin rung. `building+campus+venue` are three names for a thing at an
		// address, and `country+dependency` is WOF's own sovereignty hedge. The admin ladder itself is now strictly
		// ordered, because a tie there is a silent disagreement with containment — see the agreement suite below.
		const byRank = new Map<number, string[]>()

		for (const [placetype, rank] of Object.entries(PLACETYPE_SPECIFICITY)) {
			byRank.set(rank!, [...(byRank.get(rank!) ?? []), placetype])
		}

		const ties = [...byRank.values()].filter((names) => names.length > 1).map((names) => names.toSorted().join("+"))

		expect(ties.toSorted()).toEqual(["building+campus+venue", "country+dependency"])
	})
})

/**
 * The admin ladder, coarsest first — a copy of `resolver-wof-sqlite/ancestry.ts`'s `PLACETYPE_DEPTH` ORDER, and the
 * only place in `core` allowed to know it.
 *
 * `core` cannot import from `resolver-wof-sqlite` (the dependency runs the other way), so the two tables cannot be
 * derived from one another and this list is what keeps them honest. It records the ORDER only: the scales differ in
 * offset by design, and `PLACETYPE_DEPTH` additionally maps an unranked placetype to 0 where this one answers
 * `undefined`.
 */
const ANCESTRY_DEPTH_ORDER = [
	"country",
	"macroregion",
	"region",
	"macrocounty",
	"county",
	"localadmin",
	"locality",
	"borough",
	"macrohood",
	"neighbourhood",
	"microhood",
] as const

describe("agreement with PLACETYPE_DEPTH", () => {
	it("orders every shared placetype the same way the ancestry table does", () => {
		const ranked = ANCESTRY_DEPTH_ORDER.map((placetype) => ({
			placetype,
			rank: PLACETYPE_SPECIFICITY[placetype],
		}))

		expect(
			ranked.filter((r) => r.rank === undefined).map((r) => r.placetype),
			"a placetype the ancestry ladder ranks and this scale does not"
		).toEqual([])

		// Strictly increasing, because the ladder is coarsest-first and this scale is higher-is-finer. A TIE would be
		// a silent disagreement: `PLACETYPE_DEPTH` separates all eleven, so a tie here reverses no pair but does make
		// `isStrictlyFiner` answer false where containment says true.
		const disagreements = ranked
			.slice(1)
			.map((current, i) => ({ current, previous: ranked[i]! }))
			.filter(({ current, previous }) => (current.rank as number) <= (previous.rank as number))
			.map(({ current, previous }) => `${previous.placetype}(${previous.rank}) → ${current.placetype}(${current.rank})`)

		expect(
			disagreements,
			"These pairs order differently from `PLACETYPE_DEPTH`. A `borough` ranked coarser than its `locality` is " +
				"what let a live child cover its own dead parent in the currency gate; keep the two ladders in step."
		).toEqual([])
	})

	it("places a borough INSIDE its locality — Brooklyn is not coarser than New York City", () => {
		expect(isStrictlyFiner("borough", "locality")).toBe(true)
		expect(isStrictlyFiner("locality", "borough")).toBe(false)
	})

	it("places a macrocounty OUTSIDE its counties", () => {
		expect(isStrictlyFiner("county", "macrocounty")).toBe(true)
		expect(isStrictlyFiner("macrocounty", "county")).toBe(false)
	})
})
