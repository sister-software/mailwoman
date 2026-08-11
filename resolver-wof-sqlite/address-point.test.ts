/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The address-point reader's probe contract, pinned over a fixture shard — the scope ladder and
 *   the range-surface fallback ("385-387 Esplanade" keys the register's `385`; an exact range key,
 *   where a source carries one verbatim, is never second-guessed).
 */

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { beforeAll, describe, expect, it } from "vitest"

import { ADDRESS_POINT_COLUMNS, type AddressPointDatabase, createAddressPointTable } from "./address-point-schema.ts"
import { AddressPointSqliteLookup } from "./address-point.ts"

let lookup: AddressPointSqliteLookup

beforeAll(async () => {
	const dir = mkdtempSync(join(tmpdir(), "ap-lookup-"))
	const path = join(dir, "fixture.db")
	const db = new DatabaseSync(path)
	const kdb = new DatabaseClient<AddressPointDatabase>({ database: db })

	await createAddressPointTable(kdb)

	const insert = db.prepare(`INSERT INTO address_point VALUES (${ADDRESS_POINT_COLUMNS.map(() => "?").join(", ")})`)

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
})
