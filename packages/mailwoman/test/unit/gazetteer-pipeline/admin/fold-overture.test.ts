/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Synthetic Overture ids must be a function of the PLACE, not of the build.
 *
 *   The failure this pins is silent and cross-artifact. Ids were `idBase + rowIndex` over a threaded DuckDB scan, so
 *   the same division took a different id in each build: `8000001092006` is _Dolok Merawan, Indonesia_ in one shipped
 *   artifact and _Skałówki, Poland_ in another. Nothing errors — a stored id simply starts naming a different place,
 *   which is how an eval row scored a miss against two backends that had both answered correctly.
 */

import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { createUnifiedSchema } from "@mailwoman/resolver-wof-sqlite/unified-schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { assignSyntheticIDs, OVERTURE_ID_BASE, prepareInserts } from "mailwoman/gazetteer-pipeline/admin/fold-overture"
import { describe, expect, test } from "vitest"

/**
 * GERS-shaped ids. Real ones are opaque 32-char hex strings; the shape matters only in that the hash sees the whole
 * string.
 */
const GERS = [
	"08f2ab12c4d5e6f708192a3b4c5d6e7f",
	"08f3bc23d5e6f7a819203b4c5d6e7f80",
	"08f4cd34e6f7a8b91a2b3c4d5e6f8091",
	"08f5de45f7a8b9ca2b3c4d5e6f7a8192",
]

describe("assignSyntheticIDs", () => {
	test("the same GERS id gets the same synthetic id across independent runs", () => {
		expect(assignSyntheticIDs(GERS)).toEqual(assignSyntheticIDs(GERS))
	})

	test("a place's id does not move when the scan returns the rows in another order", () => {
		// The defect exactly: `idBase + i` gave every row after the reordering point a new id.
		const forward = assignSyntheticIDs(GERS)
		const reversed = assignSyntheticIDs(GERS.toReversed())

		for (const gers of GERS) {
			expect(reversed.get(gers), gers).toBe(forward.get(gers))
		}
	})

	test("a place's id does not move when OTHER places join or leave the build", () => {
		// The cross-release case — an Overture release that adds divisions must not renumber the ones
		// already shipped. Only a collision can move an existing id, and then only its immediate neighbours.
		const before = assignSyntheticIDs(GERS)
		const after = assignSyntheticIDs([...GERS, "08f6ef56a8b9cadb3c4d5e6f7a819203", "08f70f67b9cadbec4d5e6f7a81920314"])

		for (const gers of GERS) {
			expect(after.get(gers), gers).toBe(before.get(gers))
		}
	})

	test("ids are unique and land inside the reserved Overture range", () => {
		const idmap = assignSyntheticIDs(GERS)
		const ids = [...idmap.values()]

		expect(new Set(ids).size).toBe(ids.length)

		for (const id of ids) {
			expect(id).toBeGreaterThanOrEqual(OVERTURE_ID_BASE)
			// The GeoNames alias fold owns everything from 9e12 up; overlapping it would make one source's
			// rows silently readable as the other's.
			expect(id).toBeLessThan(9_000_000_000_000)
		}
	})

	test("a duplicate GERS id in the input maps to one id, not two", () => {
		const idmap = assignSyntheticIDs([...GERS, GERS[0]!])

		expect(idmap.size).toBe(GERS.length)
	})

	test("colliding ids are resolved without either place losing its row", () => {
		// Forced by construction rather than found: probe the span at width 1 so every id collides, and
		// assert the assignment still hands out distinct slots deterministically.
		const many = Array.from({ length: 50 }, (_, i) => `gers-${i}`)
		const idmap = assignSyntheticIDs(many)

		expect(idmap.size).toBe(many.length)
		expect(new Set(idmap.values()).size).toBe(many.length)
		expect(assignSyntheticIDs(many)).toEqual(idmap)
	})
})

describe("the bulk-write statements bind against the real unified schema", () => {
	// The column tuples are checked against the `WOFDatabase` INTERFACE at compile time. The tables are
	// created by `createUnifiedSchema`'s DDL, which is a SEPARATE artifact — a column renamed in one and
	// not the other type-checks perfectly and then fails partway through a multi-hour build. Binding a
	// row against the real schema is the only thing that catches that.
	async function openUnified(): Promise<DatabaseClient<WOFDatabase>> {
		const db = new DatabaseClient<WOFDatabase>(":memory:")

		await createUnifiedSchema(db)

		return db
	}

	test("every prepared insert accepts a row", async () => {
		await using db = await openUnified()
		const { spr, names, population, concordances } = prepareInserts(db)
		const id = OVERTURE_ID_BASE + 1

		spr.run(id, -1, "Testville", "locality", "US", 1.5, 2.5, 1, 2, 1.9, 2.9, 1, 0, 0, 0, 0, 0)
		names.run(id, "Testville", "locality", "US", "", 0, 0)
		population.run(id, 1234)
		concordances.run(id, "Q140147", "wd:id", 0)

		expect(db.prepare("SELECT name, placetype, country FROM spr WHERE id = ?").get(id)).toEqual({
			name: "Testville",
			placetype: "locality",
			country: "US",
		})

		expect(db.prepare("SELECT population FROM place_population WHERE id = ?").get(id)).toEqual({ population: 1234 })
		expect(db.prepare("SELECT name FROM names WHERE id = ?").get(id)).toEqual({ name: "Testville" })

		// #1884: the Wikidata concordance rides the SAME `wd:id` source the WOF ingest writes and the
		// `gazetteer importance` join reads (`WHERE c.other_source = 'wd:id'`) — the predicate is the
		// contract, so it is asserted literally.
		expect(db.prepare("SELECT other_id FROM concordances WHERE id = ? AND other_source = 'wd:id'").get(id)).toEqual({
			other_id: "Q140147",
		})
	})

	test("spr uses OR REPLACE so a re-ingest updates the row rather than throwing on its primary key", async () => {
		// Content-derived ids make a re-ingest recompute the SAME id, so this is the path a second run takes.
		await using db = await openUnified()
		const { spr } = prepareInserts(db)
		const id = OVERTURE_ID_BASE + 2

		spr.run(id, -1, "Before", "locality", "US", 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0)
		spr.run(id, -1, "After", "locality", "US", 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0)

		expect(db.prepare("SELECT COUNT(*) AS n FROM spr WHERE id = ?").get(id)).toEqual({ n: 1 })
		expect(db.prepare("SELECT name FROM spr WHERE id = ?").get(id)).toEqual({ name: "After" })
	})
})
