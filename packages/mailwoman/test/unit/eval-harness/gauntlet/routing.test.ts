import { OVERLAY_LOCALE_BY_COUNTRY, overlayLocale, routeCountry } from "mailwoman/eval-harness/gauntlet/routing"
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
