// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Pages through a candidate gazetteer's postcode places in ascending `spr_id`
 *   order, inside a bounding box.
 *
 *   A page reads only {@link CANDIDATE_POSTCODE_PLACE_INDEX}: the index holds each
 *   postcode place's primary rows in `spr_id` order with their point and name.
 *   Each entry also stores the clustered key, and its `country_id` identifies the country.
 *
 *   A page continues after the last id the previous page returned, so the database
 *   seeks to it and a deep page costs what the first page costs.
 *
 *   A box filters the walk by point, so a box holding few postcode places reads more
 *   of the index before its page fills, and never more than the index once.
 *
 *   The statements stay raw because a partial index is used only by a query that
 *   states its literal, and `INDEXED BY` has no query-builder form.
 *   `INDEXED BY` makes a statement fail to prepare rather than scan the table when the index is missing.
 */

import { DatabaseClient, type StatementSync } from "@mailwoman/sqlite/client"
import { indexExists, tableExists } from "@mailwoman/sqlite/introspection"
import { SQLiteLookup, type SQLiteLookupOptions } from "@mailwoman/sqlite/lookup"
import type { PathBuilderLike } from "path-ts"

import { CANDIDATE_POSTCODE_PLACE_INDEX, type CandidateDatabase, POSTCODE_PLACETYPE } from "#candidate/schema"
import type { BrowsedPlace, BrowsePageRequest } from "#lookup/browse"
import type { WOFDatabase } from "#schema"

/**
 * Whether a WOF database such as `postalcode-us.db` holds at least one current postcode place in `spr`.
 *
 * A database without `spr` holds none.
 */
export function wofDatabaseHoldsPostcodes(databasePath: PathBuilderLike): boolean {
	using db = new DatabaseClient<WOFDatabase>(databasePath, { readOnly: true })

	if (!tableExists(db, "spr")) return false

	return Boolean(
		db.prepare("SELECT 1 FROM spr WHERE placetype = ? AND is_current != 0 LIMIT 1").get(POSTCODE_PLACETYPE)
	)
}

interface PostcodeRow {
	spr_id: number
	country_id: number
	latitude: number | null
	longitude: number | null
	name: string | null
}

/**
 * The statements of a gazetteer that records the postcode placetype.
 */
interface PostcodeStatements {
	any: StatementSync
	place: StatementSync
	page: StatementSync
	pageInBox: StatementSync
	pageAcrossAntimeridian: StatementSync
}

/**
 * Pages through the postcode places of a candidate gazetteer such as `candidate.db`.
 *
 * A postcode place appears once, read from the primary row with the least name.
 */
export class PostcodePlaceBrowser extends SQLiteLookup<CandidateDatabase> {
	/**
	 * Null when the gazetteer records no postcode placetype.
	 */
	readonly #statements: PostcodeStatements | null
	readonly #countryCodes: Map<number, string>

	/**
	 * @throws When the gazetteer records the postcode placetype but lacks
	 * {@link CANDIDATE_POSTCODE_PLACE_INDEX}, because a page would then scan the whole candidate table.
	 */
	constructor(options: SQLiteLookupOptions<CandidateDatabase>) {
		super(options)

		const placetype = this.database
			.prepare("SELECT id FROM placetype_codes WHERE placetype = ?")
			.get(POSTCODE_PLACETYPE) as { id: number } | undefined

		if (placetype && !indexExists(this.database, CANDIDATE_POSTCODE_PLACE_INDEX)) {
			this[Symbol.dispose]()

			throw new Error(`the candidate gazetteer has no ${CANDIDATE_POSTCODE_PLACE_INDEX} index`)
		}

		this.#statements = placetype ? this.#prepare(placetype.id) : null

		const countries = this.database.prepare("SELECT id, code FROM country_codes").all() as Array<{
			id: number
			code: string
		}>

		this.#countryCodes = new Map(countries.map(({ id, code }) => [id, code]))
	}

	#prepare(placetypeID: number): PostcodeStatements {
		const from =
			`FROM candidate INDEXED BY ${CANDIDATE_POSTCODE_PLACE_INDEX} ` +
			`WHERE placetype_id = ${Math.trunc(placetypeID)} AND is_primary = 1`

		const select = `SELECT spr_id, country_id, latitude, longitude, MIN(name) AS name ${from}`

		const page = (box: string) =>
			this.database.prepare(`${select} AND spr_id > ? ${box} GROUP BY spr_id ORDER BY spr_id LIMIT ?`)

		return {
			any: this.database.prepare(`SELECT 1 ${from} LIMIT 1`),
			place: this.database.prepare(`${select} AND spr_id = ? GROUP BY spr_id`),
			page: page(""),
			pageInBox: page("AND latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?"),
			pageAcrossAntimeridian: page("AND latitude BETWEEN ? AND ? AND (longitude >= ? OR longitude <= ?)"),
		}
	}

	#toPlace(row: PostcodeRow): BrowsedPlace {
		return {
			id: row.spr_id,
			name: row.name ?? "",
			placetype: POSTCODE_PLACETYPE,
			country: this.#countryCodes.get(row.country_id) ?? "",
			latitude: row.latitude ?? 0,
			longitude: row.longitude ?? 0,
		}
	}

	/**
	 * Whether the gazetteer holds at least one postcode place.
	 */
	holdsPostcodes(): boolean {
		return Boolean(this.#statements?.any.get())
	}

	/**
	 * The postcode place with this id, or null when the gazetteer holds no postcode place with it.
	 */
	async place(id: number): Promise<BrowsedPlace | null> {
		const row = this.#statements?.place.get(id) as PostcodeRow | undefined

		return row ? this.#toPlace(row) : null
	}

	/**
	 * The postcode places the request selects, in ascending id order, at most `limit` of them.
	 */
	async page({ box, after, limit }: BrowsePageRequest): Promise<BrowsedPlace[]> {
		const statements = this.#statements

		if (!statements) return []

		const cursor = after ?? Number.MIN_SAFE_INTEGER

		let rows: unknown[]

		if (!box) {
			rows = statements.page.all(cursor, limit)
		} else {
			const statement = box.minLon <= box.maxLon ? statements.pageInBox : statements.pageAcrossAntimeridian

			rows = statement.all(cursor, box.minLat, box.maxLat, box.minLon, box.maxLon, limit)
		}

		return (rows as PostcodeRow[]).map((row) => this.#toPlace(row))
	}
}
