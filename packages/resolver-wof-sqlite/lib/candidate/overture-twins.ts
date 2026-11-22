// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The candidate build's Overture twins: a matched division answers only on the keys its WOF record lacks.
 *
 *   The admin gazetteer writes every Overture division as its own row, including a division that matched a
 *   WOF record, and records the pair in `overture_wof_match`. Both rows staged in full would return one place
 *   twice for every name the two share. The pass deletes each matched division's staged rows on the keys its
 *   WOF record also holds, so the division answers only on the names WOF lacks.
 *
 *   It changes only the Overture part's rows. The WOF rows it reads are left as they are, so the gazetteer
 *   stays a Collective Database whose Overture Divisions part is ODbL. The match table is copied into the
 *   artifact as a table of that part.
 */

import type { DatabaseClient } from "@mailwoman/sqlite/client"

import type { CandidateDatabase } from "#candidate/schema"
import type { WOFDatabase } from "#schema"
import { createOvertureWOFMatchTable, OVERTURE_WOF_MATCH_TABLE, readOvertureWOFMatches } from "#schema/overture-match"

/**
 * Copies the admin database's `overture_wof_match` into the candidate and drops each
 * matched division's staged rows on keys its WOF record holds.
 *
 * Runs on `cand_stage` after the nickname refusal, so the comparison is with the WOF rows that stay.
 *
 * @returns The matches copied and the staged rows dropped, or `null`
 * when the admin database predates the table.
 * Such a database's matched divisions wrote no rows of their own.
 */
export async function stageOvertureTwins(
	src: DatabaseClient<WOFDatabase>,
	out: DatabaseClient<CandidateDatabase>
): Promise<{ matches: number; rowsDropped: number } | null> {
	const matches = readOvertureWOFMatches(src)

	if (!matches) return null

	await createOvertureWOFMatchTable(out)

	const insert = out.prepare(`INSERT INTO ${OVERTURE_WOF_MATCH_TABLE} (overture_id, wof_id, match_by) VALUES (?, ?, ?)`)

	out.exec("BEGIN")

	for (const match of matches) {
		insert.run(match.overture_id, match.wof_id, match.match_by)
	}

	out.exec("COMMIT")

	// `cand_stage` has no index while it stages, so each side is one scan: the WOF records' keys
	// are collected under their divisions' ids, then every division row is checked against that table.
	out.exec(
		"CREATE TEMP TABLE twin_wof (wof_id INTEGER NOT NULL, overture_id INTEGER NOT NULL, PRIMARY KEY (wof_id, overture_id)) WITHOUT ROWID"
	)

	out.exec(`INSERT OR IGNORE INTO twin_wof SELECT wof_id, overture_id FROM ${OVERTURE_WOF_MATCH_TABLE}`)

	out.exec(
		"CREATE TEMP TABLE twin_key (overture_id INTEGER NOT NULL, name_key TEXT NOT NULL, PRIMARY KEY (overture_id, name_key)) WITHOUT ROWID"
	)

	out.exec(
		`INSERT OR IGNORE INTO twin_key
		 SELECT t.overture_id, w.name_key FROM cand_stage w JOIN twin_wof t ON t.wof_id = w.spr_id`
	)

	const rowsDropped = Number(
		out
			.prepare(
				`DELETE FROM cand_stage
				 WHERE EXISTS (SELECT 1 FROM twin_key t WHERE t.overture_id = cand_stage.spr_id AND t.name_key = cand_stage.name_key)`
			)
			.run().changes
	)

	out.exec("DROP TABLE twin_key")
	out.exec("DROP TABLE twin_wof")

	return { matches: matches.length, rowsDropped }
}
