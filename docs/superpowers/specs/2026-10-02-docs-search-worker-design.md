# Docs search worker design

Date: 2026-10-02. Status: awaiting operator review.

## Purpose

The documentation site at `https://mailwoman.ai` searches through Algolia DocSearch. Algolia's crawler
builds the index weekly, and its dashboard is the only way to operate it. This design replaces the
crawler, the hosted index and the DocSearch modal with three parts this repository owns: a record
manifest written by the docs build, a Cloudflare worker that ingests the manifest on a schedule and
answers queries, and a search modal in `@mailwoman/react`.

The work is complete when search on the docs site returns results from the worker, the acceptance
query list in this document passes, and the repository holds no Algolia configuration or dependency.

## Decisions

The operator selected these three on 2026-10-02.

- The index is hybrid. A D1 FTS5 table serves lexical queries and a Vectorize index serves embedding
  queries. The worker merges the two ranked lists.
- The scheduled run reads a manifest that the docs build emits. The worker parses no HTML.
- The search box is a modal owned by `@mailwoman/react`. The site stops depending on `@docsearch/react`.

## Properties kept from the Algolia crawler config

The current crawler config defines the behavior users have today. The replacement keeps these five
properties.

| Property                | Algolia setting                                       | Replacement                                                  |
| ----------------------- | ----------------------------------------------------- | ------------------------------------------------------------ |
| Heading-scoped records  | `lvl0` sidebar category, `lvl1`–`lvl6` from `h1`–`h6` | The manifest writer uses the same selectors                  |
| One hit per table row   | `lvl5` also matches `article td:first-child`          | The first cell of a row is a level-5 heading for that record |
| One hit per page        | `distinct: true` on `url`                             | The query collapses to the best record per URL               |
| Refusal of a large loss | `maxLostRecordsPercentage: 30`                        | Ingest throws when removals exceed 30% of the stored records |
| Typo tolerance          | One typo from 3 characters, two from 7                | A trigram FTS5 table answers when the primary table is empty |

Content selectors are `article p`, `article li` and `article td:last-child`. Algolia ranks by
heading level first and position on the page second; the lexical arm reproduces that with column
weights and a position tiebreak.

## Components

### Record manifest

A Docusaurus plugin at `docs/plugins/search-records/` runs in `postBuild`. It reads each built HTML
page under the output directory, extracts records with the selectors above, and writes
`search-records.json` to the output root. The site deploy then serves it at
`https://mailwoman.ai/search-records.json`.

The manifest has this shape. The types are declared in `packages/search-worker/lib/record.ts`, and
the plugin imports them with `import type`.

```ts
interface SearchManifest {
	/** Version of the record shape. The worker refuses a version it does not know. */
	schemaVersion: 1
	/** Commit the docs build ran from. */
	commit: string
	records: SearchRecord[]
}

interface SearchRecord {
	/** `sha256(url + "#" + anchor + "\n" + position)`, hex, truncated to 32 characters. */
	id: string
	/** Site-relative path without the anchor, such as `/docs/engineering/SCOPE`. */
	url: string
	/** Heading id the record links to. The empty string denotes the top of the page. */
	anchor: string
	/** Seven entries, `lvl0` through `lvl6`. An entry is `null` below the record's own level. */
	hierarchy: (string | null)[]
	/** Aggregated text under the heading. The empty string for a heading without body text. */
	content: string
	/** Depth of the deepest non-null hierarchy entry, 0 through 6. */
	level: number
	/** Zero-based order of the record on its page. */
	position: number
	/** `sha256` of `hierarchy` and `content`, hex. Ingest compares this value. */
	hash: string
}
```

The plugin excludes pages that carry a `noindex` robots meta tag and pages outside `article`
markup. The build fails when a page yields a duplicate `id`.

### Worker `@mailwoman/search-worker`

The workspace is `packages/search-worker`, private, deployed as `mailwoman-search` at
`search.mailwoman.ai`. Its layout follows `packages/license-worker`.

```text
packages/search-worker/
  wrangler.toml
  migrations/0001_records.sql
  lib/index.ts          fetch and scheduled entry points
  lib/app.ts            routing
  lib/env.ts            binding types
  lib/record.ts         manifest and record types
  lib/ingest.ts         manifest fetch, diff, refusal rules, writes
  lib/embed.ts          Workers AI embedding calls, batched
  lib/lexical.ts        FTS5 queries, primary and trigram
  lib/vector.ts         Vectorize query
  lib/fusion.ts         reciprocal rank fusion and URL collapse
  lib/snippet.ts        snippet and highlight ranges
  lib/routes/search.ts
  lib/routes/ingest.ts
```

Bindings:

- `SEARCH_DB`, a D1 database.
- `SEARCH_VECTORS`, a Vectorize index with 768 dimensions and cosine distance.
- `AI`, Workers AI, model `@cf/baai/bge-base-en-v1.5`. The docs are English; a second locale
  requires a multilingual model and a rebuilt Vectorize index.
