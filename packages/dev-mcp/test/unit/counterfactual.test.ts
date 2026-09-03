/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The setting space and the move predicate. Driven through `resolveConfig` rather than a hand-built options object, so
 *   the flips are stated against the configuration production actually ships — a flip enumerated off a caller's
 *   half-filled config would move the unset settings in the wrong direction.
 */

import {
	BASE_LOCALE,
	COUNTERFACTUAL_SETTINGS,
	COUNTERFACTUAL_MOVED_KM,
	enumerateFlips,
	measureMove,
	type CounterfactualSetting,
} from "@mailwoman/dev-mcp/counterfactual"
import { resolveConfig } from "@mailwoman/dev-mcp/engine-registry"
import { describe, expect, it } from "vitest"

async function flipFor(setting: CounterfactualSetting, locale: string, country: string | undefined) {
	return (await enumerateFlips(resolveConfig({ locale }), country)).flips.find((flip) => flip.setting === setting)
}

describe("enumerateFlips — one setting at a time", () => {
	it("moves exactly one key per flip", async () => {
		const { flips } = await enumerateFlips(resolveConfig({}), "US")

		for (const flip of flips) {
			expect(Object.keys(flip.patch)).toHaveLength(1)
		}
	})

	it("offers every setting in the fixed space where it applies", async () => {
		const { flips } = await enumerateFlips(resolveConfig({}), "GB")

		expect(flips.map((flip) => flip.setting).toSorted()).toEqual([...COUNTERFACTUAL_SETTINGS].toSorted())
	})

	it("flips a base-locale row TO its country's overlay", async () => {
		expect(await flipFor("locale", BASE_LOCALE, "GB")).toMatchObject({ from: BASE_LOCALE, to: "en-GB" })
	})

	it("flips a row already under its overlay BACK to the base — the only way to price the overlay", async () => {
		expect(await flipFor("locale", "de-DE", "DE")).toMatchObject({ from: "de-DE", to: BASE_LOCALE })
	})

	it("skips the locale setting with a stated reason rather than omitting it", async () => {
		const noCountry = await enumerateFlips(resolveConfig({}), undefined)
		const noOverlay = await enumerateFlips(resolveConfig({}), "JP")

		expect(noCountry.flips.some((flip) => flip.setting === "locale")).toBe(false)
		expect(noCountry.skipped[0]!.why).toContain("no country for this row")
		expect(noOverlay.skipped[0]!.why).toContain("no weights overlay ships for JP")
	})

	it("flips country_scope between auto and none in both directions", async () => {
		expect((await enumerateFlips(resolveConfig({ country_scope: "none" }), "US")).flips).toContainEqual(
			expect.objectContaining({ setting: "country_scope", from: "none", to: "auto" })
		)

		expect((await enumerateFlips(resolveConfig({ country_scope: "auto" }), "US")).flips).toContainEqual(
			expect.objectContaining({ setting: "country_scope", from: "auto", to: "none" })
		)
	})
})

describe("measureMove", () => {
	it("ignores a move under the reporting threshold", () => {
		expect(
			measureMove({ lat: 48.8566, lon: 2.3522, tier: "admin" }, { lat: 48.8566, lon: 2.3523, tier: "admin" })
		).toBeNull()
	})

	it("reports a move past the threshold with its distance", () => {
		const move = measureMove(
			{ lat: 48.8566, lon: 2.3522, tier: "admin" },
			{ lat: 50.9795, lon: 11.3235, tier: "admin" }
		)

		expect(move!.moved_km).toBeGreaterThan(COUNTERFACTUAL_MOVED_KM)
		expect(move!.changed_abstention).toBe(false)
	})

	it("reports a changed abstention with a NULL distance, never a zero", () => {
		// An abstention has no distance from anything. Turning that into a number is the projection this surface
		// exists to avoid.
		const move = measureMove({ lat: null, lon: null, tier: "admin" }, { lat: 1, lon: 2, tier: "admin" })

		expect(move!.changed_abstention).toBe(true)
		expect(move!.moved_km).toBeNull()
	})

	it("reports nothing when both arms abstained", () => {
		expect(measureMove({ lat: null, lon: null, tier: "admin" }, { lat: null, lon: null, tier: "admin" })).toBeNull()
	})
})
