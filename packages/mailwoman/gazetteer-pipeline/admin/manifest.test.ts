/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The admin manifest, and the two claims it must not make.
 *
 *   A manifest is only worth its accuracy — `data inventory` already found three shipped artifacts whose
 *   `build_cmd` names a path the workspace regroup moved, and one naming a gitignored scratchpad script.
 *   Those pass every "has a manifest" check and document nothing. So what is asserted here is not that the
 *   fields are populated but that each one is TRUE of the build that produced it.
 */

import { LayerFreshnessPolicy, LayerTier } from "@mailwoman/core/layers"
import { describe, expect, it } from "vitest"

import { adminLayerManifest } from "./manifest.ts"

const BASE = { buildSHA: "abc1234", createdAt: "2026-08-17T00:00:00.000Z", version: "2026-08-17.0" }

describe("adminLayerManifest — source is derived from the run", () => {
	it("names only the folds that actually ingested rows", () => {
		// The #1015 lesson at its narrowest: the manifest that lagged recorded an INTENTION. A build that read
		// no Overture rows must not claim Overture, whatever the recipe lists.
		const manifest = adminLayerManifest({ ...BASE, counts: { wof: 100, overture: 0, geonames: 0 } })

		expect(manifest.source).toBe("whosonfirst")
		expect(manifest.license).toBe("ODbL-1.0")
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
		// An empty build is a failed build. A manifest would make the artifact look describable.
		expect(() => adminLayerManifest({ ...BASE, counts: { wof: 0, overture: 0, geonames: 0 } })).toThrow(
			/no source ingested/
		)
	})
})

describe("adminLayerManifest — the licence is a conjunction", () => {
	it("ANDs every contributing source's terms rather than picking one", () => {
		// Three sources, three different licences, one file. Recording the most permissive — or the licence of
		// the largest contributor — would be a distribution claim nobody made.
		const manifest = adminLayerManifest({ ...BASE, counts: { wof: 1, overture: 1, geonames: 1 } })

		expect(manifest.license).toBe("ODbL-1.0 AND CDLA-Permissive-2.0 AND CC-BY-4.0")
	})

	it("drops a licence whose source contributed nothing", () => {
		const manifest = adminLayerManifest({ ...BASE, counts: { wof: 0, overture: 5, geonames: 0 } })

		expect(manifest.license).toBe("CDLA-Permissive-2.0")
		expect(manifest.license).not.toContain("ODbL")
	})

	it("is never `shipped`, because ODbL is share-alike", () => {
		// The same reason packages/osm is held out of the release list: the builder ships, the artifact does not.
		expect(adminLayerManifest({ ...BASE, counts: { wof: 1, overture: 0, geonames: 0 } }).tier).toBe(
			LayerTier.BuildLocal
		)
	})
})

describe("adminLayerManifest — vintages", () => {
	it("records a contributing source with no known vintage as unknown, not as blank", () => {
		// A vintage nobody captured is a fact about the build. Omitting it would read as a source with no
		// version rather than as a gap in what was recorded.
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
		// `data inventory` flags a build_cmd whose path tokens do not resolve. A CLI verb has none, which is
		// what makes it survive a workspace regroup.
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
