# Docs search design

Date: 2026-10-02, revised 2026-10-03 after the read-strategy probe. Status: approved for planning.

## Purpose

The documentation site at `https://mailwoman.ai` searches through Algolia DocSearch. Algolia's crawler
builds the index weekly, and its dashboard is the only way to operate it. This design replaces the
crawler, the hosted index and the DocSearch modal with two parts this repository owns: a SQLite search
index written by the docs build and published with the site, and a search modal in `@mailwoman/react`
that queries that index in the browser through `@sqlite.org/sqlite-wasm`.

The work is complete when search on the docs site returns results from the published index, the
acceptance query list in this document passes against a real build, and the repository holds no Algolia
configuration or dependency.

## Decisions

- **The index is a static file.** The docs build writes it, GitHub Pages serves it, and the browser
  queries it. There is no server, schedule, ingest or secret. The 2026-10-02 design put the index in a
  Cloudflare worker with D1 and Vectorize; the probe below replaced it.
- **The browser fetches the file whole.** The probe measured a range VFS against a whole-file fetch on
  the real index and the whole file won; the numbers are under "Probe".
- **The index is lexical.** FTS5 with BM25 ranking, prefix matching on the last token, and typo
  correction against the index vocabulary. A vector arm is out of scope; the result assembly in
  `search.ts` is the point where a second ranked list would merge if one is added later.
- **The search box is a modal owned by `@mailwoman/react`**, built on `<dialog>`, `<input type="search">`
  and the ARIA combobox pattern. The site stops depending on `@docsearch/react`.
- **The worker that already runs sqlite-wasm in the browser gains a whole-file open.**
  `packages/resolver-wof-wasm/lib/httpvfs/range-worker.ts` runs SQLite 3.53 over an HTTP range VFS.
  The same worker, protocol, client and staged runtime serve the search index with one more open
  strategy, so the docs site stages one SQLite runtime.

## Probe, 2026-10-03

Measured in headless Chromium against a local static server, three runs per arm with a fresh browser
context each; the runs agreed within 3%. `broadband` is CDP emulation of a 100 ms round trip at
10 Mbit/s. The session is the six acceptance queries typed one character at a time, 90 keystrokes.
The index was built from the docs at `caef32d7b`: 181 pages, 164 URLs, 2,173 records, of which 1,055
are table rows.

| Network   | Strategy            | First result | Bytes before first result | Requests before first result | Keystroke p90 / max |
| --------- | ------------------- | ------------ | ------------------------- | ---------------------------- | ------------------- |
| broadband | range VFS, 64 KiB   | 6,073 ms     | 1.89 MB                   | 29                           | 4.9 / 3,163 ms      |
| broadband | range VFS, 16 KiB   | 7,817 ms     | 0.86 MB                   | 53                           | 7.6 / 15,141 ms     |
| broadband | whole file, 4.06 MB | 3,918 ms     | 4.06 MB                   | 1                            | 32 / 102 ms         |

An FTS5 prefix query walks the term index and the join reads scattered `records` pages, so the range
VFS reads 47% of the file in 29 sequential round trips before the first result. The whole file
compresses to 1.30 MB with gzip and 1.00 MB with brotli; the range VFS cannot use compression.

A trigram FTS5 table over the content was 6.34 MB of a 10.47 MB file, and on `jurisdction coverage`
it ranked a long unrelated record first, because an `OR` of trigrams over content favors long records.
This design corrects typos against the vocabulary instead.

## Components

### Index file

The docs build writes `search-index.db.gz`: a SQLite database, gzip-compressed, at the site root. The
browser decompresses it with `DecompressionStream("gzip")`, which every target browser implements, so
the file reaches the user compressed whichever content types the host compresses on its own. Node's
`zlib.gzipSync` at level 9 writes it.

Pages are emitted as `<route>.html` because `trailingSlash` is `false`. The writer reads every
`.html` under the build directory except `404.html`, derives the URL by removing the extension and a
trailing `/index`, and extracts records with the rules below. `/404.html` is skipped, and any other
page that fails to read throws.

Extraction rules, carried over from the Algolia crawler config:

- `lvl0` is the text of the last element with the classes `menu__link--sublist` and
  `menu__link--active`, or with `navbar__link--active`, and `"Documentation"` otherwise.
- Inside `article`, an `h1` through `h6` starts a record at that level and resets deeper levels. A
  heading's `id` is the record's anchor; an `h1` record has the empty anchor.
- A `tr` whose cells are `td` is a level-5 record whose heading is the first cell's text and whose
  content is the last cell's text. Each row of a reference table is therefore one hit.
- A `p` or `li` appends its text to the current record. A `li` that contains a `p` is skipped, so the
  paragraph's text is counted once.
- A page with a robots meta tag containing `noindex`, or without an `article`, yields zero records.
- The record `id` is the first 32 hex characters of `sha256(url + "#" + anchor + "\n" + position)`, so two
  headings that share an `id` still yield distinct records. The build fails on a duplicate `id` and on a
  build that yields zero records.

