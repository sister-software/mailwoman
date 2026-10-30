/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `sampleAddressPoints` draws the rows recorded in `fixtures/builders/address-points/sample-reference.json` from
 *   the same table and seed.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { SeededRandom } from "@mailwoman/core/random"
import { type AddressPointDatabase, createAddressPointTable } from "@mailwoman/resolver-wof-sqlite/address/point/schema"
import type { NameKey, RouteKey, StreetKey } from "@mailwoman/resolver-wof-sqlite/street/normalize"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { describe, expect, it } from "vitest"

import { sampleAddressPoints } from "#recipes/address-points"
import { ReferenceFixture } from "#test-kit"

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

const REFERENCE = resolvePackagePath(
	"@mailwoman/corpus",
	"fixtures",
	"builders",
	"address-points",
	"sample-reference.json"
)

interface SampleReference {
	all: string[][]
	source_a: string[][]
	one_probe: string[][]
}

describe("sampleAddressPoints", async () => {
	const reference = await ReferenceFixture.read<SampleReference>(REFERENCE)

	it("draws the recorded rows, with and without a source filter", async () => {
		await using scratch = await temporaryDirectory("mailwoman-address-points-")
		const path = scratch.path("address-points.db").toString()

		await writeFixture(path)

		const all = await sampleAddressPoints(path, 12, new SeededRandom(7))
		const sourceA = await sampleAddressPoints(path, 12, new SeededRandom(7), { sources: new Set(["a"]) })
		// The budget of one probe per requested row runs out before 60 rows are found, so fewer come back.
		const oneProbe = await sampleAddressPoints(path, 60, new SeededRandom(3), { probeBudget: 1 })

		expect([all.length, sourceA.length]).toEqual([12, 12])
		expect(oneProbe.length).toBeLessThan(60)
		reference.expect("all", all)
		reference.expect("source_a", sourceA)
		reference.expect("one_probe", oneProbe)
		await reference.save()
	})

	it("names the path of a missing database", async () => {
		await using scratch = await temporaryDirectory("mailwoman-address-points-")
		const path = scratch.path("absent.db").toString()

		await expect(sampleAddressPoints(path, 1, new SeededRandom(0))).rejects.toThrow(path)
	})
})
