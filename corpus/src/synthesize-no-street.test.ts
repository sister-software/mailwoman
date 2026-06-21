/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the no-street synthesizer. Verifies that every emitted row has NO street-side tags —
 *   this is the contract that makes the rows useful as counter-distribution training data.
 */

import { describe, expect, it } from "vitest"
import {
	hasAnyStreetSideTag,
	type NoStreetBaseTuple,
	type NoStreetTemplate,
	STREET_SIDE_TAGS,
	synthesizeNoStreetRow,
} from "./synthesize-no-street.js"

function seededRandom(seed: number): () => number {
	let s = seed
	return () => {
		s = (s * 1664525 + 1013904223) % 4294967296
		return s / 4294967296
	}
}

const SAMPLE_BASE: NoStreetBaseTuple = {
	locality: "Boston",
	region: "MA",
	postcode: "02101",
	country: "US",
}

describe("synthesizeNoStreetRow", () => {
	it("emits a venue-plain row with no street-side tags", () => {
		const row = synthesizeNoStreetRow(SAMPLE_BASE, {
			random: seededRandom(1),
			forceTemplate: "venue-plain",
		})
		expect(row).not.toBeNull()
		expect(row!.template).toBe("venue-plain")
		expect(row!.components.venue).toBeDefined()
		expect(row!.components.locality).toBe("Boston")
		expect(row!.components.region).toBe("MA")
		expect(row!.components.postcode).toBe("02101")
		expect(hasAnyStreetSideTag(row!.components)).toBe(false)
	})

	it("emits a venue-adversarial row whose venue contains street-typing words", () => {
		const row = synthesizeNoStreetRow(SAMPLE_BASE, {
			random: seededRandom(2),
			forceTemplate: "venue-adversarial",
		})
		expect(row).not.toBeNull()
		expect(row!.template).toBe("venue-adversarial")
		expect(row!.components.venue).toBeDefined()
		expect(hasAnyStreetSideTag(row!.components)).toBe(false)

		// The whole point: adversarial venues contain street-typing tokens that the model
		// must learn to NOT classify as street-side tags.
		const v = row!.components.venue!.toLowerCase()
		const hasStreetWord = [
			"street",
			"avenue",
			"highway",
			"lane",
			"boulevard",
			"drive",
			"road",
			"park",
			"plaza",
			"court",
			"square",
		].some((w) => v.includes(w))
		expect(hasStreetWord).toBe(true)
	})

	it("emits a locality-region-postcode row with only admin tags", () => {
		const row = synthesizeNoStreetRow(SAMPLE_BASE, {
			random: seededRandom(3),
			forceTemplate: "locality-region-postcode",
		})
		expect(row).not.toBeNull()
		expect(row!.raw).toBe("Boston, MA 02101")
		expect(row!.components.locality).toBe("Boston")
		expect(row!.components.region).toBe("MA")
		expect(row!.components.postcode).toBe("02101")
		expect(row!.components.venue).toBeUndefined()
		expect(hasAnyStreetSideTag(row!.components)).toBe(false)
	})

	it("emits a postcode-only row", () => {
		const row = synthesizeNoStreetRow(SAMPLE_BASE, {
			random: seededRandom(4),
			forceTemplate: "postcode-only",
		})
		expect(row).not.toBeNull()
		expect(row!.raw).toBe("02101")
		expect(row!.components).toEqual({ postcode: "02101" })
		expect(hasAnyStreetSideTag(row!.components)).toBe(false)
	})

	it("emits a country-only row", () => {
		const row = synthesizeNoStreetRow(SAMPLE_BASE, {
			random: seededRandom(5),
			forceTemplate: "country-only",
		})
		expect(row).not.toBeNull()
		expect(row!.components.country).toBeDefined()
		// Country surface form is the canonical / colloquial name, not the ISO code.
		expect(row!.components.country!.length).toBeGreaterThan(2)
		expect(hasAnyStreetSideTag(row!.components)).toBe(false)
	})

	it("never emits ANY street-side tag across 500 random invocations", () => {
		const rng = seededRandom(42)
		for (let i = 0; i < 500; i++) {
			const row = synthesizeNoStreetRow(SAMPLE_BASE, { random: rng })
			expect(row).not.toBeNull()
			for (const tag of STREET_SIDE_TAGS) {
				expect(row!.components[tag]).toBeUndefined()
			}
		}
	})

	it("template distribution is reasonable across 1000 invocations", () => {
		const rng = seededRandom(99)
		const counts: Record<NoStreetTemplate, number> = {
			"venue-plain": 0,
			"venue-adversarial": 0,
			"locality-region-postcode": 0,
			"locality-region": 0,
			"postcode-only": 0,
			"country-only": 0,
		}
		for (let i = 0; i < 1000; i++) {
			const row = synthesizeNoStreetRow(SAMPLE_BASE, { random: rng })
			counts[row!.template]++
		}
		// venue-adversarial is the critical slice — should be the largest single bucket.
		expect(counts["venue-adversarial"]).toBeGreaterThan(counts["venue-plain"])
		// All templates should fire at least once at this sample size.
		for (const t of Object.keys(counts) as NoStreetTemplate[]) {
			expect(counts[t]).toBeGreaterThan(0)
		}
	})

	it("uses the correct locale for each country", () => {
		const cases: Array<[string, string]> = [
			["US", "en-US"],
			["FR", "fr-FR"],
			["DE", "de-DE"],
			["GB", "en-GB"],
			["CA", "en-CA"],
			["AU", "en-AU"],
		]
		for (const [country, expectedLocale] of cases) {
			const row = synthesizeNoStreetRow(
				{ ...SAMPLE_BASE, country },
				{ random: seededRandom(7), forceTemplate: "venue-plain" }
			)
			expect(row!.locale).toBe(expectedLocale)
		}
	})
})
