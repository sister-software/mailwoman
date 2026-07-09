/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */
import { DatabaseSync } from "node:sqlite"

import { createUnifiedSchema } from "@mailwoman/resolver-wof-sqlite/unified-schema"
import { expect, test } from "vitest"

import { enrichAdmin } from "./enrich.ts"

test("enrichAdmin adds region abbreviations (VT→Vermont) and builds place_abbr", async () => {
	const db = new DatabaseSync(":memory:")
	await createUnifiedSchema(db)
	db.prepare(
		"INSERT INTO spr (id, parent_id, name, placetype, country, latitude, longitude, is_current, is_deprecated, is_ceased, is_superseded, is_superseding, lastmodified) VALUES (?, ?, ?, ?, ?, 0, 0, 1, 0, 0, 0, 0, 0)"
	).run(85688763, -1, "Vermont", "region", "US")

	const r = enrichAdmin(db) // default specsDir = the packaged chromium-i18n ssl-address specs

	expect(r.abbrevNamesAdded).toBeGreaterThan(0)
	expect(r.placeAbbrRows).toBeGreaterThan(0)
	// The names row the FTS build concatenates…
	const nameRow = db.prepare("SELECT name FROM names WHERE id = 85688763 AND language = 'abbr'").get() as
		| { name: string }
		| undefined
	expect(nameRow?.name).toBe("VT")
	// …and the place_abbr join the resolver probes.
	const abbr = db
		.prepare("SELECT s.name FROM place_abbr a JOIN spr s ON s.id = a.id WHERE a.abbr = 'VT' AND s.country = 'US'")
		.get() as { name: string } | undefined
	expect(abbr?.name).toBe("Vermont")
	db.close()
})

test("enrichAdmin is idempotent — a re-run doesn't duplicate abbr rows", async () => {
	const db = new DatabaseSync(":memory:")
	await createUnifiedSchema(db)
	db.prepare(
		"INSERT INTO spr (id, parent_id, name, placetype, country, latitude, longitude, is_current, is_deprecated, is_ceased, is_superseded, is_superseding, lastmodified) VALUES (?, ?, ?, ?, ?, 0, 0, 1, 0, 0, 0, 0, 0)"
	).run(85688763, -1, "Vermont", "region", "US")

	const first = enrichAdmin(db)
	const second = enrichAdmin(db)
	expect(second.abbrevNamesAdded).toBe(first.abbrevNamesAdded)
	expect((db.prepare("SELECT COUNT(*) n FROM names WHERE language = 'abbr'").get() as { n: number }).n).toBe(
		first.abbrevNamesAdded
	)
	db.close()
})
