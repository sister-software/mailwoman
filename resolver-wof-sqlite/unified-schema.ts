/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Schema for the unified WOF SQLite database we build from cloned WOF GeoJSON repos
 *   (`scripts/build-unified-wof.ts`). This is the CANONICAL gazetteer — we never use the
 *   off-the-shelf geocode.earth prebuilt dumps (they assign different WOF ids to the same place;
 *   see the `feedback-custom-wof-db-only` memory). The table/column names match the resolver's
 *   expectations (`lookup.ts`) so `WofSqlitePlaceLookup` works unchanged, INCLUDING the `ancestors`
 *   table (which lookup.ts's parent-constraint subquery needs) — see `populateAncestors`. The
 *   `place_search` FTS5 + `place_bbox` R*Tree are built separately by `build-fts` (fts.ts).
 */

import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"

import type { WofDatabase } from "./schema.js"

export async function createUnifiedSchema(db: DatabaseSync): Promise<void> {
	// PRAGMAs stay raw — not Kysely-modelled, and these tune the bulk build.
	db.exec("PRAGMA journal_mode = WAL")
	db.exec("PRAGMA busy_timeout = 10000")
	db.exec("PRAGMA synchronous = OFF")

	// `kdb` wraps `db` for the DDL (the house idiom); the caller owns `db`'s lifecycle, so we don't
	// destroy it here. The bulk INSERTs (populateAncestors + build-unified-wof) stay on the raw handle.
	const kdb = new DatabaseClient<WofDatabase>({ database: db })

	await kdb.schema
		.createTable("spr")
		.ifNotExists()
		.addColumn("id", "integer", (c) => c.primaryKey())
		.addColumn("parent_id", "integer", (c) => c.notNull().defaultTo(-1))
		.addColumn("name", "text", (c) => c.notNull().defaultTo(""))
		.addColumn("placetype", "text", (c) => c.notNull().defaultTo(""))
		.addColumn("country", "text", (c) => c.notNull().defaultTo(""))
		.addColumn("latitude", "real", (c) => c.notNull().defaultTo(0))
		.addColumn("longitude", "real", (c) => c.notNull().defaultTo(0))
		.addColumn("min_latitude", "real", (c) => c.notNull().defaultTo(0))
		.addColumn("min_longitude", "real", (c) => c.notNull().defaultTo(0))
		.addColumn("max_latitude", "real", (c) => c.notNull().defaultTo(0))
		.addColumn("max_longitude", "real", (c) => c.notNull().defaultTo(0))
		.addColumn("is_current", "integer", (c) => c.notNull().defaultTo(1))
		.addColumn("is_deprecated", "integer", (c) => c.notNull().defaultTo(0))
		.addColumn("is_ceased", "integer", (c) => c.notNull().defaultTo(0))
		.addColumn("is_superseded", "integer", (c) => c.notNull().defaultTo(0))
		.addColumn("is_superseding", "integer", (c) => c.notNull().defaultTo(0))
		.addColumn("lastmodified", "integer", (c) => c.notNull().defaultTo(0))
		.execute()

	await kdb.schema
		.createTable("names")
		.ifNotExists()
		.addColumn("id", "integer", (c) => c.notNull())
		.addColumn("name", "text", (c) => c.notNull())
		.addColumn("placetype", "text", (c) => c.notNull().defaultTo(""))
		.addColumn("country", "text", (c) => c.notNull().defaultTo(""))
		.addColumn("language", "text", (c) => c.notNull().defaultTo(""))
		.addColumn("privateuse", "text", (c) => c.notNull().defaultTo(""))
		.addColumn("lastmodified", "integer", (c) => c.notNull().defaultTo(0))
		.execute()

	await kdb.schema
		.createTable("concordances")
		.ifNotExists()
		.addColumn("id", "integer", (c) => c.notNull())
		.addColumn("other_id", "text", (c) => c.notNull())
		.addColumn("other_source", "text", (c) => c.notNull())
		.addColumn("lastmodified", "integer", (c) => c.notNull().defaultTo(0))
		.execute()

	await kdb.schema
		.createTable("place_population")
		.ifNotExists()
		.addColumn("id", "integer", (c) => c.primaryKey())
		.addColumn("population", "integer", (c) => c.notNull().defaultTo(0))
		.execute()

	// `ancestors` maps each place to every place above it in the hierarchy (and itself). The
	// resolver's parent-constraint scopes a child lookup to a parent's descendants via
	// `spr.id IN (SELECT id FROM ancestors WHERE ancestor_id = ?)`. The off-the-shelf WOF dumps
	// ship this table; our build derives it from the parent_id chain (see populateAncestors) since
	// we don't capture `wof:hierarchy`.
	await kdb.schema
		.createTable("ancestors")
		.ifNotExists()
		.addColumn("id", "integer", (c) => c.notNull())
		.addColumn("ancestor_id", "integer", (c) => c.notNull())
		.addColumn("ancestor_placetype", "text", (c) => c.notNull().defaultTo(""))
		.addColumn("lastmodified", "integer", (c) => c.notNull().defaultTo(0))
		.execute()
}

/**
 * Populate the `ancestors` table by walking each place's `parent_id` chain in `spr` (transitive closure, including the
 * place itself). Idempotent: drops + rebuilds the table contents. Returns the row count. Run after `spr` is fully
 * ingested (build-unified-wof freeze phase) or standalone on an existing unified DB (`scripts/add-ancestors.ts`).
 * Sentinel/negative parent_ids and cycles terminate the walk. ~4 rows/place average; a transaction keeps the ~5M
 * inserts fast.
 */
export function populateAncestors(db: DatabaseSync): number {
	db.exec("DELETE FROM ancestors")
	const rows = db.prepare("SELECT id, parent_id, placetype FROM spr").all() as Array<{
		id: number
		parent_id: number
		placetype: string
	}>
	const byId = new Map<number, { parent: number; placetype: string }>()

	for (const r of rows) byId.set(r.id, { parent: r.parent_id, placetype: r.placetype })

	const insert = db.prepare("INSERT INTO ancestors (id, ancestor_id, ancestor_placetype) VALUES (?, ?, ?)")
	db.exec("BEGIN")
	let count = 0

	for (const r of rows) {
		insert.run(r.id, r.id, r.placetype) // self
		count++
		const seen = new Set<number>([r.id])
		let cur = r.parent_id

		while (cur > 0 && !seen.has(cur)) {
			const node = byId.get(cur)

			if (!node) break
			insert.run(r.id, cur, node.placetype)
			count++
			seen.add(cur)
			cur = node.parent
		}
	}
	db.exec("COMMIT")

	return count
}

export async function createUnifiedIndexes(db: DatabaseSync): Promise<void> {
	const kdb = new DatabaseClient<WofDatabase>({ database: db })
	await kdb.schema.createIndex("spr_by_placetype").ifNotExists().on("spr").column("placetype").execute()
	await kdb.schema.createIndex("spr_by_country").ifNotExists().on("spr").column("country").execute()
	await kdb.schema.createIndex("spr_by_parent").ifNotExists().on("spr").column("parent_id").execute()
	await kdb.schema.createIndex("names_by_id").ifNotExists().on("names").column("id").execute()
	await kdb.schema.createIndex("names_by_name").ifNotExists().on("names").column("name").execute()
	await kdb.schema
		.createIndex("concordances_by_id")
		.ifNotExists()
		.on("concordances")
		.columns(["id", "lastmodified"])
		.execute()
	await kdb.schema
		.createIndex("concordances_by_other_id")
		.ifNotExists()
		.on("concordances")
		.columns(["other_source", "other_id"])
		.execute()
	// ancestor_id is the hot column (parent-constraint queries `WHERE ancestor_id = ?`); id supports
	// the reverse lookup.
	await kdb.schema.createIndex("ancestors_by_ancestor").ifNotExists().on("ancestors").column("ancestor_id").execute()
	await kdb.schema.createIndex("ancestors_by_id").ifNotExists().on("ancestors").column("id").execute()
}
