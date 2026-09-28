/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The manifest is only worth its accuracy, so each field must be true of the build that produced it
 *   rather than merely populated.
 */

import { LayerFreshnessPolicy, LayerTier } from "@mailwoman/core/layers"
import { adminLayerManifest } from "mailwoman/gazetteer-pipeline/admin/manifest"
import { describe, expect, it } from "vitest"

const BASE = { buildSHA: "abc1234", createdAt: "2026-08-17T00:00:00.000Z", version: "2026-08-17.0" }

describe("adminLayerManifest — source is derived from the run", () => {
	it("names only the folds that actually ingested rows", () => {
		// A build that read no Overture rows must not claim Overture, whatever the recipe lists.
		const manifest = adminLayerManifest({ ...BASE, counts: { wof: 100, overture: 0, geonames: 0 } })

		expect(manifest.source).toBe("whosonfirst")
		expect(manifest.license).toBe("LicenseRef-WhosOnFirst-Mixed")
	})

	it("composes all three when all three contributed", () => {
		const manifest = adminLayerManifest({ ...BASE, counts: { wof: 1, overture: 2, geonames: 3 } })

		expect(manifest.source).toBe("whosonfirst+overture-divisions+geonames")
	})

	it("orders sources fixedly, so two builds with the same sources agree", () => {
		const a = adminLayerManifest({ ...BASE, counts: { wof: 1, overture: 2, geonames: 0 } })
		const b = adminLayerManifest({ ...BASE, counts: { wof: 9, overture: 9, geonames: 0 } })

		expect(a.source).toBe(b.source)
	})

	it("refuses to stamp a manifest on a gazetteer built from nothing", () => {
		// An empty build is a failed build, and a manifest would make the artifact look describable.
		expect(() => adminLayerManifest({ ...BASE, counts: { wof: 0, overture: 0, geonames: 0 } })).toThrow(
			/no source ingested/
		)
	})
})

describe("adminLayerManifest — the license is a conjunction", () => {
	it("ANDs every contributing source's terms rather than picking one", () => {
		// The most permissive license, or the largest contributor's, would be an unsupported distribution claim.
		const manifest = adminLayerManifest({ ...BASE, counts: { wof: 1, overture: 1, geonames: 1 } })

		expect(manifest.license).toBe("LicenseRef-WhosOnFirst-Mixed AND ODbL-1.0 AND CC-BY-4.0")
	})

	it("gives the Overture fold its Divisions grant rather than the Places theme's", () => {
		// Overture licenses per theme: Divisions' grant is `License for theme: ODbL`,
		// where `CDLA-Permissive-2.0` is the Places theme's grant.
		const manifest = adminLayerManifest({ ...BASE, counts: { wof: 0, overture: 5, geonames: 0 } })

		expect(manifest.license).toBe("ODbL-1.0")
		expect(manifest.license).not.toContain("CDLA")
	})

	it("records the Who's On First records as a LicenseRef rather than electing one of its 102 sources", () => {
		// Who's On First states CC0 over "the format and structure" while the records are a modification
		// of sources with their own terms, so CC0 or ODbL would each claim a grant its text never states.
		const manifest = adminLayerManifest({ ...BASE, counts: { wof: 3, overture: 0, geonames: 0 } })

		expect(manifest.license).toBe("LicenseRef-WhosOnFirst-Mixed")
	})

	it("drops a license whose source contributed no rows", () => {
		const manifest = adminLayerManifest({ ...BASE, counts: { wof: 0, overture: 0, geonames: 7 } })

		expect(manifest.license).toBe("CC-BY-4.0")
		expect(manifest.license).not.toContain("ODbL")
	})

	it("is never `shipped`, because the Overture Divisions grant is share-alike", () => {
		// The same reason packages/osm is held out of the release list: the builder ships, the artifact does not.
		expect(adminLayerManifest({ ...BASE, counts: { wof: 1, overture: 0, geonames: 0 } }).tier).toBe(
			LayerTier.BuildLocal
		)
	})
})

describe("adminLayerManifest — vintages", () => {
	it("records a contributing source with no known vintage as unknown, not as blank", () => {
		// Omitting an uncaptured vintage would read as a source with no version rather than as a gap in what was recorded.
		const manifest = adminLayerManifest({
			...BASE,
			counts: { wof: 1, overture: 1, geonames: 0 },
			vintages: { wof: "2026-03-16" },
		})

		expect(manifest.sourceVintage).toBe("whosonfirst=2026-03-16 overture-divisions=unknown")
	})

	it("ignores a vintage for a source that contributed nothing", () => {
		const manifest = adminLayerManifest({
			...BASE,
			counts: { wof: 1, overture: 0, geonames: 0 },
			vintages: { overture: "2026-06-17.0" },
		})

		expect(manifest.sourceVintage).not.toContain("overture")
	})
})

describe("adminLayerManifest — the fields a reader acts on", () => {
	it("names a build command that is a real CLI verb, not a path", () => {
		// `data inventory` flags a build_cmd whose path tokens do not resolve,
		// so a CLI verb is what survives a workspace regroup.
		const manifest = adminLayerManifest({ ...BASE, counts: { wof: 1, overture: 0, geonames: 0 } })

		expect(manifest.buildCmd).toBe("mailwoman gazetteer build admin")
		expect(manifest.buildCmd).not.toContain("/")
	})

	it("declares the WOF id spine, which is the join key every consumer uses", () => {
		const manifest = adminLayerManifest({ ...BASE, counts: { wof: 1, overture: 0, geonames: 0 } })

		expect(manifest.spineKeys).toEqual({ wofID: "id" })
		expect(manifest.freshnessPolicy).toBe(LayerFreshnessPolicy.Sealed)
	})
})
