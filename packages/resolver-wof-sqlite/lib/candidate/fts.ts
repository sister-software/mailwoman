/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   FTS5-trigram fuzzy index over the candidate gazetteer's normalized `name_key`; raw SQL on purpose, since Kysely cannot express `create virtual table … using fts5`.
 */

import type { DatabaseClient } from "@mailwoman/sqlite/client"

/**
 * Name of the FTS5 trigram virtual table this module owns, on which the reader
 * conditions its fuzzy fallback.
 */
export const CANDIDATE_FTS_TABLE = "candidate_fts"

/**
 * Build (or rebuild) {@link CANDIDATE_FTS_TABLE} from the materialized `candidate` table. call
 * after the candidate B-tree is populated or against an existing candidate DB.
 */
export function createCandidateFTS<DB>(db: DatabaseClient<DB>): void {
	db.exec(`DROP TABLE IF EXISTS ${CANDIDATE_FTS_TABLE}`)
	db.exec(`CREATE VIRTUAL TABLE ${CANDIDATE_FTS_TABLE} USING fts5(name_key, tokenize='trigram')`)

	db.exec(
		`INSERT INTO ${CANDIDATE_FTS_TABLE}(name_key) SELECT DISTINCT name_key FROM candidate WHERE name_key IS NOT NULL`
	)
}
