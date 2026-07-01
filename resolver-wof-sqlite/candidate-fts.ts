/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   FTS5-TRIGRAM fuzzy index over the candidate gazetteer's `name_key` — the typo-tolerant fallback
 *   the exact `name_key` B-tree probe structurally can't do (a misspelling breaks the normalized
 *   key, so the contiguous-probe lookup returns nothing). It indexes the NORMALIZED key (not the
 *   raw `name`), so a diacritic-stripped query (`munchen`) trigram-matches the stored `munchen`
 *   rather than missing a raw `München`. The trigram tokenizer makes MATCH a substring/fuzzy
 *   operation; the reader ({@link WOFCandidateTableLookup}) OR's the query's trigrams to fetch a
 *   loose set, then re-ranks by the SAME `trigramJaccard` the admin/FTS backend uses, so a typo
 *   resolves identically on either.
 *
 *   This is what unifies the two gazetteers: the candidate B-tree stays the common,
 *   byte-range-optimal fast path (the browser's contiguous probe), and FTS5 is consulted ONLY on an
 *   exact+strip miss — so its scattered postings cost is rare/amortized, and one DB serves both the
 *   browser and the server.
 *
 *   Raw SQL on purpose: Kysely can't express `CREATE VIRTUAL TABLE … USING fts5` (the repo's
 *   FTS5-stays-raw rule). Indexing DISTINCT `name_key` keeps the index to unique normalized forms
 *   (a name_key fans out to many candidate rows — placetypes, regions, aliases — but the fuzzy
 *   fallback only needs to recover the name_key, then re-probes the B-tree for its rows).
 */

import type { DatabaseSync } from "node:sqlite"

/**
 * Name of the FTS5 trigram virtual table this module owns. The reader gates its fuzzy fallback on it.
 */
export const CANDIDATE_FTS_TABLE = "candidate_fts"

/**
 * Build (or rebuild) {@link CANDIDATE_FTS_TABLE} from the materialized `candidate` table. Call after the candidate
 * B-tree is populated (build pipeline) or against an existing candidate DB (migration).
 */
export function createCandidateFTS(db: DatabaseSync): void {
	db.exec(`DROP TABLE IF EXISTS ${CANDIDATE_FTS_TABLE}`)
	db.exec(`CREATE VIRTUAL TABLE ${CANDIDATE_FTS_TABLE} USING fts5(name_key, tokenize='trigram')`)
	db.exec(
		`INSERT INTO ${CANDIDATE_FTS_TABLE}(name_key) SELECT DISTINCT name_key FROM candidate WHERE name_key IS NOT NULL`
	)
}
