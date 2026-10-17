/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { LayerManifest } from "@mailwoman/core/layers"
import { describe, expect, it } from "vitest"

import { assertLayerObligationsAccepted, obligationFindings, ObligationRefusal, parseObligationRefusals } from "#data"

describe("parseObligationRefusals", () => {
	it("reads repeated flags and a comma-separated variable alike, once each", () => {
		expect(parseObligationRefusals(["share-alike,unresolved", "share-alike"])).toEqual([
			ObligationRefusal.ShareAlike,
			ObligationRefusal.Unresolved,
		])
	})

	it("reads an empty variable as no refusal", () => {
		expect(parseObligationRefusals([""])).toEqual([])
	})

	it("refuses an unknown class rather than ignoring it", () => {
		expect(() => parseObligationRefusals(["share-alike", "copyleft"])).toThrow(/unknown obligation class "copyleft"/)
	})
})

describe("obligationFindings", () => {
	it("names the identifier that carries share-alike, not the expression as a whole", () => {
		const findings = obligationFindings("ODbL-1.0 AND CDLA-Permissive-2.0 AND CC-BY-4.0", [
			ObligationRefusal.ShareAlike,
		])

		expect(findings).toEqual([
			{ refusal: ObligationRefusal.ShareAlike, identifier: "ODbL-1.0", reason: "ODbL-1.0 carries share-alike" },
		])
	})

	it("names an identifier whose obligations are unrecorded under the unresolved class", () => {
		const findings = obligationFindings("LicenseRef-USGov-Public-Domain AND LicenseRef-OpenAddresses-PerSource", [
			ObligationRefusal.Unresolved,
		])

		expect(findings.map((finding) => finding.identifier)).toEqual(["LicenseRef-OpenAddresses-PerSource"])
	})

	it("finds no share-alike in an unresolved identifier, because its obligations are unknown rather than known", () => {
		expect(obligationFindings("LicenseRef-OpenAddresses-PerSource", [ObligationRefusal.ShareAlike])).toEqual([])
	})

	it("finds no identifier when no class is refused", () => {
		expect(obligationFindings("ODbL-1.0", [])).toEqual([])
	})
})

describe("assertLayerObligationsAccepted", () => {
	const manifest: LayerManifest = {
		name: "osm-address-points-nz-nz",
		version: "260806",
		schemaVersion: 1,
		tier: "build-local",
		license: "ODbL-1.0",
		attribution: "© OpenStreetMap contributors",
		source: "openstreetmap:nz",
		sourceVintage: "2026-08-06",
		buildCmd: "node packages/osm/tools/build-rooftop-database.ts",
		buildSHA: "fixture",
		freshnessPolicy: "sealed",
		spineKeys: { h3: { column: "h3_cell", resolution: 9 } },
		createdAt: "2026-08-07T00:00:00.000Z",
		sourceRecords: null,
		sourceURL: "https://download.geofabrik.de/australia-oceania/new-zealand-latest.osm.pbf",
		sourceSHA256: "d".repeat(64),
	}

	const path = "/data/db/osm/address-points-nz-nz.db"

	it("refuses an ODbL layer under a share-alike refusal and repeats its provenance in the message", () => {
		const refuse = () => assertLayerObligationsAccepted(manifest, path, [ObligationRefusal.ShareAlike])

		expect(refuse).toThrow(/ODbL-1\.0 carries share-alike/)
		expect(refuse).toThrow(/osm-address-points-nz-nz at \/data\/db\/osm\/address-points-nz-nz\.db/)
		expect(refuse).toThrow(/credit © OpenStreetMap contributors/)
		expect(refuse).toThrow(/new-zealand-latest\.osm\.pbf sha256 d{64}/)
	})

	it("accepts the layer when no refused class applies", () => {
		expect(() => assertLayerObligationsAccepted(manifest, path, [])).not.toThrow()
		expect(() => assertLayerObligationsAccepted(manifest, path, [ObligationRefusal.Unresolved])).not.toThrow()
	})
})
