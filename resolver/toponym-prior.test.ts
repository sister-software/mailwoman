/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #17 bare city-name disambiguation. Two ranking keys for the bare-toponym class, both SOFT priors:
 *   `rankByEncyclopedic` (the ROAD_TO_V9 §2 two-score split's dangling `encyclopedic` signal, consumed
 *   at last) and `rankByCountryPrior` (a locale country demoted from hard filter to additive bonus).
 *
 *   The measurement these pin (2026-08-10, shipped `candidate.db`): the panel's bare GB rows resolve to
 *   a more-POPULOUS foreign namesake — Whitby CA 128,377 over Whitby GB 13,130 — while the importance
 *   artifact ranks them the other way (GB 0.5496 over CA 0.5089). Population cannot separate them;
 *   encyclopedic can. The country prior covers the other half: bare `Zürich` under an en-US locale is
 *   hard-scoped to US and lands on Zurich, Kansas (pop 81) 8,043 km off.
 */

import type { ResolvedPlace } from "@mailwoman/core/resolver"
import { describe, expect, it } from "vitest"

import { DEFAULT_COUNTRY_PRIOR_WEIGHT, rankByCountryPrior, rankByEncyclopedic } from "./toponym-prior.ts"

const place = (over: Partial<ResolvedPlace> & Pick<ResolvedPlace, "id" | "name" | "country">): ResolvedPlace => ({
	placetype: "locality",
	lat: 0,
	lon: 0,
	score: 0,
	exactMatch: true,
	...over,
})

/**
 * The live rows behind the panel failures, measured off the shipped artifacts on 2026-08-10: `prominence` from
 * `candidate.db` (`-neg_rank`, i.e. log10(population + 1)), `encyclopedic` from `admin-global-priority-importance.db`.
 */
const WHITBY: ResolvedPlace[] = [
	place({ id: 8_143_502_164_401, name: "Whitby", country: "CA", prominence: 5.1085, encyclopedic: 0.5089 }),
	place({ id: 101_874_191, name: "Whitby", country: "GB", prominence: 4.1183, encyclopedic: 0.5496 }),
	place({ id: 9_000_000_663_998, name: "Whitby", country: "TC", prominence: 2.7505, encyclopedic: 0.1 }),
]

const WINDSOR: ResolvedPlace[] = [
	place({ id: 1, name: "Windsor", country: "CA", prominence: 5.3368, encyclopedic: 0.5607 }),
	place({ id: 2, name: "Windsor", country: "US", prominence: 4.5809, encyclopedic: 0.4638 }),
	place({ id: 3, name: "Windsor", country: "GB", prominence: 4.4295, encyclopedic: 0.5648 }),
]

