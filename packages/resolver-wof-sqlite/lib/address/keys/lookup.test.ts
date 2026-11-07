/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { LayerFreshnessPolicy, LayerTier } from "@mailwoman/core/layers"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { describe, expect, it } from "vitest"

import { buildAddressLayer } from "#address/keys/build"
import { localAddressStatementRunner } from "#address/keys/local-runner"
import { AddressKeyLookup } from "#address/keys/lookup"
import { AddressNameForm, type AddressRecord } from "#address/record"
import { canonicalizeRouteKey, normalizeLocalityForKey, normalizeStreetForKey } from "#street/normalize"

function record(
	number: string,
	streetRaw: string,
	postcode: string | null,
	locality: string,
	lat: number
): AddressRecord {
	const streetKey = normalizeStreetForKey(streetRaw)

	const name = (level: "locality" | "subregion", form: AddressNameForm, value: string) => ({
		level,
		form,
		value,
		key: normalizeLocalityForKey(value),
	})

	return {
		source: "usgov-nad",
		sourceRecordID: `nad-${number}-${lat}`,
		country: "US",
		subdivision: "US-WI",
		number,
		unit: null,
		streetRaw,
		streetKey,
		routeKey: canonicalizeRouteKey(streetKey),
		postcode,
		names: [
			name("subregion", AddressNameForm.Written, "Milwaukee"),
			name("locality", AddressNameForm.Written, locality),
		],
		adminCode: null,
		lat,
		lon: -87.9,
		placement: null,
		authority: null,
	}
}

async function* stream(records: AddressRecord[]) {
	yield* records
}

async function lookupOver(records: AddressRecord[]) {
	const dir = await temporaryDirectory("address-lookup-")

	await buildAddressLayer({
		records: stream(records),
		sources: new Map([["usgov-nad", { license: "public-domain", authority: null }]]),
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
			createdAt: "2026-11-07T00:00:00Z",
		},
		lookupPath: dir.path("lookup.db"),
		detailPath: dir.path("detail.db"),
	})

	const db = new DatabaseClient<unknown>(dir.path("lookup.db"), { readOnly: true })

	return { dir, db, lookup: new AddressKeyLookup(localAddressStatementRunner(db), { country: "US" }) }
}

describe("AddressKeyLookup", () => {
	it("answers at the most precise level the parse states, and falls back level by level", async () => {
		const { dir, db, lookup } = await lookupOver([
			record("3200", "N Downer Ave", "53211", "Milwaukee", 43.07),
			record("6840", "Blanchard St", null, "Wauwatosa", 43.05),
		])

		await using _dir = dir
		using _db = db

		expect(await lookup.find({ street: "North Downer Avenue", number: "3200", postcode: "53211-3333" })).toMatchObject({
			level: "postcode",
			hits: [{ lat: 43.07 }],
		})

		// A wrong postcode falls to the stated locality, and an unknown locality to the county.
		expect(
			await lookup.find({
				street: "Blanchard Street",
				number: "6840",
				postcode: "53213",
				localities: ["Milwaukee", "Wauwatosa"],
			})
		).toMatchObject({ level: "locality", hits: [{ lat: 43.05 }] })

		expect(
			await lookup.find({ street: "Blanchard St", number: "6840", localities: ["Milwaukee"], subregion: "Milwaukee" })
		).toMatchObject({ level: "subregion" })

		expect(await lookup.find({ street: "Blanchard St", number: "6840" })).toMatchObject({ level: "region" })
		expect(await lookup.find({ street: "Blanchard St", number: "9999" })).toBeNull()
		expect(await lookup.find({ street: "", number: "6840" })).toBeNull()
	})

	it("finds a grid number written without its spacing, and a street written with another type spelling", async () => {
		// Adapters store a number lower-cased, as `nadAddressRecord` does.
		const { dir, db, lookup } = await lookupOver([record("n 3971", "Sunny Slope Ave", "53011", "Cascade", 43.6)])

		await using _dir = dir
		using _db = db

		expect(await lookup.find({ street: "Sunny Slope Avenue", number: "N3971", postcode: "53011" })).toMatchObject({
			level: "postcode",
		})
	})

	it("returns every namesake row under one key, up to the row cap", async () => {
		const { dir, db, lookup } = await lookupOver([
			record("10", "Main St", "53001", "Adell", 43.6),
			record("10", "Main St", "53002", "Allenton", 43.4),
			record("10", "Main St", "53003", "Ashippun", 43.2),
		])

		await using _dir = dir
		using _db = db

		const answer = await lookup.find({ street: "Main St", number: "10" })

		expect(answer?.level).toBe("region")
		expect(answer?.hits.map((hit) => hit.lat).toSorted()).toEqual([43.2, 43.4, 43.6])
	})
})
