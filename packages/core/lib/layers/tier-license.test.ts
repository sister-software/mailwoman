/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { assertTierMatchesLicense, LayerTier, polygonLayerManifest } from "#layers/index"

describe("assertTierMatchesLicense", () => {
	it("accepts a shipped tier on an attribution-only grant", () => {
		expect(() => assertTierMatchesLicense({ tier: LayerTier.Shipped, license: "etalab-2.0" }, "t")).not.toThrow()
	})

	it("refuses a shipped tier on a share-alike grant, including inside an AND expression", () => {
		expect(() => assertTierMatchesLicense({ tier: LayerTier.Shipped, license: "ODbL-1.0" }, "t")).toThrow(
			/cannot be tier "shipped"/u
		)

		expect(() => assertTierMatchesLicense({ tier: LayerTier.Shipped, license: "ODbL-1.0 AND CC-BY-4.0" }, "t")).toThrow(
			/cannot be tier "shipped"/u
		)
	})

	it("refuses a shipped tier on an unresolved license and appends the caller's detail", () => {
		expect(() =>
			assertTierMatchesLicense({ tier: LayerTier.Shipped, license: "NOASSERTION" }, "t", "Three statements disagree.")
		).toThrow(/obligations are not recorded.*Three statements disagree\./u)
	})

	it("accepts a build-local tier on a share-alike or unresolved license", () => {
		expect(() => assertTierMatchesLicense({ tier: LayerTier.BuildLocal, license: "ODbL-1.0" }, "t")).not.toThrow()
		expect(() => assertTierMatchesLicense({ tier: LayerTier.BuildLocal, license: "NOASSERTION" }, "t")).not.toThrow()
	})

	it("refuses a build-local tier on an attribution-only grant", () => {
		expect(() => assertTierMatchesLicense({ tier: LayerTier.BuildLocal, license: "etalab-2.0" }, "t")).toThrow(
			/carries no share-alike obligation/u
		)
	})

	it("makes no claim about the private tier", () => {
		expect(() => assertTierMatchesLicense({ tier: LayerTier.Private, license: "" }, "t")).not.toThrow()
	})

	it("runs inside polygonLayerManifest", () => {
		const stamp = {
			sourceVintage: "2026-01-01",
			buildCmd: "vitest",
			buildSHA: "fixture",
			createdAt: "2026-01-01T00:00:00.000Z",
			indexResolution: 9,
		}

		const product = {
			name: "fixture",
			schemaVersion: 1,
			attribution: "fixture",
			source: "fixture",
			cellColumn: "h3_cell",
		}

		expect(() => polygonLayerManifest(stamp, { ...product, license: "ODbL-1.0" })).toThrow(/fixture manifest/u)
		expect(polygonLayerManifest(stamp, { ...product, license: "OGL-UK-3.0" }).tier).toBe(LayerTier.Shipped)
	})
})