describe("rankByEncyclopedic", () => {
	it("prefers the encyclopedically prominent namesake over the more POPULOUS one", () => {
		// Whitby, North Yorkshire (13,130) over Whitby, Ontario (128,377) — the population key ranks
		// these backwards, which is the whole #17 failure.
		const ranked = rankByEncyclopedic(WHITBY)
		expect(ranked.map((c) => c.country)).toEqual(["GB", "CA", "TC"])
	})

	it("separates a near-tie the population key gets wrong (Windsor: 0.5648 GB vs 0.5607 CA)", () => {
		expect(rankByEncyclopedic(WINDSOR).map((c) => c.country)).toEqual(["GB", "CA", "US"])
	})

	it("ABSTAINS when only ONE candidate carries a measured score (positive evidence only)", () => {
		// A missing encyclopedic means "no Wikipedia article" OR "pre-split gazetteer" OR "the id didn't
		// join" — never 0. The meaning-of-zero rule: a magnitude never carries its own absence, so a lone
		// measured 0.55 must not be read as beating an unmeasured megacity.
		const partial = [
			place({ id: 1, name: "Whitby", country: "CA", prominence: 5.1085 }),
			place({ id: 2, name: "Whitby", country: "GB", prominence: 4.1183, encyclopedic: 0.5496 }),
		]

		expect(rankByEncyclopedic(partial).map((c) => c.country)).toEqual(["CA", "GB"])
	})

	it("leaves UNSCORED candidates on their population rank and permutes only the scored slots", () => {
		// The live shape: `Whitby` has 7 candidates in candidate.db and the importance artifact scores 2
		// of them. Abstaining on that throws the only usable signal away; zero-filling would let a scored
		// hamlet leapfrog an unscored metropolis. Neither — the unscored rows simply sit still.
		const live = [
			place({ id: 1, name: "Whitby", country: "CA", prominence: 5.1085, encyclopedic: 0.5089 }),
			place({ id: 2, name: "Whitby", country: "GB", prominence: 4.1183, encyclopedic: 0.5496 }),
			place({ id: 3, name: "Whitby", country: "TC", prominence: 2.7505 }),
			place({ id: 4, name: "Whitby", country: "US", prominence: 0 }),
		]

		expect(rankByEncyclopedic(live).map((c) => c.country)).toEqual(["GB", "CA", "TC", "US"])
	})

	it("never lets a scored small place jump an UNSCORED larger one", () => {
		// The failure mode the abstention exists to prevent, stated as a test: the unscored leader holds
		// slot 0 no matter what the scored rows below it measure.
		const rows = [
			place({ id: 1, name: "X", country: "A", prominence: 7 }),
			place({ id: 2, name: "X", country: "B", prominence: 3, encyclopedic: 0.1 }),
			place({ id: 3, name: "X", country: "C", prominence: 2, encyclopedic: 0.9 }),
		]

		expect(rankByEncyclopedic(rows).map((c) => c.country)).toEqual(["A", "C", "B"])
	})

	it("is byte-stable on today's shipped artifacts (candidate.db carries no place_importance)", () => {
		const none = [
			place({ id: 1, name: "Berlin", country: "DE", prominence: 6.5646 }),
			place({ id: 2, name: "Berlin", country: "US", prominence: 4.2981 }),
		]

		expect(rankByEncyclopedic(none)).toEqual(none)
	})

	it("never crosses the exact/partial boundary", () => {
		// Tier is the PRIMARY key everywhere in this resolver; a soft prior re-orders WITHIN a tier only.
		const mixed = [
			place({ id: 1, name: "Whitby", country: "CA", encyclopedic: 0.2, exactMatch: true }),
			place({ id: 2, name: "Whitby Bay", country: "GB", encyclopedic: 0.9, exactMatch: false }),
			place({ id: 3, name: "Whitby", country: "GB", encyclopedic: 0.55, exactMatch: true }),
		]

		expect(rankByEncyclopedic(mixed).map((c) => c.id)).toEqual([3, 1, 2])
	})

	it("breaks an encyclopedic tie on prominence, then leaves the input order", () => {
		const tied = [
			place({ id: 1, name: "X", country: "A", prominence: 3, encyclopedic: 0.5 }),
			place({ id: 2, name: "X", country: "B", prominence: 4, encyclopedic: 0.5 }),
		]

		expect(rankByEncyclopedic(tied).map((c) => c.id)).toEqual([2, 1])
	})
})

describe("rankByCountryPrior", () => {
	it("lets a far more prominent foreign namesake outrank the locale country (Zürich)", () => {
		// Zurich, Kansas (pop 81, prominence 1.91) cannot clear Zürich CH (443,037) with a +2 bonus.
		const zurich = [
			place({ id: 1, name: "Zürich", country: "CH", prominence: 5.6464 }),
			place({ id: 2, name: "Zurich", country: "US", prominence: 1.9138 }),
		]

		expect(rankByCountryPrior(zurich, "US").map((c) => c.country)).toEqual(["CH", "US"])
	})

	it("keeps the in-country answer when the contest is close (Manchester under en-US)", () => {
		// Manchester NH 5.06 + 2 = 7.06 beats Manchester GB 5.74. A soft prior, not a global coin-flip:
		// the locale still decides everything it plausibly can.
		const manchester = [
			place({ id: 1, name: "Manchester", country: "GB", prominence: 5.74 }),
			place({ id: 2, name: "Manchester", country: "US", prominence: 5.06 }),
		]

		expect(rankByCountryPrior(manchester, "US").map((c) => c.country)).toEqual(["US", "GB"])
	})

	it("is a no-op without a country (byte-stable)", () => {
		const rows = [
			place({ id: 1, name: "Whitby", country: "CA", prominence: 5.1 }),
			place({ id: 2, name: "Whitby", country: "GB", prominence: 4.1 }),
		]

		expect(rankByCountryPrior(rows, undefined)).toEqual(rows)
	})

	it("falls back to `score` when the backend reports no prominence", () => {
		const rows = [
			place({ id: 1, name: "X", country: "FR", score: 9 }),
			place({ id: 2, name: "X", country: "US", score: 8 }),
		]

		expect(rankByCountryPrior(rows, "US", 2).map((c) => c.id)).toEqual([2, 1])
	})

	it("never crosses the exact/partial boundary", () => {
		const mixed = [
			place({ id: 1, name: "X", country: "FR", prominence: 3, exactMatch: true }),
			place({ id: 2, name: "X", country: "US", prominence: 9, exactMatch: false }),
		]

		expect(rankByCountryPrior(mixed, "US").map((c) => c.id)).toEqual([1, 2])
	})

	it("weights in log10-population units, matching the resolver's anchorWeight default", () => {
		expect(DEFAULT_COUNTRY_PRIOR_WEIGHT).toBe(2)
	})
})
