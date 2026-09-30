/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Synthetic Overture ids must derive from the place rather than the build, so a stored id never starts naming
 *   a different place across artifacts without an error.
 */

import { OVERTURE_ID_BASE } from "@mailwoman/core/resolver/synthetic-id-ranges"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { createUnifiedSchema } from "@mailwoman/resolver-wof-sqlite/unified-schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { describe, expect, test } from "vitest"

import { assignSyntheticIDs, foldedPlacetype, prepareInserts } from "#gazetteer/admin/fold/overture"

/**
 * Real GERS ids are opaque 32-char hex strings.
 *
 * The shape matters only in that the hash sees the whole string.
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
		const forward = assignSyntheticIDs(GERS)
		const reversed = assignSyntheticIDs(GERS.toReversed())

		for (const gers of GERS) {
			expect(reversed.get(gers), gers).toBe(forward.get(gers))
		}
	})

	test("a place's id does not move when OTHER places join or leave the build", () => {
		// An Overture release that adds divisions must preserve shipped IDs.
		// A collision can move an existing ID only when the colliding entries are immediate neighbours.
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
			// The GeoNames alias fold owns IDs from 9e12 upward.
			// An overlap would make one source's rows readable as the other's without an error.
			expect(id).toBeLessThan(9_000_000_000_000)
		}
	})

	test("a duplicate GERS id in the input maps to one id, not two", () => {
		const idmap = assignSyntheticIDs([...GERS, GERS[0]!])

		expect(idmap.size).toBe(GERS.length)
	})

	test("colliding ids are resolved without either place losing its row", () => {
		const many = Array.from({ length: 50 }, (_, i) => `gers-${i}`)
		const idmap = assignSyntheticIDs(many)

		expect(idmap.size).toBe(many.length)
		expect(new Set(idmap.values()).size).toBe(many.length)
		expect(assignSyntheticIDs(many)).toEqual(idmap)
	})
})

describe("the bulk-write statements bind against the real unified schema", () => {
	// A column renamed in the `WOFDatabase` interface but not in `createUnifiedSchema`'s DDL type-checks,
	// so binding a row against the real schema is what catches the mismatch before a multi-hour build.
	async function openUnified(): Promise<DatabaseClient<WOFDatabase>> {
		const db = DatabaseClient.temp<WOFDatabase>()

		await createUnifiedSchema(db)

		return db
	}

	test("every prepared insert accepts a row", async () => {
		using db = await openUnified()
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

		// The Wikidata concordance must ride the same `wd:id` source the WOF ingest writes
		// and the `gazetteer importance` join reads, so the predicate is asserted literally.
		expect(db.prepare("SELECT other_id FROM concordances WHERE id = ? AND other_source = 'wd:id'").get(id)).toEqual({
			other_id: "Q140147",
		})
	})

	test("spr uses OR REPLACE so a re-ingest updates the row rather than throwing on its primary key", async () => {
		// Content-derived ids make a re-ingest recompute the same id, so this is the path a second run takes.
		using db = await openUnified()
		const { spr } = prepareInserts(db)
		const id = OVERTURE_ID_BASE + 2

		spr.run(id, -1, "Before", "locality", "US", 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0)
		spr.run(id, -1, "After", "locality", "US", 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0)

		expect(db.prepare("SELECT COUNT(*) AS n FROM spr WHERE id = ?").get(id)).toEqual({ n: 1 })
		expect(db.prepare("SELECT name FROM spr WHERE id = ?").get(id)).toEqual({ name: "After" })
	})
})

describe("foldedPlacetype", () => {
	test("Singapore's planning areas become boroughs, which a locality query already reaches", () => {
		// `PLACETYPE_FILTER_GROUPS.locality` expands to locality|borough|localadmin and never
		// to `county`, so Singapore's planning areas are unreachable unless folded to borough.
		expect(foldedPlacetype("county", "SG")).toBe("borough")
		expect(foldedPlacetype("county", "sg")).toBe("borough")
	})

	test("leaves every other country's county alone, including the two that look like Singapore", () => {
		// Kuwait's counties are underscore-joined ASCII names with Arabic on `locality`, and Qatar's are
		// Doha zone numbers, so both clear a count test but would attest surfaces absent from the source.
		expect(foldedPlacetype("county", "KW")).toBe("county")
		expect(foldedPlacetype("county", "QA")).toBe("county")
		expect(foldedPlacetype("county", "US")).toBe("county")
	})

	test("passes every non-county subtype through untouched, Singapore included", () => {
		for (const subtype of ["country", "region", "locality", "localadmin"]) {
			expect(foldedPlacetype(subtype, "SG")).toBe(subtype)
		}
	})
})
