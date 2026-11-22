// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The `overture_wof_match` table: which Who's On First record each matched Overture division is.
 *
 *   The admin gazetteer is a Collective Database.
 *   Its Overture Divisions part is ODbL-1.0, and the Overture step writes every division as its own
 *   row in the Overture id range rather than adding its names or Wikidata id to a WOF record.
 *
 *   A lookup that returns each place once reads the match from this table
 *   instead of from an altered WOF row.
 *   The table is derived from Overture data, so it belongs to the Overture part
 *   and travels with that part's ODbL offer.
 *
 *   The admin build writes it, the candidate build copies it into `candidate.db`,
 *   and the Overture part's offer file includes it.
 */

import type { DatabaseClient } from "@mailwoman/sqlite/client"
import type { Kysely } from "kysely"

import { hasTable } from "#sqlite-utils"

/**
 * The table name every writer and reader uses.
 */
export const OVERTURE_WOF_MATCH_TABLE = "overture_wof_match"

/**
 * One matched division: its Overture-part row and the WOF record it names.
 */
export interface OvertureWOFMatchTable {
	/**
	 * The division's row id, inside the Overture id range.
	 */
	overture_id: number
	/**
	 * The WOF record the division matched.
	 */
	wof_id: number
	/**
	 * The evidence that matched them: `country`, `wikidata`, `geonames` or `name`.
	 */
	match_by: string
}

export interface OvertureWOFMatchDatabase {
	overture_wof_match: OvertureWOFMatchTable
}

/**
 * Create the table, keyed by the Overture row so each division records at most one match.
 */
export async function createOvertureWOFMatchTable<DB extends OvertureWOFMatchDatabase>(db: Kysely<DB>): Promise<void> {
	await db.schema
		.createTable(OVERTURE_WOF_MATCH_TABLE)
		.ifNotExists()
		.addColumn("overture_id", "integer", (c) => c.primaryKey())
		.addColumn("wof_id", "integer", (c) => c.notNull())
		.addColumn("match_by", "text", (c) => c.notNull())
		.execute()
}

/**
 * Every recorded match, or `null` when the database predates the table.
 *
 * A database without the table was built before the Overture rows became an independent part, when a matched
 * division wrote no row of its own, so its matches are unrecorded rather than zero.
 */
export function readOvertureWOFMatches<DB>(db: DatabaseClient<DB>): OvertureWOFMatchTable[] | null {
	if (!hasTable(db, OVERTURE_WOF_MATCH_TABLE)) return null

	return (
		db
			.prepare(`SELECT overture_id, wof_id, match_by FROM ${OVERTURE_WOF_MATCH_TABLE} ORDER BY overture_id`)
			.all() as Array<{ overture_id: number; wof_id: number; match_by: string }>
	).map((row) => ({ overture_id: Number(row.overture_id), wof_id: Number(row.wof_id), match_by: String(row.match_by) }))
}
