/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The `capital` table round-trip (#1880's distribution home): what the builder writes, the reader returns; a
 *   pre-table artifact answers NULL (fall through to the repo file), never an empty list; malformed rows are skipped
 *   rather than crashing a session open.
 */

import type { CandidateDatabase } from "@mailwoman/resolver-wof-sqlite/candidate-schema"
import { type CapitalTable, createCapitalTable, readCapitalPoints } from "@mailwoman/resolver-wof-sqlite/capital-schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { describe, expect, it } from "vitest"

async function openWithTable(): Promise<DatabaseClient<CandidateDatabase>> {
	const kdb = new DatabaseClient<CandidateDatabase>(":memory:")

	await createCapitalTable<CandidateDatabase>(kdb)

	return kdb
}

describe("capital table round-trip", () => {
	it("returns what the builder wrote, keys parsed", async () => {
		await using db = await openWithTable()

		db.prepare("INSERT INTO capital (country, latitude, longitude, level, keys) VALUES (?, ?, ?, ?, ?)").run(
			"CR",
			9.9333,
			-84.0833,
			"national",
			JSON.stringify(["san jose", "chepe"])
		)

		expect(readCapitalPoints(db)).toEqual([
			{ country: "CR", latitude: 9.9333, longitude: -84.0833, level: "national", k: ["san jose", "chepe"] },
		])
	})

	it("answers NULL — not an empty list — on an artifact that predates the table", () => {
		using db = new DatabaseClient<CandidateDatabase>(":memory:")

		expect(readCapitalPoints(db)).toBeNull()
	})

	it("skips a row with an unknown level or unparseable keys instead of crashing the session open", async () => {
		await using db = await openWithTable()
		const insert = db.prepare("INSERT INTO capital (country, latitude, longitude, level, keys) VALUES (?, ?, ?, ?, ?)")

		insert.run("XX", 0, 0, "county-seat", JSON.stringify(["x"]))
		insert.run("YY", 0, 0, "national", "not json")
		insert.run("GD", 12.0529, -61.7523, "national", JSON.stringify(["saint george s", "st georges"]))

		const points = readCapitalPoints(db)

		expect(points).toHaveLength(1)
		expect(points![0]!.country).toBe("GD")
	})
})
