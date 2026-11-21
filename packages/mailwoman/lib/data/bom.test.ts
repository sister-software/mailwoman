// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { RegisterTermsBasis } from "@mailwoman/corpus/source-register/terms"
import { describe, expect, it } from "vitest"

import { buildDataBOM, type DataBOMComponent, type DataBOMMixedLayer, LicenseBasis, serializeDataBOM } from "#data/bom"
import { Provenance, type InventoryReport } from "#data/inventory"
import { type MixedLayerSource, ObligationClass } from "#data/mixed-layer"

const OSM_PATH = "db/osm/address-points-nz-nz.db"

const INVENTORY: InventoryReport = {
	dataRoot: "/data",
	entries: [
		{
			path: OSM_PATH,
			bytes: 412_000_000,
			provenance: Provenance.Manifested,
			manifest: {
				name: "osm-address-points-nz-nz",
				version: "260806",
				tier: "build-local",
				license: "ODbL-1.0",
				attribution: "© OpenStreetMap contributors",
				source: "openstreetmap:nz",
				source_vintage: "2026-08-06",
				build_cmd: "node packages/osm/tools/build-rooftop-database.ts",
				build_sha: "0123456789abcdef0123456789abcdef01234567",
				created_at: "2026-08-07T00:00:00.000Z",
				source_url: "https://download.geofabrik.de/australia-oceania/new-zealand-latest.osm.pbf",
				source_sha256: "e".repeat(64),
			},
		},
	],
	counts: {
		[Provenance.Manifested]: 1,
		[Provenance.Unprovenanced]: 0,
		[Provenance.Foreign]: 0,
		[Provenance.Unreadable]: 0,
	},
	skippedForeign: 0,
	maxDepth: 4,
	layerDepth: 4,
}

describe("buildDataBOM over a locally built OpenStreetMap layer", () => {
	it("records the layer's own license expression, credit and input file beside the release's bundles", () => {
		const document = buildDataBOM({
			mailwomanVersion: "10.6.0",
			snapshot: { measuredAt: "2026-10-17T00:00:00.000Z", bucket: "https://example.org/", bundles: [] },
			inventory: INVENTORY,
		})

		const component = document.components.find((entry) => entry.name === OSM_PATH)

		expect(component?.licenses).toEqual([{ expression: "ODbL-1.0" }])

		const properties = Object.fromEntries((component?.properties ?? []).map((entry) => [entry.name, entry.value]))

		expect(properties).toMatchObject({
			"mailwoman:licenseBasis": LicenseBasis.ArtifactManifest,
			"mailwoman:tier": "build-local",
			"mailwoman:attribution": "© OpenStreetMap contributors",
			"mailwoman:source": "openstreetmap:nz",
			"mailwoman:sourceURL": "https://download.geofabrik.de/australia-oceania/new-zealand-latest.osm.pbf",
			"mailwoman:sourceSHA256": "e".repeat(64),
		})

		// The layer is reported independently: no bundle component claims its path.
		expect(document.components.filter((entry) => entry.name === OSM_PATH)).toHaveLength(1)
	})
})

const SOURCE_BASE: Omit<MixedLayerSource, "source" | "deciding" | "basis" | "statement" | "obligationClass"> = {
	records: 10,
	regions: ["us-fl"],
	recordedLicense: null,
	openAddresses: null,
	rows: [],
	publisher: null,
	termsURL: null,
	spdx: null,
	attribution: "none",
	shareAlike: "none",
	attributionText: null,
}

const row = (registerSource: string, statement: "terms" | "no-statement") => ({
	registerSource,
	publisher: registerSource,
	licenseID: registerSource,
	decision: "elected" as const,
	basis: RegisterTermsBasis.NoRestrictingTerms,
	spdx: null,
	electedTerms: "US factual data published without a use restriction",
	statement,
	termsURL: `https://example.org/${registerSource}`,
	retrievedCopy: null,
	because: "Read.",
})

