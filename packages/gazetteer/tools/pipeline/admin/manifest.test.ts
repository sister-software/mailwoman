// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   A manifest field that's wrong misleads its reader, so each field must be true
 *   of the build that produced it rather than merely populated.
 */

import { describe, expect, it } from "vitest"

import { adminLayerManifest } from "#tools/pipeline/admin/manifest"

const BASE = { buildSHA: "abc1234", createdAt: "2026-08-17T00:00:00.000Z", version: "2026-08-17.0" }

describe("adminLayerManifest — source is derived from the run", () => {
	it("names only the folds that actually ingested rows", () => {
		// A build that read no Overture rows mustn't claim Overture, whatever the recipe lists.
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
		// An empty build is a failed build.
		// A manifest would make the artifact look describable.
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

	it("drops a license whose source contributed no rows", () => {
		const manifest = adminLayerManifest({ ...BASE, counts: { wof: 0, overture: 0, geonames: 7 } })

		expect(manifest.license).toBe("CC-BY-4.0")
		expect(manifest.license).not.toContain("ODbL")
	})
})

describe("adminLayerManifest — vintages", () => {
	it("records a contributing source with no known vintage as unknown, not as blank", () => {
		// An uncaptured vintage would make the source appear to have no version, hiding the gap in the record.
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