### Schema

```sql
CREATE TABLE records (
  id        TEXT PRIMARY KEY,
  url       TEXT NOT NULL,
  anchor    TEXT NOT NULL,
  hierarchy TEXT NOT NULL, -- JSON array of seven entries, lvl0 through lvl6, null below the record's level
  headings  TEXT NOT NULL, -- the non-null hierarchy entries joined by newline
  content   TEXT NOT NULL,
  level     INTEGER NOT NULL,
  position  INTEGER NOT NULL
);

CREATE VIRTUAL TABLE records_fts USING fts5(
  headings, content, content='records', content_rowid='rowid', tokenize='porter unicode61'
);

-- Every distinct indexed term with its document frequency, materialized from fts5vocab at build time.
CREATE TABLE terms (term TEXT PRIMARY KEY, documents INTEGER NOT NULL);

CREATE VIRTUAL TABLE terms_trigram USING fts5(term, content='terms', content_rowid='rowid', tokenize='trigram');

CREATE TABLE build (commit_sha TEXT NOT NULL, built_at TEXT NOT NULL, records INTEGER NOT NULL);
```

The `porter` tokenizer supplies the plural folding Algolia's `ignorePlurals` provided. The writer
fills the FTS tables after the rows, runs `optimize` on each, and `VACUUM`s. The index has no `hash`
column, because the whole file is rebuilt and republished with every site deploy.

### Query

The query code is pure TypeScript over one interface, so the same functions run in the browser and in
the Node tests:

```ts
interface SearchDatabase {
	query<Row>(sql: string, parameters?: readonly SQLValue[]): Promise<Row[]>
}
```

`RangeDatabase` in `packages/resolver-wof-wasm/lib/httpvfs/database.ts` satisfies it in the browser,
and a `node:sqlite` adapter satisfies it in tests.

1. Tokens are the whitespace-separated parts of the text that contain a letter or a digit. Each token
   becomes a quoted FTS5 string, with `*` after the last one, so user text never reaches the FTS5
   parser as an operator, a column filter or a bare `*`.
2. The primary query reads `records_fts` ordered by `bm25(records_fts, 10.0, 1.0)`, then `level`, then
   `position`, for 40 rows.
3. When the primary query returns zero rows, each token of at least three characters is corrected:
   `terms_trigram` is queried with the `OR` of the token's three-character windows for 10 candidates,
   and the candidate with the smallest Damerau-Levenshtein distance that is at most 2, and at most
   one for a token under 6 characters, replaces the token. The primary query runs again with the
   corrected tokens, and the response reports the correction. A term that shares no three-character
   window with the token is never proposed, so a transposition inside a word of four letters or fewer
   is not corrected.
4. Hits are the first record per URL, up to `limit`, with a 160-character snippet around the first
   token match and the character ranges that matched.

```ts
interface SearchResponse {
	query: string
	/** The query actually run when a token was corrected, otherwise absent. */
	corrected?: string
	hits: SearchHit[]
}

interface SearchHit {
	url: string
	anchor: string
	hierarchy: (string | null)[]
	snippet: string
	highlights: [start: number, end: number][]
}
```

### Browser database

`openWholeDatabase(databaseURL, runtimeBaseURL)` in `packages/resolver-wof-wasm/lib/httpvfs/database.ts`
returns the same `RangeDatabase` handle as `openRangeDatabase`. The worker protocol's `open` request
gains `strategy: "range" | "whole"`. For `whole`, the worker fetches the URL, inflates the body through
`DecompressionStream("gzip")` when its first two bytes are the gzip magic number `1f 8b`, and opens the
bytes with `sqlite3_deserialize` into an in-memory database. The body's leading bytes decide inflation, so the
open works whether or not the host sends `Content-Encoding: gzip`. The open then reads
`sqlite_master`, so a corrupt file fails the open rather than the first query. `bytesRead()` reports the decompressed size. The index therefore runs off the main
thread, and the modal stays responsive during a query.

The docs site stages the worker and runtime under `/mailwoman/sqlite/` already, through the
`runtime-assets` plugin.

### Search modal

`@mailwoman/react` gains `search/SearchModal` and `search/types`. The modal takes a
`search(q: string, signal: AbortSignal): Promise<SearchResponse>` function, so the package depends on
neither the index nor sqlite-wasm. The modal:

- opens on `Ctrl+K`, `Cmd+K` and `/`;
- sends the query 150 ms after the last keystroke and aborts the previous request;
- groups hits by `hierarchy[0]` and renders the heading path with the snippet below it;
- shows the corrected query when `corrected` is present;
- states the condition in words when the request fails or returns zero hits;
- announces "Loading the search index…" when a request has run for 300 ms without a response.

The modal is built from native elements, and the platform supplies the behavior those elements
define.

- The container is a `<dialog>` opened with `showModal()`. The browser supplies the focus trap, the
  inert background, the `::backdrop`, the close on `Escape` and the return of focus to the navbar
  button. The component adds no focus-trap code and no `role="dialog"` attribute. A click whose target
  is the dialog element itself landed on the backdrop and closes the dialog.