const MIXED: DataBOMMixedLayer = {
	readFrom: "https://example.org/",
	noticePresent: false,
	description: {
		id: "addresses-us",
		license: "LicenseRef-US-Mixed",
		country: "US",
		version: "2026-11-13",
		manifestPath: "addresses/us/2026-11-13/manifest.json",
		noticePath: "addresses/us/2026-11-13/NOTICE.txt",
		regions: 1,
		records: 30,
		sources: [
			{
				...SOURCE_BASE,
				source: "openaddresses:us/ca/marin",
				rows: [row("marin", "terms")],
				deciding: row("marin", "terms"),
				basis: RegisterTermsBasis.NoRestrictingTerms,
				statement: "terms",
				obligationClass: ObligationClass.None,
			},
			{
				...SOURCE_BASE,
				source: "openaddresses:us/fl/alachua",
				rows: [row("alachua", "no-statement")],
				deciding: row("alachua", "no-statement"),
				termsURL: "https://example.org/alachua",
				basis: RegisterTermsBasis.NoRestrictingTerms,
				statement: "no-statement",
				obligationClass: ObligationClass.None,
			},
			{
				...SOURCE_BASE,
				source: "openaddresses:us/fl/unmapped",
				deciding: null,
				basis: RegisterTermsBasis.Unregistered,
				statement: null,
				attribution: "unknown",
				shareAlike: "unknown",
				obligationClass: ObligationClass.Unknown,
			},
		],
	},
}

describe("buildDataBOM over a mixed layer", () => {
	const document = buildDataBOM({
		mailwomanVersion: "11.2.0",
		snapshot: { measuredAt: "2026-10-31T00:00:00.000Z", bucket: "https://example.org/", bundles: [] },
		mixedLayers: [MIXED],
	})

	const layer = document.components.find((entry) => entry["bom-ref"] === "layer/addresses-us/2026-11-13")!
	const props = (component: DataBOMComponent) => Object.fromEntries(component.properties.map((p) => [p.name, p.value]))

	it("nests one component per source under the layer, an uncovered source included", () => {
		expect(layer.licenses).toEqual([{ expression: "LicenseRef-US-Mixed" }])
		expect(layer.components?.map((entry) => entry.name)).toEqual(MIXED.description.sources.map((s) => s.source))

		const unmapped = layer.components!.find((entry) => entry.name === "openaddresses:us/fl/unmapped")!

		expect(unmapped.licenses).toEqual([{ expression: "NOASSERTION" }])

		expect(props(unmapped)).toMatchObject({
			"mailwoman:registerDecision": "uncovered",
			"mailwoman:registerUncovered": "the source table maps this source to no register row",
			"mailwoman:attribution": "unknown",
		})
	})

	it("keeps a page that stated nothing apart from terms read and found not to restrict", () => {
		const [marin, alachua] = layer.components!

		expect(props(marin!)["mailwoman:termsStatement"]).toBe("terms")
		expect(props(alachua!)["mailwoman:termsStatement"]).toBe("no-statement")
		expect(alachua!.externalReferences).toEqual([{ type: "license", url: "https://example.org/alachua" }])
	})

	it("says where to write the notice when it is absent, rather than linking a file that is not there", () => {
		expect(layer.externalReferences?.map((entry) => entry.type)).toEqual(["distribution"])

		expect(props(layer)["mailwoman:attributionNoticeAbsent"]).toContain(
			"situs attribution-manifest --layer-version 2026-11-13"
		)
	})

	it("is the same bytes on a second build", () => {
		const again = buildDataBOM({
			mailwomanVersion: "11.2.0",
			snapshot: { measuredAt: "2026-10-31T00:00:00.000Z", bucket: "https://example.org/", bundles: [] },
			mixedLayers: [MIXED],
		})

		expect(serializeDataBOM(again)).toBe(serializeDataBOM(document))
	})
})
