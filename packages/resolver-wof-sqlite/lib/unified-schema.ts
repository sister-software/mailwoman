/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Schema for the unified WOF SQLite database built from cloned WOF GeoJSON repos
 * (`scripts/build-unified-wof.ts`). The table and column names match the resolver's
 * expectations (`lookup.ts`) so `WOFSQLitePlaceLookup` works unchanged. The `ancestors` table
 * table is what lookup.ts's parent-constraint subquery reads (see `populateAncestors`).
 * The `place_search` FTS5 and `place_bbox` R*Tree tables are built separately by `build-fts` (fts.ts).
 */

import type { DatabaseClient } from "@mailwoman/sqlite/client"

import type { WOFDatabase } from "#schema"

export async function createUnifiedSchema(db: DatabaseClient<WOFDatabase>): Promise<void> {
	// PRAGMAs run raw because Kysely does not model them.
	// They tune the bulk build.
	db.exec("PRAGMA journal_mode = WAL")
	db.exec("PRAGMA busy_timeout = 10000")
	db.exec("PRAGMA synchronous = OFF")

	// The caller owns `db`'s lifecycle, so this function does not destroy it.
	// The bulk INSERTs (populateAncestors + build-unified-wof) run on the raw handle.

	await db.schema
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

	// `privateuse` represents WOF's x_<variant> kind (preferred | variant) or GeoNames'
	// isPreferredName ("preferred" | "").
	// `official` is the ingest bit.
	// It is 1 when the row's language is an official language of the place's country
	// (codex OFFICIAL_LANGUAGES) and the row is a preferred form. x_variant rows
	// tagged with an official language ("MSP", "Frisco") stay 0.
	// Primary-name mirror rows stay 0 too.
	// The name-exact tier already consults spr.name.
	// `official` only marks the aliases eligible to join it.
	// Both are ingest-time facts, never computed at query time.
	await db.schema
		.createTable("names")
		.ifNotExists()
		.addColumn("id", "integer", (c) => c.notNull())
		.addColumn("name", "text", (c) => c.notNull())
		.addColumn("placetype", "text", (c) => c.notNull().defaultTo(""))
		.addColumn("country", "text", (c) => c.notNull().defaultTo(""))
		.addColumn("language", "text", (c) => c.notNull().defaultTo(""))
		.addColumn("privateuse", "text", (c) => c.notNull().defaultTo(""))
		.addColumn("official", "integer", (c) => c.notNull().defaultTo(0))
		.addColumn("lastmodified", "integer", (c) => c.notNull().defaultTo(0))
		.execute()

	await db.schema
		.createTable("concordances")
		.ifNotExists()
		.addColumn("id", "integer", (c) => c.notNull())
		.addColumn("other_id", "text", (c) => c.notNull())
		.addColumn("other_source", "text", (c) => c.notNull())
		.addColumn("lastmodified", "integer", (c) => c.notNull().defaultTo(0))
		.execute()

	await db.schema
		.createTable("place_population")
		.ifNotExists()
		.addColumn("id", "integer", (c) => c.primaryKey())
		.addColumn("population", "integer", (c) => c.notNull().defaultTo(0))
		.execute()

	// `ancestors` maps each place to every place above it in the hierarchy (and itself).
	// The resolver's parent-constraint scopes a child lookup to a parent's descendants
	// via `spr.id IN (select id from ancestors where ancestor_id = ?)`.
	// The off-the-shelf WOF dumps ship this table.
	// Our build derives it from the parent_id chain (see populateAncestors)
	// since we don't capture `wof:hierarchy`.
	await db.schema
		.createTable("ancestors")
		.ifNotExists()
		.addColumn("id", "integer", (c) => c.notNull())
		.addColumn("ancestor_id", "integer", (c) => c.notNull())
		.addColumn("ancestor_placetype", "text", (c) => c.notNull().defaultTo(""))
		.addColumn("lastmodified", "integer", (c) => c.notNull().defaultTo(0))
		.execute()
}

/**
 * Populate the `ancestors` table by walking each place's `parent_id` chain in `spr`
 * to a transitive closure that includes the place itself.
 * Run this after `spr` is fully ingested.
 */
export function populateAncestors<DB>(db: DatabaseClient<DB>): number {
	db.exec("DELETE FROM ancestors")

	const rows = db.prepare("SELECT id, parent_id, placetype FROM spr").all() as Array<{
		id: number
		parent_id: number
		placetype: string
	}>

	const byID = new Map<number, { parent: number; placetype: string }>()

	for (const r of rows) {
		byID.set(r.id, { parent: r.parent_id, placetype: r.placetype })
	}

	const insert = db.prepare("INSERT INTO ancestors (id, ancestor_id, ancestor_placetype) VALUES (?, ?, ?)")
	db.exec("BEGIN")
	let count = 0

	for (const r of rows) {
		insert.run(r.id, r.id, r.placetype)

		count++
		const seen = new Set<number>([r.id])
		let cur = r.parent_id

		while (cur > 0 && !seen.has(cur)) {
			const node = byID.get(cur)

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

export async function createUnifiedIndexes(db: DatabaseClient<WOFDatabase>): Promise<void> {
	await db.schema.createIndex("spr_by_placetype").ifNotExists().on("spr").column("placetype").execute()
	await db.schema.createIndex("spr_by_country").ifNotExists().on("spr").column("country").execute()
	await db.schema.createIndex("spr_by_parent").ifNotExists().on("spr").column("parent_id").execute()
	await db.schema.createIndex("names_by_id").ifNotExists().on("names").column("id").execute()
	await db.schema.createIndex("names_by_name").ifNotExists().on("names").column("name").execute()

	await db.schema
		.createIndex("concordances_by_id")
		.ifNotExists()
		.on("concordances")
		.columns(["id", "lastmodified"])
		.execute()

	await db.schema
		.createIndex("concordances_by_other_id")
		.ifNotExists()
		.on("concordances")
		.columns(["other_source", "other_id"])
		.execute()

	// ancestor_id is the hot column for parent-constraint queries. id supports the reverse lookup.
	await db.schema.createIndex("ancestors_by_ancestor").ifNotExists().on("ancestors").column("ancestor_id").execute()
	await db.schema.createIndex("ancestors_by_id").ifNotExists().on("ancestors").column("id").execute()
}
