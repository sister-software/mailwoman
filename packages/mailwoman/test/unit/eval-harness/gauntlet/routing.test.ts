import {
	gradedBaseOnly,
	OVERLAY_LOCALE_BY_COUNTRY,
	overlayLocale,
	routeCountry,
} from "mailwoman/eval-harness/gauntlet/routing"
import { describe, expect, it } from "vitest"

describe("board overlay routing", () => {
	it("uses an explicit locale region before the truth country", () => {
		expect(routeCountry({ locale: "en-US", country: "FR" })).toBe("US")
	})

	it("uses the truth country when the row has no locale", () => {
		expect(routeCountry({ country: "GB" })).toBe("GB")
	})

	it("leaves a row without either routing signal unset", () => {
		expect(routeCountry({})).toBeUndefined()
	})

	it("maps every declared overlay and otherwise selects the base locale", () => {
		for (const [country, locale] of Object.entries(OVERLAY_LOCALE_BY_COUNTRY)) {
			expect(overlayLocale(country)).toBe(locale)
		}

		expect(overlayLocale("FR")).toBe("en-US")
		expect(overlayLocale(undefined)).toBe("en-US")
	})
})

describe("gradedBaseOnly (#2223)", () => {
	it("reports a routed country whose overlay failed to load", () => {
		expect(gradedBaseOnly("GB", new Set(["en-GB"]))).toBe(true)
	})

	it("clears a routed country whose overlay loaded", () => {
		expect(gradedBaseOnly("GB", new Set(["es-ES"]))).toBe(false)
		expect(gradedBaseOnly("GB", new Set())).toBe(false)
	})

	it("clears a country that declares no overlay, because the base package IS its production path", () => {
		// FR routes through en-US by design. Calling that base-only would withhold a promote suggestion the run is
		// entitled to make, which is the opposite of this predicate's purpose.
		expect(gradedBaseOnly("FR", new Set(["en-GB", "es-ES"]))).toBe(false)
		expect(gradedBaseOnly(undefined, new Set(["en-GB"]))).toBe(false)
	})

	it("reports EVERY country routing to a failed overlay, not only the first one graded", () => {
		// The harness memoizes its fallback per LOCALE, so a second country sharing an overlay never re-enters the
		// failure path. Keyed by country, that country would silently read as production-true.
		const shared = Object.entries(OVERLAY_LOCALE_BY_COUNTRY)
			.filter(([, locale]) => locale === "en-GB")
			.map(([country]) => country)

		for (const country of shared) {
			expect(gradedBaseOnly(country, new Set(["en-GB"]))).toBe(true)
		}
	})

	it("answers for every declared overlay when all of them failed", () => {
		const allFailed = new Set(Object.values(OVERLAY_LOCALE_BY_COUNTRY))

		for (const country of Object.keys(OVERLAY_LOCALE_BY_COUNTRY)) {
			expect(gradedBaseOnly(country, allFailed)).toBe(true)
		}
	})
})
