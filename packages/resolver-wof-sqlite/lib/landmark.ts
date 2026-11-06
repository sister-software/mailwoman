/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The landmark layer: Wikidata places keyed by every name and alias they are written with, ranked by the number of
 *   Wikipedia language editions that describe them. The source is CC0, so the database may ship.
 */

import type { LandmarkHit, LandmarkKind, LandmarkLookup } from "@mailwoman/core/resolver"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sql, type Kysely } from "kysely"
import type { PathBuilderLike } from "path-ts"

import { prepareAll, type PreparedAll } from "#sqlite-utils"
import { normalizeLocalityForKey } from "#street/normalize"

/**
 * One way of writing one place.
 */
export interface LandmarkNameTable {
	name_key: string
	qid: string
	/**
	 * The place's own display name.
	 */
	name: string
	kind: LandmarkKind
	country: string | null
	latitude: number
	longitude: number
	sitelinks: number
	/**
	 * The upper-case spelling of a code alias such as `DTW`, or `null` for an ordinary name.
	 *
	 * A code answers only when written in that case, so `Lax` and `Sea` stay words.
	 */
	code: string | null
	/**
	 * 1 when this is the place's own name in English or its country's language, 0 for a translation or alias.
	 */
	is_primary: number
	/**
	 * The importance Photon's index holds for an OpenStreetMap place, or `null` for a Wikidata place.
	 */
	importance: number | null
	/**
	 * The place's short H3 cell, the spatial key an OpenStreetMap layer's manifest names,
	 * or `null` for a Wikidata place.
	 */
	h3_cell: number | null
}

export interface LandmarkDatabase {
	landmark_name: LandmarkNameTable
}

/**
 * The column order the build's positional insert writes.
 */
export const LANDMARK_NAME_COLUMNS = [
	"name_key",
	"qid",
	"name",
	"kind",
	"country",
	"latitude",
	"longitude",
	"sitelinks",
	"code",
	"is_primary",
	"importance",
	"h3_cell",
] as const satisfies ReadonlyArray<keyof LandmarkNameTable>

/**
 * Creates the table.
 *
 * Rows cluster by name, because every read is a probe of one name.
 */
export async function createLandmarkTables(db: Kysely<LandmarkDatabase>): Promise<void> {
	await db.schema
		.createTable("landmark_name")
		.addColumn("name_key", "text", (c) => c.notNull())
		.addColumn("qid", "text", (c) => c.notNull())
		.addColumn("name", "text", (c) => c.notNull())
		.addColumn("kind", "text", (c) => c.notNull())
		.addColumn("country", "text")
		.addColumn("latitude", "real", (c) => c.notNull())
		.addColumn("longitude", "real", (c) => c.notNull())
		.addColumn("sitelinks", "integer", (c) => c.notNull())
		.addColumn("code", "text")
		.addColumn("is_primary", "integer", (c) => c.notNull())
		.addColumn("importance", "real")
		.addColumn("h3_cell", "integer")
		.addPrimaryKeyConstraint("landmark_name_pk", ["name_key", "qid"])
		.modifyEnd(sql`without rowid`)
		.execute()
}

/**
 * Returns the key a written name is stored and read under.
 *
 * Canonical Unicode form, a typographic apostrophe and a sentence's closing period do not change
 * which place a name means, so `St George’s.` and `St George's` read one row.
 */
export function landmarkNameKey(written: string): string {
	return normalizeLocalityForKey(written.normalize("NFC").replaceAll("’", "'").trim().replace(/\.+$/u, ""))
}

/**
 * Returns whether an alias is an identifier code rather than a word:
 * two to five upper-case letters or digits.
 */
export function isLandmarkCode(alias: string): boolean {
	return /^[\p{Lu}\d]{2,5}$/u.test(alias)
}

/**
 * Reads a sealed landmark database.
 */
export class LandmarkSqliteLookup implements LandmarkLookup, Disposable {
	readonly #db: DatabaseClient<LandmarkDatabase>

	readonly #byName: PreparedAll<[nameKey: string], LandmarkNameTable>

	constructor(path: PathBuilderLike) {
		this.#db = new DatabaseClient<LandmarkDatabase>(path, { readOnly: true })

		this.#byName = prepareAll(
			this.#db,
			"SELECT * FROM landmark_name WHERE name_key = ? ORDER BY is_primary DESC, sitelinks DESC, importance DESC, qid"
		)
	}

	find(name: string): LandmarkHit[] {
		const written = name.trim()

		// A code written in its own case is an identifier, so it ranks ahead of every word spelled the same.
		const isCode = (row: LandmarkNameTable) => row.code === written

		return this.#byName(landmarkNameKey(written))
			.filter((row) => !row.code || isCode(row))
			.toSorted((a, b) => Number(isCode(b)) - Number(isCode(a)))
			.map((row) => ({
				code: isCode(row),
				qid: row.qid,
				name: row.name,
				kind: row.kind,
				country: row.country,
				lat: row.latitude,
				lon: row.longitude,
				sitelinks: row.sitelinks,
				primary: row.is_primary === 1,
				importance: row.importance,
			}))
	}

	[Symbol.dispose](): void {
		this.#db[Symbol.dispose]()
	}
}