- `SEARCH_LIMITER`, a rate limiter at 60 requests per 60 seconds per client address.
- `INGEST_TOKEN`, a secret set with `wrangler secret put`.
- `[vars]` `MANIFEST_URL` and `SITE_ORIGIN`.
- `[triggers]` `crons = ["0 */6 * * *"]`.

### D1 schema

```sql
CREATE TABLE records (
  id        TEXT PRIMARY KEY,
  url       TEXT NOT NULL,
  anchor    TEXT NOT NULL,
  hierarchy TEXT NOT NULL, -- JSON array of seven entries
  headings  TEXT NOT NULL, -- non-null hierarchy entries joined by newline, for FTS
  content   TEXT NOT NULL,
  level     INTEGER NOT NULL,
  position  INTEGER NOT NULL,
  hash      TEXT NOT NULL
);

CREATE VIRTUAL TABLE records_fts USING fts5(
  headings, content, content='records', content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE VIRTUAL TABLE records_trigram USING fts5(
  headings, content, content='records', content_rowid='rowid',
  tokenize='trigram'
);

CREATE TABLE ingest_runs (
  started_at TEXT PRIMARY KEY,
  commit_sha TEXT NOT NULL,
  added INTEGER NOT NULL, changed INTEGER NOT NULL, removed INTEGER NOT NULL,
  outcome TEXT NOT NULL -- 'applied', 'unchanged', or 'refused: <reason>'
);
```

Triggers on `records` keep both FTS tables in step with inserts, updates and deletes. The `porter`
tokenizer supplies the plural folding that Algolia's `ignorePlurals` provided.

### Ingest

The scheduled handler and `POST /ingest` run the same function.

1. Fetch `MANIFEST_URL`. A non-200 status, a body that fails to parse, or an unknown `schemaVersion`
   throws, and the run records `refused` with the reason. The stored index stays as it was.
2. Read `id` and `hash` for every stored record. Classify each manifest record as added, changed or
   unchanged, and each stored record absent from the manifest as removed.
3. When the stored index holds at least one record and removals exceed 30% of the stored count, throw
   and record `refused`. `POST /ingest?force=1` skips this rule for a deliberate restructuring.
4. Embed added and changed records in batches. The embedded text is the heading path followed by the
   content. A failed batch throws before any write.
5. Upsert the Vectorize entries, then apply the D1 upserts and deletes in one `batch` call, then
   delete removed Vectorize entries.
6. Record the run in `ingest_runs` with its counts.

A run with zero differences records `unchanged` and makes one fetch and one D1 read.

Step 5 writes to two stores that share no transaction. A run interrupted between the Vectorize upsert
and the D1 batch leaves vectors whose D1 rows are stale or missing. The D1 `hash` is the record of
what was applied, so the following run classifies those records as changed and rewrites them. The
query path drops a vector match whose `id` has no D1 row.

`POST /ingest` requires `Authorization: Bearer <INGEST_TOKEN>`. The docs deploy workflow calls it
after the site publishes, so a deploy reaches the index within one request, and the cron covers a
missed call.

### Query

`GET /search?q=<text>&limit=<n>` with `limit` from 1 to 20 and a default of 8. `q` is trimmed and
refused with status 400 when it is empty or longer than 200 characters.

1. The lexical arm and the vector arm run concurrently.
2. The lexical arm quotes each token of `q`, appends `*` to the last token, and queries `records_fts`
   ordered by `bm25(records_fts, 10.0, 1.0)`, then `level`, then `position`, for 40 rows. When that
   returns zero rows and `q` has at least 3 characters, it queries `records_trigram` in the same way.
3. The vector arm embeds `q` and queries Vectorize for the nearest 40 entries, then reads their rows
   from D1.
4. Reciprocal rank fusion scores each record as the sum of `1 / (60 + rank)` over the arms that
   returned it.
5. The worker keeps the highest-scoring record per `url` and returns the first `limit`.

```ts
interface SearchResponse {
	query: string
	/** Which arms contributed. `vector` is `"failed"` when the embedding or Vectorize call threw. */
	arms: { lexical: "primary" | "trigram" | "empty"; vector: "ok" | "failed" }
	hits: SearchHit[]
}

interface SearchHit {
	url: string
	anchor: string
	hierarchy: (string | null)[]
	/** At most 160 characters of content around the first match. */
	snippet: string
	/** Character ranges within `snippet` that matched a query token. */
	highlights: [start: number, end: number][]
}
```

A failed vector arm yields a 200 response with lexical hits and `arms.vector` set to `"failed"`. A
failed lexical arm yields status 502, because D1 also holds the rows the vector arm needs.

Responses carry `Access-Control-Allow-Origin` for `SITE_ORIGIN` and for `http://localhost:3000`, and
`Cache-Control: public, max-age=300`. A request past the rate limit receives status 429.

### Search modal

`@mailwoman/react` gains `search/SearchModal` and a `search/client` module that calls the worker and
returns `SearchResponse`. The modal:

- opens on `Ctrl+K`, `Cmd+K` and `/`;
- sends the query 150 ms after the last keystroke and aborts the previous request;
- groups hits by `hierarchy[0]` and renders the heading path with the snippet below it;
- states the condition in words when the request fails or returns zero hits.

