/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the German synthesizer (night-shift 2026-06-02, DE-1). Validates the {raw, components}
 *   contract AND the BIO output via the real `alignRow`: the model must see German order — street →
 *   house_number (house AFTER street) and postcode → locality (postcode BEFORE city) — the
 *   convention the US/FR-trained model never learned.
 */

import { describe, expect, it } from "vitest"
import { alignRow } from "./align.js"
import { type LocaleBaseTuple, synthesizeGermanRow, synthesizeLocaleRow } from "./synthesize-german.js"
import type { CanonicalRow } from "./types.js"

const BERLIN: LocaleBaseTuple = {
	house_number: "27",
	street: "Straußstraße",
	locality: "Berlin",
	region: "Berlin",
	postcode: "12623",
}

// `() => 0.5` keeps both house number (0.5 < 0.8) and postcode (0.5 < 0.85).
const keepAll = () => 0.5

describe("synthesizeGermanRow", () => {
	it("renders idiomatic German order (street, then house#; postcode before city)", () => {
		const row = synthesizeGermanRow(BERLIN, { random: keepAll })!
		expect(row).not.toBeNull()
		expect(row.raw).toContain("Straußstraße 27") // house number AFTER street
		expect(row.raw).toContain("12623 Berlin") // postcode BEFORE city
		expect(row.raw.indexOf("Straußstraße")).toBeLessThan(row.raw.indexOf(" 27"))
		expect(row.raw.indexOf("12623")).toBeLessThan(row.raw.indexOf("Berlin"))
	})

	it("drops region (the DE template absorbs the Bundesland into the city line)", () => {
		const row = synthesizeGermanRow(BERLIN, { random: keepAll })!
		expect(row.components.region).toBeUndefined()
	})

	it("aligns to German-order BIO: house_number after street, locality after postcode", () => {
		const row = synthesizeGermanRow(BERLIN, { random: keepAll })!
		const canonical = { ...row, country: "DE", source: "synth-german", source_id: "synth-german:test" } as CanonicalRow
		const aligned = alignRow(canonical)
		expect(aligned.kind).toBe("labeled")
		const labels = aligned.row!.labels
		const firstOf = (tag: string) => labels.findIndex((l) => l.includes(tag))
		expect(firstOf("street")).toBeGreaterThanOrEqual(0)
		expect(firstOf("house_number")).toBeGreaterThan(firstOf("street"))
		expect(firstOf("locality")).toBeGreaterThan(firstOf("postcode"))
	})
})

describe("synthesizeLocaleRow (generic)", () => {
	it("ES renders Spanish order (house after street, postcode before city) and tags the locale", () => {
		const madrid: LocaleBaseTuple = { house_number: "12", street: "Calle Mayor", locality: "Madrid", postcode: "28013" }
		const row = synthesizeLocaleRow(madrid, "ES", { random: keepAll })!
		expect(row).not.toBeNull()
		expect(row.locale).toBe("es-ES")
		// ES renders "Calle Mayor, 12, 28013 Madrid" — house AFTER street (a comma between them,
		// unlike German), postcode BEFORE city. The order is what the recipe teaches.
		expect(row.raw.indexOf("Calle Mayor")).toBeLessThan(row.raw.indexOf("12"))
		expect(row.raw).toContain("28013 Madrid")
	})

	it("synthesizeGermanRow is the DE wrapper", () => {
		const row = synthesizeGermanRow(BERLIN, { random: keepAll })!
		expect(row.locale).toBe("de-DE")
		expect(synthesizeLocaleRow(BERLIN, "DE", { random: keepAll })!.raw).toBe(row.raw)
	})
})

describe("synthesizeLocaleRow order option (order-robustness)", () => {
	it("international order renders house-FIRST, postcode-AFTER-city — the inverse of native", () => {
		// keepAll = 0.5 keeps house# + postcode and picks GB (Math.floor(0.5 * 2) = 1) → a house-first,
		// postcode-trailing layout, e.g. "27 Straußstraße, Berlin, 12623".
		const row = synthesizeLocaleRow(BERLIN, "DE", { random: keepAll, order: "international" })!
		expect(row).not.toBeNull()
		expect(row.raw.indexOf("27")).toBeLessThan(row.raw.indexOf("Straußstraße")) // house BEFORE street
		expect(row.raw.indexOf("12623")).toBeGreaterThan(row.raw.indexOf("Berlin")) // postcode AFTER city
	})

	it("keeps the address's own locale tag — only the surface layout changes", () => {
		const row = synthesizeLocaleRow(BERLIN, "DE", { random: keepAll, order: "international" })!
		expect(row.locale).toBe("de-DE") // the render template is US/GB, but it's still a German address
	})

	it("aligns to international-order BIO: house_number before street, postcode after locality", () => {
		const row = synthesizeLocaleRow(BERLIN, "DE", { random: keepAll, order: "international" })!
		const canonical = { ...row, country: "DE", source: "synth-german", source_id: "synth-german:intl" } as CanonicalRow
		const aligned = alignRow(canonical)
		expect(aligned.kind).toBe("labeled")
		const labels = aligned.row!.labels
		const firstOf = (tag: string) => labels.findIndex((l) => l.includes(tag))
		expect(firstOf("house_number")).toBeLessThan(firstOf("street")) // inverse of the native test
		expect(firstOf("postcode")).toBeGreaterThan(firstOf("locality"))
	})

	it("native order is unchanged and consumes no extra RNG draw (default stays default)", () => {
		// Same seeded sequence must yield the identical native render whether or not `order` is passed.
		const seq = () => {
			let i = 0
			const vals = [0.1, 0.2, 0.3, 0.4]
			return () => vals[i++ % vals.length]!
		}
		const withoutOpt = synthesizeLocaleRow(BERLIN, "DE", { random: seq() })!
		const withNative = synthesizeLocaleRow(BERLIN, "DE", { random: seq(), order: "native" })!
		expect(withNative.raw).toBe(withoutOpt.raw)
	})
})
