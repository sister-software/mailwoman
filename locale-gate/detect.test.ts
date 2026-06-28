/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { detectLocaleSync } from "./detect.js"
import type { NormalizedInputLite, QueryShapeLike } from "./types.js"

function input(normalized: string): NormalizedInputLite {
	return { raw: normalized, normalized }
}

function shape(opts: Partial<QueryShapeLike> = {}): QueryShapeLike {
	return { knownFormats: [], ...opts }
}

describe("detectLocale — caller hint precedence", () => {
	it("caller hint wins at confidence 1.0 with source=caller", () => {
		const r = detectLocaleSync(input("anything"), shape({ characterClass: "cjk" }), { hint: "fr-FR" })
		expect(r.locale).toBe("fr-FR")
		expect(r.confidence).toBe(1.0)
		expect(r.source).toBe("caller")
	})

	it("detector-derived candidates surface as alternatives when hint is set", () => {
		const r = detectLocaleSync(input("東京駅"), shape({ characterClass: "cjk" }), { hint: "en-US" })
		expect(r.locale).toBe("en-US")
		const altLocales = r.alternatives.map((a) => a.locale)
		expect(altLocales).toContain("ja-JP")
	})
})

describe("detectLocale — script-based detection", () => {
	it("CJK input → ja-JP", () => {
		const r = detectLocaleSync(input("東京駅"), shape({ characterClass: "cjk" }))
		expect(r.locale).toBe("ja-JP")
		expect(r.source).toBe("detected")
	})

	it("Cyrillic input → ru-RU", () => {
		const r = detectLocaleSync(input("Москва"), shape({ characterClass: "cyrillic" }))
		expect(r.locale).toBe("ru-RU")
	})

	it("Arabic input → ar", () => {
		const r = detectLocaleSync(input("دبي"), shape({ characterClass: "arabic" }))
		expect(r.locale).toBe("ar")
	})
})

describe("detectLocale — postcode-format detection", () => {
	it("US ZIP+4 unambiguously → en-US", () => {
		const r = detectLocaleSync(
			input("10118-1234"),
			shape({
				knownFormats: [{ format: "us_zip4", span: { start: 0, end: 10 }, confidence: 0.95 }],
				characterClass: "alphanumeric",
			})
		)
		expect(r.locale).toBe("en-US")
		expect(r.confidence).toBeGreaterThanOrEqual(0.9)
	})

	it("UK postcode → en-GB", () => {
		const r = detectLocaleSync(
			input("SW1A 1AA"),
			shape({
				knownFormats: [{ format: "uk_postcode", span: { start: 0, end: 8 }, confidence: 0.9 }],
				characterClass: "alphanumeric",
			})
		)
		expect(r.locale).toBe("en-GB")
	})

	it("CA postcode → en-CA", () => {
		const r = detectLocaleSync(
			input("K1A 0B1"),
			shape({
				knownFormats: [{ format: "ca_postcode", span: { start: 0, end: 7 }, confidence: 0.9 }],
				characterClass: "alphanumeric",
			})
		)
		expect(r.locale).toBe("en-CA")
	})

	it("JP postcode → ja-JP", () => {
		const r = detectLocaleSync(
			input("100-0005"),
			shape({
				knownFormats: [{ format: "jp_postcode", span: { start: 0, end: 8 }, confidence: 0.95 }],
				characterClass: "alphanumeric",
			})
		)
		expect(r.locale).toBe("ja-JP")
	})

	it("ambiguous 5-digit → en-US at low confidence with alternatives present", () => {
		const r = detectLocaleSync(
			input("10118"),
			shape({
				knownFormats: [
					{ format: "us_zip", span: { start: 0, end: 5 }, confidence: 0.6 },
					{ format: "fr_postcode", span: { start: 0, end: 5 }, confidence: 0.6 },
					{ format: "de_postcode", span: { start: 0, end: 5 }, confidence: 0.6 },
				],
				characterClass: "numeric",
			})
		)
		expect(r.locale).toBe("en-US")
		expect(r.confidence).toBeLessThan(0.7)
	})
})

describe("detectLocale — fallback + always-decisive", () => {
	it("falls back to en-US when nothing fires", () => {
		const r = detectLocaleSync(input("Paris"), shape({ characterClass: "alpha" }))
		expect(r.locale).toBe("en-US")
		expect(r.confidence).toBeLessThanOrEqual(0.5)
	})

	it("empty shape still emits a decisive locale", () => {
		const r = detectLocaleSync(input(""), shape())
		expect(r.locale).toBeDefined()
		expect(r.source).toBe("detected")
	})

	it("alternatives are sorted descending by confidence", () => {
		const r = detectLocaleSync(input("東京"), shape({ characterClass: "cjk" }))

		for (let i = 1; i < r.alternatives.length; i++) {
			expect(r.alternatives[i]?.confidence).toBeLessThanOrEqual(r.alternatives[i - 1]?.confidence ?? 1)
		}
	})

	it("no duplicate locales in alternatives", () => {
		const r = detectLocaleSync(
			input("10118"),
			shape({
				knownFormats: [{ format: "us_zip", span: { start: 0, end: 5 }, confidence: 0.6 }],
				characterClass: "numeric",
			})
		)
		const allLocales = [r.locale, ...r.alternatives.map((a) => a.locale)]
		const unique = new Set(allLocales)
		expect(unique.size).toBe(allLocales.length)
	})
})

describe("detectLocale — source attribution", () => {
	it("source=caller when hint set", () => {
		expect(detectLocaleSync(input("x"), shape(), { hint: "en-US" }).source).toBe("caller")
	})

	it("source=detected when no hint", () => {
		expect(detectLocaleSync(input("x"), shape()).source).toBe("detected")
	})
})
