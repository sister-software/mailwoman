/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The manifest a postcode or locality builder stamps, and the tier each builder states.
 *
 *   A fold's `layer_manifest.tier` is what the candidate build reads before folding it, so the value each
 *   builder writes is pinned here: the Code-Point and Taiwan composers directly, because their full builds
 *   need an archive and a parquet, and the GeoNames tail's terms function for both of its country shapes.
 */

import { LayerTier } from "@mailwoman/core/layers"
import { codePointLayerManifest } from "mailwoman/gazetteer-pipeline/postcode/codepoint/database"
import { geonamesTailTerms } from "mailwoman/gazetteer-pipeline/postcode/geonames/tail"
import { foldLayerManifest } from "mailwoman/gazetteer-pipeline/stamp-manifest"
import { twDistrictsLayerManifest } from "mailwoman/gazetteer-pipeline/tw-districts"
import { describe, expect, it } from "vitest"

const BASE = {
	name: "fixture",
	version: "2026-09-27",
	source: "fixture",
	sourceVintage: "fixture",
	buildCmd: "fixture",
	buildSHA: "abc1234",
	createdAt: "2026-09-27T00:00:00.000Z",
	spineKeys: { wofID: "id" },
}

describe("foldLayerManifest", () => {
	it("records the expression a builder's prose resolves to, never the prose", () => {
		// The value `localities-nz-linz.db` writes into `database_meta`, measured 2026-09-27.
		const manifest = foldLayerManifest({
			...BASE,
			tier: LayerTier.Shipped,
			license: "CC-BY-4.0, attribution Land Information New Zealand",
		})

		expect(manifest.license).toBe("CC-BY-4.0")
		expect(manifest.tier).toBe("shipped")
		expect(manifest.freshnessPolicy).toBe("sealed")
	})

	it("refuses prose that resolves to no expression rather than stamping it", () => {
		expect(() => foldLayerManifest({ ...BASE, tier: LayerTier.Shipped, license: "see the README" })).toThrow(
			/resolves to no SPDX expression/
		)
	})

	it("refuses a tier the license contradicts", () => {
		// A share-alike grant cannot be shipped, and an attribution-only grant is not build-local.
		expect(() =>
			foldLayerManifest({ ...BASE, tier: LayerTier.Shipped, license: "Open Database License (ODbL) 1.0" })
		).toThrow(/carries share-alike/)

		expect(() => foldLayerManifest({ ...BASE, tier: LayerTier.BuildLocal, license: "CC-BY-4.0" })).toThrow(
			/carries no share-alike/
		)
	})

	it("accepts an admissible expression that stays unresolved at build-local", () => {
		// An input nobody has declared terms for is a reason to withhold publication,
		// and the manifest carries it as written rather than dropping it.
		const manifest = foldLayerManifest({
			...BASE,
			tier: LayerTier.BuildLocal,
			license: "CC-BY-4.0 AND LicenseRef-Undeclared-Input",
		})

		expect(manifest.license).toBe("CC-BY-4.0 AND LicenseRef-Undeclared-Input")
	})
})

describe("codePointLayerManifest", () => {
	it("records OGL v3 at tier shipped with the attribution year from the archive", () => {
		const manifest = codePointLayerManifest({
			osVersion: "2026-05",
			metadata: {
				product: "OS CODE-POINT_03.02",
				datasetVersion: "2026.2.0",
				copyrightDate: "20260420",
				royalMailUpdateDate: "20260417",
				rowsByArea: { AB: 2 },
				totalRows: 2,
			},
			now: new Date("2027-01-01T00:00:00.000Z"),
		})

		expect(manifest.name).toBe("postalcode-gb-codepoint")
		expect(manifest.tier).toBe(LayerTier.Shipped)
		expect(manifest.license).toBe("OGL-UK-3.0")
		expect(manifest.version).toBe("2026-05")
		// The archive's year rather than the build clock's.
		expect(manifest.attribution).toContain("2026")
		expect(manifest.attribution).not.toContain("2027")
	})
})

describe("twDistrictsLayerManifest", () => {
	it("records the settled grant at tier shipped", () => {
		// The expression the lab host's `localities-tw-districts.db` carries in `database_meta`, measured 2026-09-27.
		const manifest = twDistrictsLayerManifest({
			license: "CDLA-Permissive-2.0 AND OGDL-Taiwan-1.0",
			release: "2026-08-20.0",
			sourceMD5: "0".repeat(32),
			now: new Date("2026-09-27T00:00:00.000Z"),
		})

		expect(manifest.name).toBe("localities-tw-districts")
		expect(manifest.tier).toBe(LayerTier.Shipped)
		expect(manifest.license).toBe("CDLA-Permissive-2.0 AND OGDL-Taiwan-1.0")
		expect(manifest.version).toBe("2026-08-20.0")
	})
})

describe("geonamesTailTerms", () => {
	it("is CC-BY 4.0 at tier shipped without GB", () => {
		expect(geonamesTailTerms(["FI", "CZ", "PL"])).toEqual({ tier: LayerTier.Shipped, license: "CC-BY-4.0" })
	})

	it("is build-local with an undeclared input once GB rides in", () => {
		// GB_full's Northern Ireland rows have no documented provenance, which withholds publication.
		const terms = geonamesTailTerms(["FI", "GB"])

		expect(terms.tier).toBe(LayerTier.BuildLocal)
		expect(terms.license).toBe("CC-BY-4.0 AND OGL-UK-3.0 AND LicenseRef-Undeclared-Input")
		// The pair is what `assertTierMatchesLicense` accepts, so a build with GB still stamps.
		expect(() => foldLayerManifest({ ...BASE, ...terms })).not.toThrow()
	})
})
