/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   This test covers two derivations from `release.config.json`.
 *   It also checks the invariant formerly enforced by a lint check.
 *
 *   `WEIGHTS_PACKAGE_BY_COUNTRY` used to be a hand-written table in the coverage census.
 *   `repo-health`'s `locale-tables` check guarded against a second copy of the config lists.
 *   The census omitted `ja-jp` and `zh-cn` after the config began shipping them.
 *   Consumers then read those omissions as countries without weight packages.
 *   The table is now derived from the config, so this test checks that derivation for every shipping locale.
 */

import { readReleaseConfig, shippingLocales, weightsPackageByCountry } from "@mailwoman/core/release-config"
import { describe, expect, it } from "vitest"

describe("shippingLocales", () => {
	it("takes the Latin list and every character-path family's overlays", () => {
		const locales = shippingLocales({
			locales: ["en-us", "fr-fr"],
			charWeights: { cjk: { model: "m", charVocab: "v", overlays: ["ja-jp", "zh-cn"] } },
		})

		expect([...locales].toSorted()).toEqual(["en-us", "fr-fr", "ja-jp", "zh-cn"])
	})

	it("survives a config with no character-path family", () => {
		expect([...shippingLocales({ locales: ["en-us"] })]).toEqual(["en-us"])
	})
})

describe("weightsPackageByCountry", () => {
	it("reads the country off each locale's region subtag, both halves of the config", () => {
		const packages = weightsPackageByCountry({
			locales: ["en-us", "fr-fr", "en-gb"],
			charWeights: { cjk: { model: "m", charVocab: "v", overlays: ["ja-jp", "zh-cn"] } },
		})

		expect(Object.fromEntries(packages)).toEqual({
			US: "en-us",
			FR: "fr-fr",
			GB: "en-gb",
			JP: "ja-jp",
			CN: "zh-cn",
		})
	})

	it("contributes nothing for a tag with no region, rather than a blank key", () => {
		// The census would report a blank key as a country.
		// A blank key does not identify a country.
		expect([...weightsPackageByCountry({ locales: ["en", "fr-fr"] }).keys()]).toEqual(["FR"])
	})

	it("names EVERY locale the committed config ships — the invariant retired from `locale-tables`", async () => {
		const config = await readReleaseConfig()
		const named = new Set([...weightsPackageByCountry(config).values()].map((locale) => locale.toLowerCase()))

		for (const locale of shippingLocales(config)) {
			expect(named, `release.config.json ships ${locale} and the derivation does not name it`).toContain(
				locale.toLowerCase()
			)
		}
	})
})
