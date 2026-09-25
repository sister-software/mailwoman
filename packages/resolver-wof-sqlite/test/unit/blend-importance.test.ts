import { blendImportance, ENCYCLOPEDIC_BOOST_CAP } from "@mailwoman/resolver-wof-sqlite/place-importance-schema"
import { describe, expect, it } from "vitest"

describe("blendImportance", () => {
	it("answers the referential score when there is no article", () => {
		expect(blendImportance(0.2921, null)).toBe(0.2921)
		expect(blendImportance(0.2921, undefined)).toBe(0.2921)
	})

	it("keeps the encyclopedic value untouched when there is no population evidence", () => {
		expect(blendImportance(0, 0.6677)).toBe(0.6677)
	})

	it("caps an article-floor score below a population-attested rival: Tó PT vs Tô BF", () => {
		const toPT = blendImportance(0.0131, 0.3375)
		const toBF = blendImportance(0.2921, null)

		expect(toPT).toBeCloseTo(0.0131 + ENCYCLOPEDIC_BOOST_CAP, 10)
		expect(toPT).toBeLessThan(toBF)
	})

	it("keeps the ratified Whitby GB flip over the larger Whitby CA", () => {
		const whitbyGB = blendImportance(0.2729, 0.5496)
		const whitbyCA = blendImportance(0.5011, 0.4809)

		expect(whitbyGB).toBeCloseTo(0.2729 + ENCYCLOPEDIC_BOOST_CAP, 10)
		expect(whitbyCA).toBe(0.5011)
		expect(whitbyGB).toBeGreaterThan(whitbyCA)
	})

	it("never lets a weak article demote a population-attested place: Saint-Denis", () => {
		expect(blendImportance(0.4716, 0.1173)).toBe(0.4716)
	})

	it("passes a famous place's encyclopedic value through when it sits inside the cap: Brest FR", () => {
		expect(blendImportance(0.5135, 0.6677)).toBe(0.6677)
	})
})
