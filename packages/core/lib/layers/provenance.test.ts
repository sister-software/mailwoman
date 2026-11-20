// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { type LayerTerms, ProvenanceLinkKind, resolveLayerTerms } from "#layers/provenance"

const ADMIN: LayerTerms = {
	name: "admin-global-priority",
	license: "ODbL-1.0 AND CC-BY-4.0",
	attribution: null,
	source: "whosonfirst+geonames",
}

const CANDIDATE: LayerTerms = {
	name: "candidate",
	license: "CC-BY-4.0",
	attribution: null,
	source: "admin-global-priority@2026-11-18",
}

const locate = (name: string) =>
	name === "whosonfirst" ? { title: "Who's On First", url: "https://wof.example" } : null

describe("resolveLayerTerms", () => {
	it("resolves a source that names another layer through that layer's licenses and sources", () => {
		const provenance = resolveLayerTerms([CANDIDATE], { knownLayers: [CANDIDATE, ADMIN], locate })

		expect(
			provenance.links.filter((link) => link.kind === ProvenanceLinkKind.License).map((link) => link.title)
		).toEqual(["CC-BY-4.0", "ODbL-1.0"])

		expect(provenance.sources).toEqual([
			{ name: "admin-global-priority", location: null, upstream: "admin-global-priority" },
			{ name: "whosonfirst", location: { title: "Who's On First", url: "https://wof.example" }, upstream: null },
			{ name: "geonames", location: null, upstream: null },
		])

		expect(provenance.unlocatedSources).toEqual(["geonames"])
	})

	it("prefers the provider's own location over the locator, and credits a one-source layer in its own words", () => {
		const layer: LayerTerms = {
			name: "addresses-fr",
			license: "etalab-2.0",
			attribution: "© BAN contributors",
			source: "ban:fr",
			sourceLocations: { ban: { title: "Base Adresse Nationale", url: "https://ban.example" } },
		}

		const provenance = resolveLayerTerms([layer], {
			locate: () => ({ title: "elsewhere", url: "https://other.example" }),
		})

		expect(provenance.links.find((link) => link.kind === ProvenanceLinkKind.Source)?.href).toBe("https://ban.example")
		expect(provenance.credits).toEqual(["© BAN contributors"])
		expect(provenance.attributionRequired).toBe(true)
	})

	it("counts a layer without a license instead of reading it as unencumbered", () => {
		const provenance = resolveLayerTerms([{ name: "old", license: null, attribution: null, source: null }])

		expect(provenance.withoutLicense).toBe(1)
		expect(provenance.withoutSource).toBe(1)
		expect(provenance.attributionRequired).toBe(false)
	})
})
