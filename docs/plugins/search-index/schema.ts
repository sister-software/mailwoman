/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The search index schema. The FTS5 virtual tables are external-content tables over `records` and
 *   `terms`, so the text is stored once. `porter unicode61` folds plurals; `trigram` over the vocabulary
 *   supports typo correction against indexed terms rather than against page content.
 */

/**
 * The tables a query reads.
 *
 * The FTS5 virtual tables are queried with raw `MATCH` statements and have no entry.
 */
export interface SearchIndexDatabase {
	records: {
		id: string
		url: string
		anchor: string
		hierarchy: string
		headings: string
		content: string
		level: number
		position: number
	}
	terms: { term: string; documents: number }
	build: { commit_sha: string; built_at: string; records: number }
}

/**
 * Creates the tables and the FTS5 virtual tables, all empty.
 */
export const SCHEMA_SQL = `
CREATE TABLE records (
  id        TEXT PRIMARY KEY,
  url       TEXT NOT NULL,
  anchor    TEXT NOT NULL,
  hierarchy TEXT NOT NULL,
  headings  TEXT NOT NULL,
  content   TEXT NOT NULL,
  level     INTEGER NOT NULL,
  position  INTEGER NOT NULL
);
CREATE VIRTUAL TABLE records_fts USING fts5(
  headings, content, content='records', content_rowid='rowid', tokenize='porter unicode61'
);
CREATE TABLE terms (term TEXT PRIMARY KEY, documents INTEGER NOT NULL);
CREATE VIRTUAL TABLE terms_trigram USING fts5(term, content='terms', content_rowid='rowid', tokenize='trigram');
CREATE TABLE build (commit_sha TEXT NOT NULL, built_at TEXT NOT NULL, records INTEGER NOT NULL);
`

/**
 * Fills both FTS tables and the vocabulary after `records` holds every row.
 *
 * `fts5vocab` in `row` mode yields each term once with the number of rows that contain it.
 */
export const FILL_SQL = `
INSERT INTO records_fts (rowid, headings, content) SELECT rowid, headings, content FROM records;
CREATE VIRTUAL TABLE temp.vocab USING fts5vocab(main, records_fts, row);
INSERT INTO terms (term, documents) SELECT term, doc FROM temp.vocab WHERE length(term) >= 3;
DROP TABLE temp.vocab;
INSERT INTO terms_trigram (rowid, term) SELECT rowid, term FROM terms;
INSERT INTO records_fts (records_fts) VALUES ('optimize');
INSERT INTO terms_trigram (terms_trigram) VALUES ('optimize');
`