The modal is built from native elements, and the platform supplies the behavior those elements
define.

- The container is a `<dialog>` opened with `showModal()`. The browser supplies the focus trap, the
  inert background, the `::backdrop`, the close on `Escape` and the return of focus to the navbar
  button. The component adds no focus-trap code and no `role="dialog"` attribute. A click on the
  backdrop closes the dialog through `closedby="any"` where the browser supports it and through a
  click handler on the `<dialog>` element elsewhere.
- The query field is `<input type="search">` inside a `<form role="search">`. It carries
  `role="combobox"`, `aria-autocomplete="list"`, `aria-expanded`, `aria-controls` for the result list
  and `aria-activedescendant` for the selected hit. DOM focus stays on the input for the whole
  session.
- The result list is an element with `role="listbox"`. Each `hierarchy[0]` group has `role="group"`
  and an `aria-labelledby` reference to its heading. Each hit has `role="option"`, a stable `id` and
  `aria-selected`, and contains an `<a href>` so that a pointer click, a middle click and "open in new
  tab" navigate as ordinary links.
- `ArrowDown` and `ArrowUp` move `aria-activedescendant` and wrap at the ends. `Home` and `End` select
  the first and last hit. `Enter` navigates to the selected hit.
- An `aria-live="polite"` region announces the hit count, the zero-hit condition and a request
  failure.

`docs` swizzles the theme `SearchBar` to render a navbar button that mounts the modal. The worker
origin comes from a `customFields.searchOrigin` entry in `docs/docusaurus.config.ts`. The `algolia`
block is deleted from that file, and the Algolia search theme is removed from the docs dependencies.

## Repository wiring

- Add `packages/search-worker` to the root `ci:workers` script and to `.github/workflows/deploy.yml`,
  with the same dependency-closure rule `license-worker` uses.
- Add the manifest fetch-and-ingest call to the docs deploy job.
- Register the workspace as private following `packages/release-kit/AGENTS.md`, and add its row to
  `docs/engineering/reference/workspaces.mdx`.
- Update the workspace counts in `AGENTS.md`.
- Create the D1 database and the Vectorize index with `wrangler` before the first deploy. The operator
  runs those commands, because they create billed Cloudflare resources.

## Tests

Fast suite, beside each module:

- `ingest.test.ts`: the added, changed, removed and unchanged classification; refusal above 30%
  removals; acceptance at exactly 30%; refusal of an unreadable manifest and of an unknown
  `schemaVersion`; the first ingest into an empty index.
- `fusion.test.ts`: fusion order for records in one arm and in both; collapse to one record per URL.
- `lexical.test.ts`: query construction, including quoting of FTS5 operator characters in user input.
- `snippet.test.ts`: snippet bounds and highlight ranges.
- `routes/search.test.ts`: status 400 for an empty or oversized `q`; the response when the vector arm
  throws.
- The plugin's extraction test reads fixture HTML that contains a heading hierarchy and a reference
  table, and asserts one record per table row.

Integration suite: `search.integration.test.ts` builds the index in a local D1 through Miniflare from a
manifest of the real docs build, with the vector arm stubbed, and runs the acceptance list.

## Acceptance list

Each query must return the expected page within the first 3 hits. The operator may extend the list
during review with queries the operator runs on the current site.

| Query                   | Expected page                                       |
| ----------------------- | --------------------------------------------------- |
| `decoder grammar`       | `/docs/engineering/reference/decoder-grammar`       |
| `ComponentTag`          | `/docs/engineering/reference/SCHEMA`                |
| `jurisdiction coverage` | `/docs/engineering/reference/jurisdiction-coverage` |
| `layer manifest`        | `/docs/engineering/reference/layer-interface`       |
| `tier-1 regression`     | `/docs/engineering/CONTRIBUTING_MODEL_WORK`         |
| `jurisdction coverage`  | `/docs/engineering/reference/jurisdiction-coverage` |

The last row is misspelled on purpose and exercises the trigram table. The exact URL paths are to be
confirmed against the built site when the manifest plugin first runs.

## Measurements the implementation plan must take first

These values are unknown today, and two design points depend on them.

1. The record count of the current docs build. Workers AI embeds a bounded number of texts per call,
   and one worker invocation has a subrequest limit. When the first full ingest exceeds one
   invocation, the first load runs from a local command against the remote bindings and the worker
   handles only incremental runs.
2. Whether the D1 runtime accepts `tokenize='trigram'`. When it does not, typo tolerance falls to the
   vector arm alone, and the acceptance list keeps the misspelled row to show the result.
3. Whether `https://mailwoman.ai` serves pages outside the Docusaurus build that the Algolia index
   holds today. Such pages leave the index under this design.

## Out of scope

- Search inside the Earth, Moon and Mars applications.
- Query analytics.
- Versioned or localized docs facets. The Algolia index declares `version` and `language` facets and
  the site publishes one version in one language.

## Retirement of Algolia

After the worker serves production search for one week without a refused ingest, delete the Algolia
crawler and application, and revoke the crawler API key and the search key that appears in
`docs/docusaurus.config.ts` history.
