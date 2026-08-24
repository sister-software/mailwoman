/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The bounded legacy-importance blend: the cap keeps an article-floor score under a population-attested rival,
 *   the floor keeps a weak article from demoting a population-attested place, and a place with no population evidence
 *   keeps its encyclopedic value untouched. The named cases carry the measured values that bracket the cap constant.
 */

import { blendImportance, ENCYCLOPEDIC_BOOST_CAP } from "@mailwoman/resolver-wof-sqlite/place-importance-schema"
import { describe, expect, it } from "vitest"

describe("blendImportance", () => {
	it("answers the referential score when there is no article", () => {
		expect(blendImportance(0.2921, null)).toBe(0.2921)
		expect(blendImportance(0.2921, undefined)).toBe(0.2921)
	})

	it("keeps the encyclopedic value untouched when there is no population evidence", () => {
		// referential 0 means "unmeasured", not "tiny" — there is nothing to bound the article against.
		expect(blendImportance(0, 0.6677)).toBe(0.6677)
	})

	it("caps an article-floor score below a population-attested rival: Tó PT vs Tô BF", () => {
		// Tó PT: pop 136, its article scores 0.3375. Tô BF: pop 16,026, no article, blend 0.2921.
		const toPT = blendImportance(0.0131, 0.3375)
		const toBF = blendImportance(0.2921, null)

		expect(toPT).toBeCloseTo(0.0131 + ENCYCLOPEDIC_BOOST_CAP, 10)
		expect(toPT).toBeLessThan(toBF)
	})

	it("keeps the ratified Whitby GB flip over the larger Whitby CA", () => {
		// Whitby GB: pop 13,130, encyclopedic 0.5496. Whitby CA: pop 128,377, encyclopedic 0.4809.
		const whitbyGB = blendImportance(0.2729, 0.5496)
		const whitbyCA = blendImportance(0.5011, 0.4809)

		expect(whitbyGB).toBeCloseTo(0.2729 + ENCYCLOPEDIC_BOOST_CAP, 10)
		expect(whitbyCA).toBe(0.5011)
		expect(whitbyGB).toBeGreaterThan(whitbyCA)
	})

	it("never lets a weak article demote a population-attested place: Saint-Denis", () => {
		// The Seine-Saint-Denis suburb: pop 96,128 (referential 0.4716), article 0.1173. Under the old
		// COALESCE the article REPLACED the referential score and a 418-person hamlet outranked it.
		expect(blendImportance(0.4716, 0.1173)).toBe(0.4716)
	})

	it("passes a famous place's encyclopedic value through when it sits inside the cap: Brest FR", () => {
		// Brest FR: pop 144,899 (referential 0.5135), encyclopedic 0.6677 — within referential + cap.
		expect(blendImportance(0.5135, 0.6677)).toBe(0.6677)
	})
})
