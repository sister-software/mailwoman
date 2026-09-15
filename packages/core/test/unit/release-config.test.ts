/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The two derivations over `release.config.json`, and the invariant that used to live in a lint check.
 *
 *   `WEIGHTS_PACKAGE_BY_COUNTRY` was a hand-written country→locale table in the coverage census, and
 *   `repo-health`'s `locale-tables` check existed because it was a second copy of this config's two lists — `ja-jp`
 *   and `zh-cn` shipped while the census named neither, and every consumer read that absence as a country with no
 *   weights package. The table is derived now, so the completeness invariant belongs here, against the derivation,
 *   where a shipping locale it fails to name is a failing assertion rather than a finding about a copy.
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
		// A blank key is a country the census would report on, and it is not a country.
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
