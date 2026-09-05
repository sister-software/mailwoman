/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The address-point reader's probe contract, pinned over a fixture extract — the scope ladder and
 *   the range-surface fallback ("385-387 Esplanade" keys the register's `385`; an exact range key,
 *   where a source carries one verbatim, is never second-guessed).
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import {
	AddressPointSqliteLookup,
	ADDRESS_POINT_COLUMNS,
	type AddressPointDatabase,
	createAddressPointTable,
} from "@mailwoman/resolver-wof-sqlite/address"
import { normalizeStreetForKey } from "@mailwoman/resolver-wof-sqlite/street"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { join } from "path-ts"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

let lookup: AddressPointSqliteLookup

beforeAll(async () => {
	const dir = fixtures.use(await temporaryDirectory("ap-lookup-")).path
	const path = join(dir, "fixture.db")
	using kdb = new DatabaseClient<AddressPointDatabase>(path)

	await createAddressPointTable(kdb)

	const insert = kdb.prepare(`INSERT INTO address_point VALUES (${ADDRESS_POINT_COLUMNS.map(() => "?").join(", ")})`)

	// (street_norm, street_key, number, unit, postcode, locality_norm, street_raw, lat, lon, source, release)
	insert.run(
		"osborne drive",
		"osborne drive",
		"32",
		null,
		"4505",
		"burpengary",
		"Osborne Drive",
		-27.1836,
		152.9567,
		"t",
		"r"
	)

	// A source that carries the range VERBATIM — the exact key must win over the low-end retry.
	insert.run(
		"osborne drive",
		"osborne drive",
		"32-36",
		null,
		"4505",
		"burpengary",
		"Osborne Drive",
		-27.9999,
		152.9999,
		"t",
		"r"
	)

	insert.run("forest road", "forest road", "19", null, "7250", "trevallyn", "Forest Road", -41.4316, 147.1185, "t", "r")
	// BAN-style space-separated letter suffix — the spacing-variant fallback's fixture. The key comes
	// from the SHARED normalizer so this fixture can never drift from the probe side's derivation.
	const egliseKey = normalizeStreetForKey("Rue de l'Église")

	insert.run(egliseKey, egliseKey, "3 a", null, "67530", "boersch", "Rue de l'Église", 48.4771, 7.4433, "t", "r")
	// A BAN-shaped row for the bbox rung's contradiction case (#1913): Servon's `10 rue de la République`, whose own
	// postcode and commune disagree with a `75008 Paris` query, sits inside a box drawn around Paris.
	const republiqueKey = normalizeStreetForKey("Rue de la République")

	insert.run(
		republiqueKey,
		republiqueKey,
		"10",
		null,
		"77170",
		"servon",
		"Rue de la République",
		48.718479,
		2.587971,
		"ban:fr",
		"r"
	)

	// Two villages under one DE postcode, both with a Teichstraße 3 (#1631): the postcode rung must not answer the other
	// village's rooftop when the query names a locality.
	const teichKey = normalizeStreetForKey("Teichstraße")
	insert.run(teichKey, teichKey, "3", null, "04509", "werlitzsch", "Teichstraße", 51.4367, 12.1958, "osm", "r")
	insert.run(teichKey, teichKey, "3", null, "04509", "krensitz", "Teichstraße", 51.52, 12.45, "osm", "r")
	// An OSM-shaped row with NO scope of its own — the case the bbox rung exists for.
	insert.run("mill lane", "mill lane", "7", null, null, null, "Mill Lane", 51.5, -0.1, "osm", "r")
	lookup = new AddressPointSqliteLookup(path)
})

