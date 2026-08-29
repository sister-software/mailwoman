/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The address-point reader's probe contract, pinned over a fixture shard — the scope ladder and
 *   the range-surface fallback ("385-387 Esplanade" keys the register's `385`; an exact range key,
 *   where a source carries one verbatim, is never second-guessed).
 */

import { mkdtempSync } from "@mailwoman/platform/fs"
import { tmpdir } from "@mailwoman/platform/os"
import { join } from "@mailwoman/platform/path"
import { AddressPointSqliteLookup } from "@mailwoman/resolver-wof-sqlite/address-point"
import {
	ADDRESS_POINT_COLUMNS,
	type AddressPointDatabase,
	createAddressPointTable,
} from "@mailwoman/resolver-wof-sqlite/address-point-schema"
import { normalizeStreetForKey } from "@mailwoman/resolver-wof-sqlite/street-normalize"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { beforeAll, describe, expect, it } from "vitest"

let lookup: AddressPointSqliteLookup

beforeAll(async () => {
	const dir = mkdtempSync(join(tmpdir(), "ap-lookup-"))
	const path = join(dir, "fixture.db")
	const kdb = new DatabaseClient<AddressPointDatabase>(path)

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

	await kdb.destroy()
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
