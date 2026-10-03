import { DatabaseClient } from "@mailwoman/sqlite/client"
import { describe, expect, it } from "vitest"

import {
	clusterStreetSegments,
	createStreetSegmentIndexes,
	createStreetSegmentTable,
	STREET_SEGMENT_COLUMNS,
	STREET_SEGMENT_STAGE_TABLE,
	type StreetSegmentDatabase,
} from "#street/segment-schema"

type SegmentFixture = [street: string, postcode: string | null, min: number, max: number, side: string]

/**
 * Stage rows in the given order, cluster them, and index the result.
 */
async function buildClustered(rows: SegmentFixture[]): Promise<DatabaseClient<StreetSegmentDatabase>> {
	const db = DatabaseClient.temp<StreetSegmentDatabase>()

	await createStreetSegmentTable(db)
	await createStreetSegmentTable(db, STREET_SEGMENT_STAGE_TABLE)

	const insert = db.prepare(
		`INSERT INTO ${STREET_SEGMENT_STAGE_TABLE} (${STREET_SEGMENT_COLUMNS.join(", ")})
		 VALUES (${STREET_SEGMENT_COLUMNS.map(() => "?").join(", ")})`
	)

	for (const [street, postcode, min, max, side] of rows) {
		insert.run(street, side, min, max, min, max, "mixed", postcode, "06001", street, "[[0,0],[1,1]]", "test", "T")
	}

	await clusterStreetSegments(db)
	await createStreetSegmentIndexes(db)

	return db
}

const PROBE_COLUMNS = "from_hn, to_hn, min_hn, max_hn, parity, postcode, geometry, source, release"

describe("clusterStreetSegments", () => {
	it("stores rows in street, postcode, range order and keeps source order among equal keys", async () => {
		using db = await buildClustered([
			["main st", "94602", 100, 198, "L"],
			["foothill blvd", "94601", 5300, 5398, "R"],
			["main st", "94601", 1, 99, "L"],
			["foothill blvd", "94601", 5300, 5398, "L"],
			["foothill blvd", null, 1, 99, "L"],
			["foothill blvd", "94601", 5200, 5298, "L"],
		])

		const order = db
			.prepare("SELECT street_norm, postcode, min_hn, side FROM street_segment ORDER BY rowid")
			.all()
			.map((r) => Object.values(r).join("|"))

		expect(order).toEqual([
			"foothill blvd||1|L",
			"foothill blvd|94601|5200|L",
			"foothill blvd|94601|5300|R",
			"foothill blvd|94601|5300|L",
			"main st|94601|1|L",
			"main st|94602|100|L",
		])

		const stage = db
			.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = ?")
			.get(STREET_SEGMENT_STAGE_TABLE) as {
			n: number
		}

		expect(stage.n).toBe(0)
	})

	it("serves both probe forms from an index that holds every filtered column", async () => {
		using db = await buildClustered([["foothill blvd", "94601", 5300, 5398, "L"]])

		const plan = (statement: string): string =>
			db
				.prepare(`EXPLAIN QUERY PLAN ${statement}`)
				.all()
				.map((r) => String((r as { detail: unknown }).detail))
				.join("\n")

		expect(
			plan(
				`SELECT ${PROBE_COLUMNS} FROM street_segment WHERE postcode = '94601' AND street_norm = 'foothill blvd' AND min_hn <= 5321 AND max_hn >= 5321`
			)
		).toBe("SEARCH street_segment USING INDEX idx_seg_postcode (postcode=? AND street_norm=? AND min_hn<?)")

		expect(
			plan(
				`SELECT ${PROBE_COLUMNS} FROM street_segment WHERE street_norm = 'foothill blvd' AND min_hn <= 5321 AND max_hn >= 5321`
			)
		).toBe("SEARCH street_segment USING INDEX idx_seg_street (street_norm=? AND min_hn<?)")

		const indexed = (name: string): string[] =>
			db
				.prepare(`SELECT name FROM pragma_index_info(?) ORDER BY seqno`)
				.all(name)
				.map((r) => String((r as { name: unknown }).name))

		expect(indexed("idx_seg_postcode")).toEqual(["postcode", "street_norm", "min_hn", "max_hn"])
		expect(indexed("idx_seg_street")).toEqual(["street_norm", "min_hn", "max_hn"])
	})
})
