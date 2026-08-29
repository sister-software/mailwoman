/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The `capital` table round-trip (#1880's distribution home): what the builder writes, the reader returns; a
 *   pre-table artifact answers NULL (fall through to the repo file), never an empty list; malformed rows are skipped
 *   rather than crashing a session open.
 */

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { DatabaseSync } from "@mailwoman/platform/sqlite"
import { type CapitalTable, createCapitalTable, readCapitalPoints } from "@mailwoman/resolver-wof-sqlite/capital-schema"
import { describe, expect, it } from "vitest"

async function openWithTable(): Promise<DatabaseSync> {
	const db = new DatabaseSync(":memory:")
	const kdb = new DatabaseClient<{ capital: CapitalTable }>({ database: db })

	await createCapitalTable(kdb)

	return db
}

describe("capital table round-trip", () => {
	it("returns what the builder wrote, keys parsed", async () => {
		const db = await openWithTable()

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

		db.close()
	})

	it("answers NULL — not an empty list — on an artifact that predates the table", () => {
		const db = new DatabaseSync(":memory:")

		expect(readCapitalPoints(db)).toBeNull()
		db.close()
	})

	it("skips a row with an unknown level or unparseable keys instead of crashing the session open", async () => {
		const db = await openWithTable()
		const insert = db.prepare("INSERT INTO capital (country, latitude, longitude, level, keys) VALUES (?, ?, ?, ?, ?)")

		insert.run("XX", 0, 0, "county-seat", JSON.stringify(["x"]))
		insert.run("YY", 0, 0, "national", "not json")
		insert.run("GD", 12.0529, -61.7523, "national", JSON.stringify(["saint george s", "st georges"]))

		const points = readCapitalPoints(db)

		expect(points).toHaveLength(1)
		expect(points![0]!.country).toBe("GD")
		db.close()
	})
})
