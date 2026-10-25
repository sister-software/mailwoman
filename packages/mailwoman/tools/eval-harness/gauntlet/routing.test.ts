import { readReleaseConfig, weightsPackageByCountry } from "@mailwoman/core/release-config"
import { describe, expect, it } from "vitest"

import {
	gradedBaseOnly,
	OVERLAY_LOCALE_BY_COUNTRY,
	overlayLocale,
	routeCountry,
} from "#tools/eval-harness/gauntlet/routing"

// ISO 3166-1 reserves ZZ for user assignment, so no release ever ships a package for it.
const UNSHIPPED_COUNTRY = "ZZ"

describe("board overlay routing", () => {
	it("uses an explicit locale region before the truth country", () => {
		expect(routeCountry({ locale: "en-US", country: "FR" })).toBe("US")
	})

	it("uses the truth country when the row has no locale", () => {
		expect(routeCountry({ country: "GB" })).toBe("GB")
	})

	it("leaves a row without either routing signal unset", () => {
		expect(routeCountry({})).toBeNull()
	})

	it("maps every declared overlay and otherwise selects the base locale", () => {
		for (const [country, locale] of Object.entries(OVERLAY_LOCALE_BY_COUNTRY)) {
			expect(overlayLocale(country)).toBe(locale)
		}

		expect(overlayLocale(UNSHIPPED_COUNTRY)).toBe("en-US")
		expect(overlayLocale(null)).toBe("en-US")
	})

	it("routes every country whose Latin-graph package the release ships, in BCP 47 casing (#2770)", async () => {
		const { locales } = await readReleaseConfig()
		const shipped = weightsPackageByCountry({ locales })
		const baseRegion = routeCountry({ locale: "en-US" })

		expect(baseRegion).not.toBeNull()
		expect(shipped.has(baseRegion!)).toBe(true)
		shipped.delete(baseRegion!)

		expect(Object.keys(OVERLAY_LOCALE_BY_COUNTRY).toSorted()).toEqual([...shipped.keys()].toSorted())

		for (const [country, locale] of shipped) {
			expect(OVERLAY_LOCALE_BY_COUNTRY[country]).toBe(Intl.getCanonicalLocales(locale)[0])
			expect(routeCountry({ locale: OVERLAY_LOCALE_BY_COUNTRY[country] })).toBe(country)
		}
	})

	it("keeps the base locale's country and the character-path families on the base package", async () => {
		const { locales, charWeights } = await readReleaseConfig()
		const latin = weightsPackageByCountry({ locales })
		const baseRegion = routeCountry({ locale: "en-US" })!

		expect(OVERLAY_LOCALE_BY_COUNTRY[baseRegion]).toBeUndefined()
		expect(overlayLocale(baseRegion)).toBe("en-US")

		for (const country of weightsPackageByCountry({ locales: [], charWeights }).keys()) {
			if (latin.has(country)) continue

			expect(OVERLAY_LOCALE_BY_COUNTRY[country]).toBeUndefined()
			expect(overlayLocale(country)).toBe("en-US")
		}
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
		// A country with no shipped package routes through en-US by design.
		// A base-only result would withhold a promote suggestion the run is entitled to make.
		// This predicate serves the opposite purpose.
		expect(gradedBaseOnly(UNSHIPPED_COUNTRY, new Set(["en-GB", "es-ES"]))).toBe(false)
		expect(gradedBaseOnly(null, new Set(["en-GB"]))).toBe(false)
	})

	it("reports EVERY country routing to a failed overlay, not only the first one graded", () => {
		// The harness memoizes its fallback per locale, so a second country sharing
		// an overlay never re-enters the failure path.
		// Keyed by country, that country would silently read as production-true.
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