- The query field is `<input type="search">` inside a `<form role="search">`. It carries
  `role="combobox"`, `aria-autocomplete="list"`, `aria-expanded`, `aria-controls` for the result list
  and `aria-activedescendant` for the selected hit. DOM focus stays on the input for the whole
  session.
- The result list is an element with `role="listbox"`. Each `hierarchy[0]` group has `role="group"`
  and an `aria-labelledby` reference to its heading. Each hit is an `<a href>` carrying `role="option"`, a
  stable `id` and `aria-selected`, so a pointer click, a middle click and "open in new tab" navigate as
  ordinary links, and an axe-core audit reports no nested interactive element.
- `ArrowDown` and `ArrowUp` move `aria-activedescendant` and wrap at the ends. `Home` and `End` select
  the first and last hit. `Enter` navigates to the selected hit once the results answer the typed
  query.
- An `aria-live="polite"` region announces the hit count, the zero-hit condition, a request failure,
  and the loading of the index when a request runs for 300 ms or more.

### Site wiring

`docs/src/theme/SearchBar.tsx` renders the navbar button and the modal. When the modal first opens it calls
`openWholeDatabase("/search-index.db.gz", "/mailwoman/sqlite/")` and keeps the handle for the page's
lifetime; a second open reuses it. The `search` function it passes composes the query code over that
handle. The `algolia` block is deleted from `docs/docusaurus.config.ts`.

The query code and the index writer live in the docs workspace, under `docs/src/search/` and
`docs/plugins/search-index/`, because the docs site is their only consumer. The record and response
types live in `@mailwoman/react/search/types`, and the docs code imports them with `import type`.

## Tests

- `docs/plugins/search-index/extract.test.ts`: heading records, table rows, hierarchy reset, duplicate
  heading ids, stable ids and hashes, the default category, `noindex` and article-less pages.
- `docs/plugins/search-index/write-index.test.ts`: writes an index from fixture records, reopens it with
  `node:sqlite`, and checks the row counts, the `terms` table and the gzip round trip.
- `docs/src/search/lexical.test.ts`: token filtering, quoting, prefix marking, and that every FTS5
  syntax case (`"`, `*`, `:`, `-`, `AND`, `NEAR(`, `(`, `^`) returns rows or an empty list.
- `docs/src/search/correct.test.ts`: a one-character typo is corrected, a word under six characters
  accepts one edit only, and a token with no close term is left as is.
- `docs/src/search/snippet.test.ts`: snippet bounds and highlight ranges.
- `docs/src/search/search.test.ts`: one hit per URL, the limit, the `corrected` field, and an empty
  response for punctuation-only text.
- `docs/src/search/search.integration.test.ts`: the acceptance list against the shipped
  `docs/build/search-index.db.gz`, inflated and opened read-only. The test checks that the `records`
  table holds more than 1,000 rows and that the `build` row's count equals it. In CI it throws when the
  file is absent; elsewhere it skips.
- `packages/react/lib/search/SearchModal.test.tsx`: the dialog and combobox attributes, groups and
  options, arrow-key wrap and Enter, Enter ignored before the results answer the typed query, Escape,
  stale-response ordering, the loading announcement, and the live region.
- `docs/test/e2e/search.spec.ts`, the Playwright `search` project, opens the modal on the built site,
  types a query, and asserts a hit. The docs-build workflow runs it with `yarn workspace @mailwoman/docs
  test:search` after the acceptance queries, and the Playwright config serves `docs/build` on port 7770.

## Acceptance list

Each query must return the expected page within the first 3 hits. The URLs are published pages
observed in the 2026-10-03 build; the implementation confirms each against the index before the list
is final, and the operator may extend it.

| Query                  | Expected page                                                               |
| ---------------------- | --------------------------------------------------------------------------- |
| `locales and tiers`    | `/docs/developers/reference/locales-and-tiers`                              |
| `viterbi`              | `/docs/developers/knowledge-base/address-intelligence/decoding-and-viterbi` |
| `validate addresses`   | `/docs/developers/how-to/validate-addresses`                                |
| `mcp server`           | `/docs/developers/how-to/use-the-mcp-server`                                |
| `parse in the browser` | `/docs/developers/tutorials/parse-in-the-browser`                           |
| `vitrebi`              | `/docs/developers/knowledge-base/address-intelligence/decoding-and-viterbi` |

The last row is misspelled on purpose and exercises the vocabulary correction.

## Out of scope

- A vector arm. `search.ts` is the merge point if one is added.
- Search inside the Earth, Moon and Mars applications. The modal and the query code are reusable by
  them; the index is the docs site's.
- Query analytics, and versioned or localized facets.

## Retirement of Algolia

After the site serves its own search for one week, delete the Algolia crawler and application, and
revoke the crawler API key and the search key that appears in `docs/docusaurus.config.ts` history.
