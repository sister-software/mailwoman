/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { assertPublishable, refusalsForPublication } from "@mailwoman/core/layers"
import { describe, expect, it } from "vitest"

/**
 * The `candidate` bundle as its manifest recorded it on 2026-09-26.
 * This fixture preserves that case.
 */
const CANDIDATE = {
	name: "candidate",
	tier: "build-local",
	license: "ODbL-1.0 AND CDLA-Permissive-2.0 AND CC-BY-4.0",
	publishedAs: "bundle candidate",
}

/**
 * The `poi` bundle.
 * Its tier and license permit publication.
 */
const POI = {
	name: "poi",
	tier: "shipped",
	license: "CDLA-Permissive-2.0",
	publishedAs: "bundle poi",
}

describe("refusalsForPublication", () => {
	it("refuses a build-local layer, naming the tier as the field that says so", () => {
		const [refusal, ...rest] = refusalsForPublication([CANDIDATE])

		expect(rest).toHaveLength(0)
		expect(refusal!.field).toBe("tier")
		expect(refusal!.layer).toBe("candidate")
		expect(refusal!.reason).toMatch(/only shipped permits publication/)
	})

	it("admits a layer whose tier and license agree", () => {
		expect(refusalsForPublication([POI])).toEqual([])
	})

	it("refuses a shipped layer whose license carries share-alike, because one field is wrong", () => {
		const [refusal] = refusalsForPublication([{ ...CANDIDATE, tier: "shipped" }])

		expect(refusal!.field).toBe("license")
		expect(refusal!.reason).toMatch(/carries share-alike/)
	})

	it("refuses an identifier with no recorded obligations rather than reading it as unobliged", () => {
		// `Licence Ouverte 2.0` is the free-text spelling 145,193,536 corpus rows carry,
		// where `KNOWN_OBLIGATIONS` keys the SPDX identifier `etalab-2.0`.
		const [refusal] = refusalsForPublication([
			{ name: "fr", tier: "shipped", license: "Licence Ouverte 2.0", publishedAs: "bundle fr" },
		])

		expect(refusal!.field).toBe("license")
		expect(refusal!.reason).toMatch(/unknown obligations rather than none/)
	})

	it("reports every layer rather than stopping at the first", () => {
		const refusals = refusalsForPublication([CANDIDATE, POI, { ...CANDIDATE, name: "admin" }])

		expect(refusals.map((refusal) => refusal.layer)).toEqual(["candidate", "admin"])
	})
})

describe("assertPublishable", () => {
	it("throws naming each refusal", () => {
		expect(() => assertPublishable([CANDIDATE])).toThrow(/1 layer\(s\) may not be published/)
		expect(() => assertPublishable([CANDIDATE])).toThrow(/bundle candidate \(layer candidate, tier\)/)
	})

	it("returns for a set every member of which may be published", () => {
		expect(() => assertPublishable([POI])).not.toThrow()
	})
})
