/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `sampleAddressPoints` draws the rows the Python sampler (`corpora/address_points.py`) drew from the same
 *   table and seed, recorded below before the Python module was deleted.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { type AddressPointDatabase, createAddressPointTable } from "@mailwoman/resolver-wof-sqlite/address/point/schema"
import type { NameKey, RouteKey, StreetKey } from "@mailwoman/resolver-wof-sqlite/street/normalize"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { describe, expect, it } from "vitest"

import { sampleAddressPoints } from "#recipes/address-points"
import { PyRandom } from "#training/pyrandom"

const FIXTURE_ROWS = 60

/**
 * Sixty rows, one in seven without a postcode, two sources, and rowids 10 to 19 deleted so probes miss.
 */
async function writeFixture(path: string): Promise<void> {
	const db = new DatabaseClient<AddressPointDatabase>(path)

	try {
		await createAddressPointTable(db)

		for (let i = 1; i <= FIXTURE_ROWS; i++) {
			await db
				.insertInto("address_point")
				.values({
					street_norm: `rue ${i}` as StreetKey,
					street_key: `rue ${i}` as RouteKey,
					number: String(i),
					unit: null,
					postcode: i % 7 === 0 ? null : `750${i}`,
					locality_norm: (i % 2 ? "paris" : "lyon") as NameKey,
					street_raw: `Rue ${i}`,
					lat: 0,
					lon: 0,
					source: i % 3 === 0 ? "b" : "a",
					release: "test",
					admin_code: null,
					certified: null,
				})
				.execute()
		}

		await db
			.deleteFrom("address_point")
			.where("number", "in", ["10", "11", "12", "13", "14", "15", "16", "17", "18", "19"])
			.execute()
	} finally {
		await db.destroy()
	}
}

const row = (n: number, locality: string) => [`rue ${n}`, String(n), `750${n}`, locality]

/**
 * What `sample_address_points(path, 12, random.Random(7))` returned on CPython 3.12.3 over this fixture.
 */
const PYTHON_ALL = [
	row(26, "lyon"),
	row(4, "lyon"),
	row(5, "paris"),
	row(53, "paris"),
	row(24, "lyon"),
	row(38, "lyon"),
	row(59, "paris"),
	row(33, "paris"),
	row(3, "paris"),
	row(6, "lyon"),
	row(27, "paris"),
	row(36, "lyon"),
]

/**
 * The same call with `sources={"a"}`.
 */
const PYTHON_SOURCE_A = [
	row(26, "lyon"),
	row(4, "lyon"),
	row(5, "paris"),
	row(53, "paris"),
	row(38, "lyon"),
	row(59, "paris"),
	row(37, "paris"),
	row(8, "lyon"),
	row(41, "paris"),
	row(55, "paris"),
	row(20, "lyon"),
	row(44, "lyon"),
]

/**
 * `sample_address_points(path, 60, random.Random(3), probe_budget=1)`: the budget runs out after 60 probes.
 */
const PYTHON_ONE_PROBE = [
	[38, "lyon"],
	[9, "paris"],
	[24, "lyon"],
	[59, "paris"],
	[39, "paris"],
	[31, "paris"],
	[41, "paris"],
	[5, "paris"],
	[1, "paris"],
	[54, "lyon"],
	[36, "lyon"],
	[46, "lyon"],
	[26, "lyon"],
	[60, "lyon"],
	[34, "lyon"],
	[25, "paris"],
	[48, "lyon"],
	[43, "paris"],
	[50, "lyon"],
	[3, "paris"],
	[20, "lyon"],
	[2, "lyon"],
	[53, "paris"],
	[47, "paris"],
	[57, "paris"],
	[51, "paris"],
].map(([n, locality]) => row(n as number, locality as string))

describe("sampleAddressPoints", () => {
	it("draws the Python sampler's rows, with and without a source filter", async () => {
		await using scratch = await temporaryDirectory("mailwoman-address-points-")
		const path = scratch.path("address-points.db").toString()

		await writeFixture(path)

		expect(await sampleAddressPoints(path, 12, new PyRandom(7))).toEqual(PYTHON_ALL)

		expect(await sampleAddressPoints(path, 12, new PyRandom(7), { sources: new Set(["a"]) })).toEqual(PYTHON_SOURCE_A)

		expect(await sampleAddressPoints(path, 60, new PyRandom(3), { probeBudget: 1 })).toEqual(PYTHON_ONE_PROBE)
	})

	it("names the path of a missing database", async () => {
		await using scratch = await temporaryDirectory("mailwoman-address-points-")
		const path = scratch.path("absent.db").toString()

		await expect(sampleAddressPoints(path, 1, new PyRandom(0))).rejects.toThrow(path)
	})
})
