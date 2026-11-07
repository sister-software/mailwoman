/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import type { CandidateDatabase } from "@mailwoman/resolver-wof-sqlite/candidate/schema"
import type { StreetTableDatabase } from "@mailwoman/resolver-wof-sqlite/street/table"
import { RangeStreetTable } from "@mailwoman/resolver-wof-wasm/httpvfs/street/table"
import { readStreetFromTable } from "@mailwoman/resolver-wof-wasm/remote/street"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { describe, expect, it } from "vitest"

import { buildStreetTable, type StreetNetworkEdge } from "#tools/pipeline/streets"

const edge = (
	name: string,
	startNode: string,
	endNode: string,
	lat: number,
	lon: number,
	alternateName: string | null = null
): StreetNetworkEdge => ({
	name,
	alternateName,
	startNode,
	endNode,
	start: { lat, lon },
	middle: { lat: lat + 0.0001, lon },
	end: { lat: lat + 0.0002, lon },
	meters: 22,
})

async function* stream(edges: StreetNetworkEdge[]) {
	yield* edges
}

/**
 * Builds a table from a small network in two towns, and returns a lookup over it.
 *
 * Town 1 spans 51 to 51.1, town 2 spans 53 to 53.1, and each holds a High Street.
 */
async function buildFixture(directory: Awaited<ReturnType<typeof temporaryDirectory>>) {
	const candidatePath = directory.path("candidate.db")

	{
		using db = new DatabaseClient<CandidateDatabase>(candidatePath)

		db.exec(
			`CREATE TABLE placetype_codes (id INTEGER, placetype TEXT);
			 CREATE TABLE country_codes (id INTEGER, code TEXT);
			 CREATE TABLE candidate (spr_id INTEGER, placetype_id INTEGER, country_id INTEGER, is_primary INTEGER,
			   min_lat REAL, max_lat REAL, min_lon REAL, max_lon REAL);
			 INSERT INTO placetype_codes VALUES (1, 'locality');
			 INSERT INTO country_codes VALUES (1, 'GB'), (2, 'FR');
			 INSERT INTO candidate VALUES (1, 1, 1, 1, 51, 51.1, -3, -2.9), (2, 1, 1, 1, 53, 53.1, -3, -2.9),
			   (3, 1, 2, 1, 51, 51.1, -3, -2.9);`
		)
	}

	const out = directory.path("streets.db")

	const counts = await buildStreetTable({
		edges: stream([
			edge("High Street", "a", "b", 51.05, -2.95),
			edge("High Street", "b", "c", 51.0502, -2.95),
			edge("Church Lane", "b", "d", 51.0502, -2.95),
			edge("Stryd Fawr", "x", "y", 53.05, -2.95, "High Street"),
			edge("Far Road", "m", "n", 60, 0),
		]),
		countries: ["GB"],
		out,
		candidatePath,
	})

	const db = new DatabaseClient<StreetTableDatabase>(out, { readOnly: true })

	const lookup = new RangeStreetTable({
		query: async <Row>(sql: string, parameters: readonly unknown[] = []) =>
			db.prepare(sql).all(...(parameters as string[])) as Row[],
		bytesRead: async () => 0,
	})

	return { counts, db, lookup }
}

describe("buildStreetTable", () => {
	it("merges same-named links through a shared node, and ties rows to the source's own country", async () => {
		await using directory = await temporaryDirectory("streets-")
		const { counts, db } = await buildFixture(directory)

		using _db = db

		expect(counts).toMatchObject({ places: 2, edges: 5, streets: 4, streetsWithoutPlace: 1, crossingNodes: 1 })

		const places = db.prepare("SELECT DISTINCT place_id FROM street_place ORDER BY 1").all() as Array<{
			place_id: number
		}>

		expect(places.map(({ place_id }) => place_id)).toEqual([1, 2])
	})

	it("reads a street by its place's id, under either of its names", async () => {
		await using directory = await temporaryDirectory("streets-")
		const { db, lookup } = await buildFixture(directory)

		using _db = db

		expect((await lookup.findStreets({ street: "High Street", places: [1] })).map(({ name }) => name)).toEqual([
			"High Street",
		])

		expect((await lookup.findStreets({ street: "High Street", places: [2] })).map(({ name }) => name)).toEqual([
			"Stryd Fawr",
		])
	})

	it("reads a crossing in either order, inside a place, and refuses the wrong place", async () => {
		await using directory = await temporaryDirectory("streets-")
		const { db, lookup } = await buildFixture(directory)

		using _db = db

		const hits = await lookup.findCrossings({ first: "Church Lane", second: "High Street", places: [1] })
		const reversed = await lookup.findCrossings({ first: "High Street", second: "Church Lane" })

		expect(hits).toHaveLength(1)
		expect(reversed).toEqual(hits)
		expect(await lookup.findCrossings({ first: "High Street", second: "Church Lane", places: [2] })).toEqual([])
	})
})

describe("readStreetFromTable", () => {
	it("lets a postcode's point choose among namesakes, and marks a place's namesakes in the answer", async () => {
		await using directory = await temporaryDirectory("streets-")
		const { db, lookup } = await buildFixture(directory)

		using _db = db

		const byPostcode = await readStreetFromTable(lookup, {
			street: "High Street",
			places: [],
			postcodePoint: { lat: 53.05, lon: -2.95 },
		})

		expect(byPostcode).toMatchObject({ name: "Stryd Fawr", basis: "postcode", alternatives: [] })
	})

	it("falls through to the place and reports the disagreement when a postcode reaches no street", async () => {
		await using directory = await temporaryDirectory("streets-")
		const { db, lookup } = await buildFixture(directory)

		using _db = db

		expect(
			await readStreetFromTable(lookup, {
				street: "High Street",
				places: [{ id: 1, lat: 51.05, lon: -2.95 }],
				postcodePoint: { lat: 40, lon: -2.95 },
			})
		).toMatchObject({ name: "High Street", basis: "place", postcodeDisagrees: true })

		expect(
			await readStreetFromTable(lookup, { street: "High Street", places: [], postcodePoint: { lat: 40, lon: -2.95 } })
		).toBeNull()
	})

	it("tries the deepest place first, then the area around a place the table does not hold", async () => {
		await using directory = await temporaryDirectory("streets-")
		const { db, lookup } = await buildFixture(directory)

		using _db = db

		expect(
			await readStreetFromTable(lookup, {
				street: "Church Lane",
				places: [
					{ id: 99, lat: 51.05, lon: -2.95 },
					{ id: 1, lat: 51.05, lon: -2.95 },
				],
			})
		).toMatchObject({ name: "Church Lane", basis: "place" })

		expect(
			await readStreetFromTable(lookup, { street: "Church Lane", places: [{ id: 99, lat: 51.05, lon: -2.95 }] })
		).toMatchObject({ name: "Church Lane", basis: "near_place" })

		expect(
			await readStreetFromTable(lookup, { street: "Church Lane", places: [{ id: 99, lat: 40, lon: -2.95 }] })
		).toBeNull()
	})
})