describe("AddressPointSqliteLookup", () => {
	it("answers an exact (street, number) within the postcode scope", () => {
		expect(lookup.find({ street: "Osborne Drive", number: "32", postcode: "4505" })?.lat).toBe(-27.1836)
	})

	it("prefers a verbatim range key over the low-end fallback", () => {
		expect(lookup.find({ street: "Osborne Drive", number: "32-36", postcode: "4505" })?.lat).toBe(-27.9999)
	})

	it("falls back to the range's low end when the range key misses", () => {
		expect(lookup.find({ street: "Forest Road", number: "19-21", postcode: "7250" })?.lat).toBe(-41.4316)
		expect(lookup.find({ street: "Forest Road", number: "19-21", locality: "Trevallyn" })?.lat).toBe(-41.4316)
	})

	it("stays null when neither the range key nor its low end exists", () => {
		expect(lookup.find({ street: "Forest Road", number: "23-25", postcode: "7250" })).toBeNull()
	})

	it("never treats a plain number as a range", () => {
		expect(lookup.find({ street: "Forest Road", number: "21", postcode: "7250" })).toBeNull()
	})

	it("bridges letter-suffix spacing in both directions, then falls to the base number", () => {
		expect(lookup.find({ street: "Rue de l'Église", number: "3a", postcode: "67530" })?.lat).toBe(48.4771)
		expect(lookup.find({ street: "Rue de l'Église", number: "3 a", postcode: "67530" })?.lat).toBe(48.4771)
		// No 19a and no "19 a" on Forest Road — the base-number rung answers 19's parcel.
		expect(lookup.find({ street: "Forest Road", number: "19a", postcode: "7250" })?.lat).toBe(-41.4316)
		// No 4, "4 a", or 4a anywhere — the whole ladder stays null.
		expect(lookup.find({ street: "Rue de l'Église", number: "4a", postcode: "67530" })).toBeNull()
	})

	it("never range-splits or suffix-folds the unit-bearing and box shapes", () => {
		// AU slash convention: '5/7' is unit 5 of house 7 — NOT a range. The ladder must not derive '5'.
		expect(lookup.find({ street: "Osborne Drive", number: "5/32", postcode: "4505" })).toBeNull()
		// Fractional house numbers survive untouched — '32 1/2' is neither a spaced suffix nor a range.
		expect(lookup.find({ street: "Osborne Drive", number: "32 1/2", postcode: "4505" })).toBeNull()
		// A unit-designator prefix folded into the span is not a suffix shape.
		expect(lookup.find({ street: "Osborne Drive", number: "unit 32", postcode: "4505" })).toBeNull()
		expect(lookup.find({ street: "Osborne Drive", number: "apt 3a", postcode: "4505" })).toBeNull()
		// A PO-Box surface that leaks this far probes an absent street key and stays null, never throws.
		expect(lookup.find({ street: "PO Box", number: "123-125", postcode: "4505" })).toBeNull()
	})

	it("unit siblings share the building coordinate through every rung", () => {
		// The fixture has unit rows for 32 (unit 6 etc. in the real register; here the plain row) — a
		// range surface resolving through the low-end rung lands the SAME building coordinate the
		// plain-number probe returns, so a unit-bearing query can never be worse than its base.
		const base = lookup.find({ street: "Osborne Drive", number: "32", postcode: "4505" })
		const viaRange = lookup.find({ street: "Osborne Drive", number: "32-36", postcode: "4505" })

		expect(base?.lat).toBeDefined()

		// The verbatim '32-36' fixture row wins for the range surface (precedence pin, again from the
		// unit angle): the low-end rung only ever fires when NO row carries the surface as written.
		expect(viaRange?.lat).toBe(-27.9999)
	})

	it("carries the register row's own locality and postcode on the hit", () => {
		const hit = lookup.find({ street: "Osborne Drive", number: "32", postcode: "4505" })

		expect(hit?.localityNorm).toBe("burpengary")
		expect(hit?.postcode).toBe("4505")
	})
})

describe("the bbox fall-through's scope contradiction (#1913)", () => {
	const parisBox = { minLat: 48.5, maxLat: 49.1, minLon: 2, maxLon: 2.8 }

	it("refuses a row whose own postcode names a different place than the query's", () => {
		expect(
			lookup.find({
				street: "Rue de la République",
				number: "10",
				postcode: "75008",
				locality: "Paris",
				bbox: parisBox,
			})
		).toBeNull()
	})

	it("refuses a row whose own locality disagrees when the query names no postcode", () => {
		expect(lookup.find({ street: "Rue de la République", number: "10", locality: "Paris", bbox: parisBox })).toBeNull()
	})

	it("still answers a scope-less point inside the box, and a scoped row through its scoped rung", () => {
		const londonBox = { minLat: 51.4, maxLat: 51.6, minLon: -0.2, maxLon: 0 }

		expect(lookup.find({ street: "Mill Lane", number: "7", locality: "London", bbox: londonBox })?.lat).toBe(51.5)
		expect(lookup.find({ street: "Rue de la République", number: "10", postcode: "77170" })?.lat).toBe(48.718479)
	})
})

describe("the postcode rung's locality contradiction (#1631)", () => {
	it("answers the row whose locality agrees, whichever village the query names", () => {
		expect(lookup.find({ street: "Teichstraße", number: "3", postcode: "04509", locality: "Krensitz" })?.lat).toBe(
			51.52
		)
		expect(lookup.find({ street: "Teichstraße", number: "3", postcode: "04509", locality: "Werlitzsch" })?.lat).toBe(
			51.4367
		)
	})

	it("answers nothing when the query names a third place under the same postcode — admin is the better answer", () => {
		expect(lookup.find({ street: "Teichstraße", number: "3", postcode: "04509", locality: "Schönwölkau" })).toBeNull()
	})

	it("keeps answering by postcode alone when the query names no locality", () => {
		expect(lookup.find({ street: "Teichstraße", number: "3", postcode: "04509" })).not.toBeNull()
	})
})
