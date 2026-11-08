/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { LayerFreshnessPolicy, LayerTier } from "@mailwoman/core/layers"
import { buildAddressLayer } from "@mailwoman/resolver-wof-sqlite/address/keys/build"
import { addressLayerFiles } from "@mailwoman/resolver-wof-sqlite/address/keys/layout"
import { AddressNameForm, type AddressRecord } from "@mailwoman/resolver-wof-sqlite/address/record"
import {
	canonicalizeRouteKey,
	normalizeLocalityForKey,
	normalizeStreetForKey,
} from "@mailwoman/resolver-wof-sqlite/street/normalize"
import { describe, expect, it } from "vitest"

import { addressPairSample, AddressPairStratum } from "#tools/address-pairs/sample"

function record(
	source: string,
	id: string,
	number: string,
	unit: string | null,
	postcode: string,
	lat: number,
	lon = -87.9
): AddressRecord {
	const streetKey = normalizeStreetForKey("Main Street")

	return {
		source,
		sourceRecordID: id,
		country: "US",
		subdivision: "US-WI",
		number,
		unit,
		streetRaw: "Main Street",
		streetKey,
		routeKey: canonicalizeRouteKey(streetKey),
		postcode,
		names: [
			{
				level: "locality",
				form: AddressNameForm.Written,
				value: "Milwaukee",
				key: normalizeLocalityForKey("Milwaukee"),
			},
		],
		adminCode: null,
		lat,
		lon,
		placement: null,
		authority: null,
	}
}

async function* stream(records: AddressRecord[]) {
	yield* records
}

describe("addressPairSample", () => {
	it("pairs each lower-ranked row with each higher-ranked row of its key group and assigns one stratum per pair", async () => {
		await using dir = await temporaryDirectory("address-pair-sample-")
		const files = addressLayerFiles(dir.path(), "us-wi", "test")
		const run = "openaddresses:us/wi/statewide"
		const copy = "overture:OpenAddresses/WI/Statewide"

		await buildAddressLayer({
			records: stream([
				record("usgov-nad", "n1", "1", null, "53202", 43.04),
				record(run, "o1", "1", null, "53202", 43.0401),
				record("usgov-nad", "n2", "2", "UNIT 2", "53202", 43.05),
				record(copy, "c2", "2", "#2", "53202", 43.05),
				record("usgov-nad", "n3", "3", null, "53202", 43.06),
				record(run, "o3", "3", "A", "53202", 43.06),
				record("usgov-nad", "n4", "4", null, "53202", 43.07),
				record(run, "o4", "4", null, "53202", 43.09),
				record("usgov-nad", "n5", "5", null, "53202", 43.08),
				record(run, "o5", "5", null, "53203", 43.0801),
			]),
			sources: new Map([
				["usgov-nad", { license: "public-domain", authority: null }],
				[run, { license: null, authority: null }],
				[copy, { license: null, authority: null }],
			]),
			manifest: {
				name: "addresses-us-wi",
				version: "test",
				tier: LayerTier.Shipped,
				license: "CC0-1.0",
				attribution: null,
				source: "fixture",
				sourceVintage: "test",
				buildCmd: "vitest",
				buildSHA: "0000000",
				freshnessPolicy: LayerFreshnessPolicy.Sealed,
				createdAt: "2026-11-08T00:00:00Z",
			},
			lookupPath: files.lookup,
			detailPath: files.detail,
		})

		const { pairs } = await addressPairSample({
			root: dir.path(),
			version: "test",
			regions: ["us-wi"],
			rowsPerRegion: 1000,
		})

		const byPair = Object.fromEntries(
			pairs.map((pair) => [`${pair.higher.sourceRecordID}-${pair.lower.sourceRecordID}`, pair])
		)

		expect(byPair["n1-o1"]).toMatchObject({ stratum: AddressPairStratum.Coincident, ruleDrops: true })
		expect(byPair["n2-c2"]).toMatchObject({ stratum: AddressPairStratum.UnitSpelling, ruleDrops: false })
		expect(byPair["n2-c2"]?.lower.unitIdentifier).toBe("2")
		expect(byPair["n3-o3"]).toMatchObject({ stratum: AddressPairStratum.UnitAgainstNone, ruleDrops: false })
		expect(byPair["n4-o4"]).toMatchObject({ stratum: AddressPairStratum.Distant, ruleDrops: false })
		expect(byPair["n5-o5"]).toMatchObject({ stratum: AddressPairStratum.PostcodeDiffers, ruleDrops: false })
		expect(pairs.every((pair) => pair.adjudication === null)).toBe(true)
	})
})
