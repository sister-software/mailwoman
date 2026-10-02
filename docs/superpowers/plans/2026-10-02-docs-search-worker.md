# Docs Search Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Algolia DocSearch on `https://mailwoman.ai` with a record manifest written by the docs build, a Cloudflare worker that ingests it on a schedule and answers hybrid queries, and a native-element search modal in `@mailwoman/react`.

**Architecture:** The docs build writes `search-records.json`. The worker `@mailwoman/search-worker` diffs that manifest against D1 by content hash, embeds changed records through Workers AI, and stores text in D1 FTS5 tables and vectors in Vectorize. `GET /search` runs a lexical arm and a vector arm concurrently, merges them by reciprocal rank fusion, and collapses to one hit per URL. The modal is a `<dialog>` with an `<input type="search">` combobox.

**Tech Stack:** Cloudflare Workers, D1 (SQLite FTS5), Vectorize, Workers AI `@cf/baai/bge-base-en-v1.5`, Hono, Zod, Vitest with `@cloudflare/vitest-pool-workers`, Docusaurus 3 plugin API, `htmlparser2`, React 19.

**Spec:** `docs/superpowers/specs/2026-10-02-docs-search-worker-design.md`

## Global Constraints

- Read `AGENTS.md` at the repository root, `packages/sqlite/AGENTS.md`, and `packages/release-kit/AGENTS.md` before the first edit.
- Relative imports include `.ts` or `.tsx`. Use `import type` for types. No `enum`, no constructor parameter properties.
- Acronyms are capitalized as a whole component: `collapseByURL`, `parseJSON`, `recordID`.
- A test sits beside its module as `<name>.test.ts`. The slow suite uses `<name>.integration.test.ts`.
- Filesystem access in Node-side code goes through `@mailwoman/core/fs`; paths use `path-ts`.
- The worker runs without `nodejs_compat`. Worker code imports no Node builtin.
- Manifest `schemaVersion` is `1`. Removal refusal threshold is 30% of stored records, refused only when removals exceed it.
- Lexical arm reads 40 rows; vector arm reads 40 entries; fusion constant is 60; `limit` is 1 to 20 with default 8; `q` is at most 200 characters.
- Vectorize index: 768 dimensions, cosine distance. The embedding model is `@cf/baai/bge-base-en-v1.5`.
- Rate limit: 60 requests per 60 seconds per client address. Cron: `0 */6 * * *`.
- Response caching: `Cache-Control: public, max-age=300` on `/search`; `no-store` on `/ingest` and `/health`.
- The modal uses `<dialog>` with `showModal()`, `<input type="search">` with `role="combobox"`, and a `role="listbox"` result list. It adds no focus-trap code and no `role="dialog"` attribute.
- Shell commands may not write files inside the repository; a `PreToolUse` hook refuses them. Create and edit files with the file-editing tool.
- Stage by path. Never run `git add -A`.
- Run `git add` on a new file before `yarn lint`, because the repository checks read tracked files.

## Review Focus

1. A query that contains FTS5 syntax (`"`, `*`, `:`, `-`, `AND`, `NEAR(`) returns status 200 with hits or an empty list, and never a 500 from an FTS5 syntax error. Test in Task 4.
2. A query of punctuation only (`"--"`, `"***"`) returns status 200 with zero hits and `arms.lexical` equal to `"empty"`. Test in Task 7.
3. A manifest URL that answers status 200 with an HTML body (a single-page-application fallback for a missing file) is refused, and the stored records are unchanged. Test in Task 3.
4. A slow response for an earlier query that arrives after the response for a later query does not replace the later results in the modal. Test in Task 8.
5. A page with two headings that share an `id`, or a heading without an `id`, yields records with distinct `id` values and the build succeeds. Test in Task 2.

---

## File Structure

```text
packages/search-worker/
  package.json
  tsconfig.json
  tsconfig.test.json
  vitest.config.ts
  wrangler.toml                 production bindings
  wrangler.sandbox.toml         test-pool bindings: D1 and the rate limiter only
  migrations/0001_records.sql
  test/support/migrations.ts    applies D1 migrations in the test pool
  test/support/fakes.ts         in-memory Embedder and VectorStore
  test/support/records.ts       record and manifest builders for tests
  lib/index.ts                  fetch and scheduled entry points
  lib/app.ts                    Hono app and dependency type
  lib/env.ts                    binding types and validation
  lib/record.ts                 SearchRecord, SearchManifest, parseManifest
  lib/store.ts                  D1 reads and writes for records and ingest_runs
  lib/ingest.ts                 planIngest, removal refusal, runIngest
  lib/embed.ts                  Embedder and VectorStore interfaces and their Cloudflare implementations
  lib/lexical.ts                match-expression builders and the FTS5 queries
  lib/fusion.ts                 reciprocal rank fusion and URL collapse
  lib/snippet.ts                snippet window and highlight ranges
  lib/search.ts                 runs both arms and assembles SearchResponse
  lib/routes/search.ts
  lib/routes/ingest.ts
  lib/routes/health.ts
docs/plugins/search-records/
  extract.ts                    HTML to SearchRecord[]
  extract.test.ts
  plugin.ts                     postBuild writer
docs/src/theme/SearchBar.tsx    mounts the modal in the navbar
packages/react/lib/search.ts    directory module
packages/react/lib/search/client.ts
packages/react/lib/search/SearchModal.tsx
packages/react/lib/search/SearchModal.test.tsx
packages/react/lib/search/search.css
```

The vector store and the embedding model are injected as interfaces because the Vitest worker pool simulates D1 and rate limiters and does not simulate Vectorize or Workers AI.

---

### Task 1: Worker workspace, record types, and D1 schema

**Files:**

- Create: `packages/search-worker/package.json`, `tsconfig.json`, `tsconfig.test.json`, `vitest.config.ts`, `wrangler.sandbox.toml`
- Create: `packages/search-worker/migrations/0001_records.sql`
- Create: `packages/search-worker/lib/record.ts`, `lib/record.test.ts`
- Create: `packages/search-worker/lib/store.ts`, `lib/store.test.ts`
- Create: `packages/search-worker/test/support/migrations.ts`, `test/support/records.ts`

**Interfaces:**

- Produces: `SearchRecord`, `SearchManifest`, `SEARCH_SCHEMA_VERSION`, `parseManifest(value: unknown): SearchManifest`, `headingsText(record: SearchRecord): string` from `#record`.
- Produces from `#store`: `storedHashes(db: D1Database): Promise<Map<string, string>>`, `upsertStatements(db: D1Database, records: readonly SearchRecord[]): D1PreparedStatement[]`, `deleteStatements(db: D1Database, ids: readonly string[]): D1PreparedStatement[]`, `recordsByID(db: D1Database, ids: readonly string[]): Promise<Map<string, StoredRecord>>`, `StoredRecord` (a `SearchRecord` without `hash` semantics changes; same fields).
- Produces from `#test/support/records`: `record(overrides?: Partial<SearchRecord>): SearchRecord`, `manifest(records: SearchRecord[]): SearchManifest`.

- [ ] **Step 1: Create the workspace manifest**

`packages/search-worker/package.json`:

```json
{
	"name": "@mailwoman/search-worker",
	"version": "0.0.0",
	"private": true,
	"description": "The docs search worker: ingests the docs build's record manifest on a schedule and answers hybrid lexical and vector queries.",
	"license": "AGPL-3.0-only OR LicenseRef-Commercial",
	"contributors": [{ "name": "Teffen Ellis", "email": "teffen@sister.software" }],
	"type": "module",
	"imports": {
		"#test/*": "./test/*.ts",
		"#*": { "types": "./out/*.d.ts", "workerd": "./lib/*.ts", "node": "./lib/*.ts", "default": "./out/*.js" }
	},
	"exports": {
		"./package.json": "./package.json",
		"./*": { "types": "./out/*.d.ts", "node": "./lib/*.ts", "default": "./out/*.js" }
	},
	"scripts": {
		"dev": "wrangler dev -c wrangler.sandbox.toml",
		"migrate:production": "wrangler d1 migrations apply SEARCH_DB --remote",
		"test": "vitest run"
	},
	"dependencies": {
		"@mailwoman/core": "workspace:*",
		"hono": "^4.13.7",
		"zod": "^4.5.4"
	},
	"devDependencies": {
		"@cloudflare/vitest-pool-workers": "^0.22.0",
		"@cloudflare/workers-types": "^5.20260906.1",
		"@vitest/runner": "^4.1.11",
		"@vitest/snapshot": "^4.1.11",
		"vitest": "4.1.11",
		"wrangler": "^4.129.0"
	},
	"engines": { "node": ">=24.18.0" }
}
```

Copy `packages/license-worker/tsconfig.json` to `packages/search-worker/tsconfig.json` and change it in three places: remove `"jsx"`, remove `"resolveJsonModule"` and the `./lib/**/*.json` include, and set `"references": [{ "path": "../core" }]`. Copy `packages/license-worker/tsconfig.test.json` unchanged.

- [ ] **Step 2: Create the sandbox wrangler config and the Vitest config**

`packages/search-worker/wrangler.sandbox.toml`:

```toml
# Read by the test pool and by `wrangler dev`. It declares only the bindings Miniflare simulates.
# The Vectorize and Workers AI bindings exist in `wrangler.toml` alone, and tests inject fakes for them.

name = "mailwoman-search-sandbox"
main = "./lib/index.ts"
compatibility_date = "2026-08-22"

[vars]
SITE_ORIGIN = "https://mailwoman.ai"
MANIFEST_URL = "https://mailwoman.ai/search-records.json"

[[d1_databases]]
binding = "SEARCH_DB"
database_name = "mailwoman-search-sandbox"
database_id = "00000000-0000-0000-0000-000000000000"
migrations_dir = "migrations"

[[ratelimits]]
name = "SEARCH_LIMITER"
namespace_id = "1101"
simple = { limit = 60, period = 60 }
```

`packages/search-worker/vitest.config.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The worker's tests run under the Workers runtime through Miniflare, with a fresh D1 per test file.
 *   The root Vitest sweep excludes this workspace. CI runs it as its own step.
 */

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"

const migrations = await readD1Migrations(`${import.meta.dirname}/migrations`)

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.sandbox.toml" },
			miniflare: { bindings: { INGEST_TOKEN: "test-ingest-token", TEST_MIGRATIONS: migrations } },
		}),
	],
	test: {
		include: ["lib/**/*.test.ts"],
		exclude: ["lib/**/*.integration.test.ts"],
	},
})
```

Create `packages/search-worker/test/support/migrations.ts` with the same body as `packages/license-worker/test/support/migrations.ts`. Declare the `TEST_MIGRATIONS` binding type the same way the license worker's `test/` directory declares it; read that directory first and mirror its declaration file.

- [ ] **Step 3: Write the migration**

`packages/search-worker/migrations/0001_records.sql`:

```sql
CREATE TABLE records (
  id        TEXT PRIMARY KEY,
  url       TEXT NOT NULL,
  anchor    TEXT NOT NULL,
  hierarchy TEXT NOT NULL,
  headings  TEXT NOT NULL,
  content   TEXT NOT NULL,
  level     INTEGER NOT NULL,
  position  INTEGER NOT NULL,
  hash      TEXT NOT NULL
);

CREATE INDEX records_url ON records (url);

CREATE VIRTUAL TABLE records_fts USING fts5(
  headings, content, content='records', content_rowid='rowid', tokenize='porter unicode61'
);

CREATE VIRTUAL TABLE records_trigram USING fts5(
  headings, content, content='records', content_rowid='rowid', tokenize='trigram'
);

CREATE TRIGGER records_after_insert AFTER INSERT ON records BEGIN
  INSERT INTO records_fts (rowid, headings, content) VALUES (new.rowid, new.headings, new.content);
  INSERT INTO records_trigram (rowid, headings, content) VALUES (new.rowid, new.headings, new.content);
END;

CREATE TRIGGER records_after_delete AFTER DELETE ON records BEGIN
  INSERT INTO records_fts (records_fts, rowid, headings, content) VALUES ('delete', old.rowid, old.headings, old.content);
  INSERT INTO records_trigram (records_trigram, rowid, headings, content) VALUES ('delete', old.rowid, old.headings, old.content);
END;

CREATE TRIGGER records_after_update AFTER UPDATE ON records BEGIN
  INSERT INTO records_fts (records_fts, rowid, headings, content) VALUES ('delete', old.rowid, old.headings, old.content);
  INSERT INTO records_trigram (records_trigram, rowid, headings, content) VALUES ('delete', old.rowid, old.headings, old.content);
  INSERT INTO records_fts (rowid, headings, content) VALUES (new.rowid, new.headings, new.content);
  INSERT INTO records_trigram (rowid, headings, content) VALUES (new.rowid, new.headings, new.content);
END;

CREATE TABLE ingest_runs (
  started_at TEXT PRIMARY KEY,
  commit_sha TEXT NOT NULL,
  added      INTEGER NOT NULL,
  changed    INTEGER NOT NULL,
  removed    INTEGER NOT NULL,
  outcome    TEXT NOT NULL
);
```

- [ ] **Step 4: Write the failing record and store tests**

`packages/search-worker/test/support/records.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { SEARCH_SCHEMA_VERSION, type SearchManifest, type SearchRecord } from "#record"

let sequence = 0

export function record(overrides: Partial<SearchRecord> = {}): SearchRecord {
	sequence++

	return {
		id: `id-${sequence}`,
		url: `/docs/page-${sequence}`,
		anchor: "",
		hierarchy: ["Documentation", `Page ${sequence}`, null, null, null, null, null],
		content: "",
		level: 1,
		position: 0,
		hash: `hash-${sequence}`,
		...overrides,
	}
}

export function manifest(records: SearchRecord[]): SearchManifest {
	return { schemaVersion: SEARCH_SCHEMA_VERSION, commit: "0000000", records }
}
```

`packages/search-worker/lib/record.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { headingsText, parseManifest } from "#record"
import { manifest, record } from "#test/support/records"

describe("parseManifest", () => {
	it("returns a manifest whose records pass validation", () => {
		const input = manifest([record()])

		expect(parseManifest(input)).toEqual(input)
	})

	it("throws on a schema version it does not know", () => {
		expect(() => parseManifest({ ...manifest([]), schemaVersion: 2 })).toThrow()
	})

	it("throws on a hierarchy that does not have seven entries", () => {
		expect(() => parseManifest(manifest([record({ hierarchy: ["Documentation"] })]))).toThrow()
	})

	it("throws on a value that is not an object", () => {
		expect(() => parseManifest("<!doctype html>")).toThrow()
	})
})

describe("headingsText", () => {
	it("joins the non-null hierarchy entries by newline", () => {
		expect(headingsText(record({ hierarchy: ["A", "B", null, "C", null, null, null] }))).toBe("A\nB\nC")
	})
})
```

`packages/search-worker/lib/store.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { env } from "cloudflare:workers"
import { beforeAll, describe, expect, it } from "vitest"

import { deleteStatements, recordsByID, storedHashes, upsertStatements } from "#store"
import { applyMigrations } from "#test/support/migrations"
import { record } from "#test/support/records"

beforeAll(async () => {
	await applyMigrations(env.SEARCH_DB)
})

describe("the record store", () => {
	it("stores a record, reports its hash, and reads it back", async () => {
		const stored = record({ id: "store-a", content: "alpha", hash: "h1" })

		await env.SEARCH_DB.batch(upsertStatements(env.SEARCH_DB, [stored]))

		expect((await storedHashes(env.SEARCH_DB)).get("store-a")).toBe("h1")
		expect((await recordsByID(env.SEARCH_DB, ["store-a"])).get("store-a")).toEqual(stored)
	})

	it("replaces a record that has the same id", async () => {
		await env.SEARCH_DB.batch(upsertStatements(env.SEARCH_DB, [record({ id: "store-b", hash: "h1" })]))
		await env.SEARCH_DB.batch(upsertStatements(env.SEARCH_DB, [record({ id: "store-b", hash: "h2" })]))

		expect((await storedHashes(env.SEARCH_DB)).get("store-b")).toBe("h2")
	})

	it("deletes a record and its full-text rows", async () => {
		await env.SEARCH_DB.batch(upsertStatements(env.SEARCH_DB, [record({ id: "store-c", content: "zebrafish" })]))
		await env.SEARCH_DB.batch(deleteStatements(env.SEARCH_DB, ["store-c"]))

		const lexical = await env.SEARCH_DB.prepare("SELECT rowid FROM records_fts WHERE records_fts MATCH ?1")
			.bind('"zebrafish"')
			.all()

		expect((await storedHashes(env.SEARCH_DB)).has("store-c")).toBe(false)
		expect(lexical.results).toHaveLength(0)
	})

	it("matches a three-character substring through the trigram table", async () => {
		await env.SEARCH_DB.batch(upsertStatements(env.SEARCH_DB, [record({ id: "store-d", content: "jurisdiction" })]))

		const trigram = await env.SEARCH_DB.prepare("SELECT rowid FROM records_trigram WHERE records_trigram MATCH ?1")
			.bind('"isd"')
			.all()

		expect(trigram.results).toHaveLength(1)
	})
})
```

- [ ] **Step 5: Run the tests and confirm they fail**

Run: `yarn install && yarn workspace @mailwoman/search-worker test`
Expected: FAIL. Vitest reports that `#record` and `#store` cannot be resolved.

- [ ] **Step 6: Implement `record.ts` and `store.ts`**

`packages/search-worker/lib/record.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The record manifest the docs build writes and the worker ingests. One record is one heading-scoped
 *   section of one page, or one row of a reference table.
 */

import { z } from "zod"

export const SEARCH_SCHEMA_VERSION = 1

/**
 * The number of hierarchy entries: the sidebar category, then `h1` through `h6`.
 */
export const HIERARCHY_DEPTH = 7

const SearchRecordSchema = z.object({
	id: z.string().min(1).max(64),
	url: z.string().startsWith("/"),
	anchor: z.string(),
	hierarchy: z.array(z.string().nullable()).length(HIERARCHY_DEPTH),
	content: z.string(),
	level: z.number().int().min(0).max(6),
	position: z.number().int().min(0),
	hash: z.string().min(1),
})

const SearchManifestSchema = z.object({
	schemaVersion: z.literal(SEARCH_SCHEMA_VERSION),
	commit: z.string(),
	records: z.array(SearchRecordSchema),
})

export type SearchRecord = z.infer<typeof SearchRecordSchema>
export type SearchManifest = z.infer<typeof SearchManifestSchema>

/**
 * Validate a fetched manifest.
 *
 * @throws when the value is not a manifest of the version this worker reads.
 */
export function parseManifest(value: unknown): SearchManifest {
	return SearchManifestSchema.parse(value)
}

/**
 * The text of the record's heading path, one heading per line. This is the `headings` full-text column.
 */
export function headingsText(record: Pick<SearchRecord, "hierarchy">): string {
	return record.hierarchy.filter((entry): entry is string => entry !== null).join("\n")
}
```

`packages/search-worker/lib/store.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   D1 reads and writes for the record table. The statements are raw SQL because the writes go through
 *   `D1Database.batch`, which takes prepared statements and commits them together.
 */

import { parseJSON, stringifyJSON } from "@mailwoman/core/json"

import { headingsText, type SearchRecord } from "#record"

interface RecordRow {
	id: string
	url: string
	anchor: string
	hierarchy: string
	content: string
	level: number
	position: number
	hash: string
}

/**
 * D1 allows 100 bound parameters per statement.
 */
const ID_CHUNK = 90

export function rowToRecord(row: RecordRow): SearchRecord {
	return {
		id: row.id,
		url: row.url,
		anchor: row.anchor,
		hierarchy: parseJSON(row.hierarchy) as (string | null)[],
		content: row.content,
		level: row.level,
		position: row.position,
		hash: row.hash,
	}
}

export async function storedHashes(db: D1Database): Promise<Map<string, string>> {
	const { results } = await db.prepare("SELECT id, hash FROM records").all<{ id: string; hash: string }>()

	return new Map(results.map((row) => [row.id, row.hash]))
}

export function upsertStatements(db: D1Database, records: readonly SearchRecord[]): D1PreparedStatement[] {
	const statement = db.prepare(
		`INSERT INTO records (id, url, anchor, hierarchy, headings, content, level, position, hash)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
		 ON CONFLICT (id) DO UPDATE SET
		   url = excluded.url, anchor = excluded.anchor, hierarchy = excluded.hierarchy, headings = excluded.headings,
		   content = excluded.content, level = excluded.level, position = excluded.position, hash = excluded.hash`
	)

	return records.map((record) =>
		statement.bind(
			record.id,
			record.url,
			record.anchor,
			stringifyJSON(record.hierarchy),
			headingsText(record),
			record.content,
			record.level,
			record.position,
			record.hash
		)
	)
}

export function deleteStatements(db: D1Database, ids: readonly string[]): D1PreparedStatement[] {
	const statement = db.prepare("DELETE FROM records WHERE id = ?1")

	return ids.map((id) => statement.bind(id))
}

export async function recordsByID(db: D1Database, ids: readonly string[]): Promise<Map<string, SearchRecord>> {
	const found = new Map<string, SearchRecord>()

	for (let start = 0; start < ids.length; start += ID_CHUNK) {
		const chunk = ids.slice(start, start + ID_CHUNK)
		const placeholders = chunk.map((_, index) => `?${index + 1}`).join(", ")
		const { results } = await db
			.prepare(
				`SELECT id, url, anchor, hierarchy, content, level, position, hash FROM records WHERE id IN (${placeholders})`
			)
			.bind(...chunk)
			.all<RecordRow>()

		for (const row of results) found.set(row.id, rowToRecord(row))
	}

	return found
}
```

Confirm that `@mailwoman/core/json` exports `parseJSON` and `stringifyJSON` before use; `packages/license-worker/lib/index.ts` imports `stringifyJSON` from it.

- [ ] **Step 7: Run the tests and confirm they pass**

Run: `yarn workspace @mailwoman/search-worker test`
Expected: PASS, 9 tests.

This run answers spec measurement 2. A failure of the trigram test with an error that mentions the `trigram` tokenizer means the local D1 runtime lacks it. In that case stop and report to the operator before continuing, because Task 4 depends on that table.

- [ ] **Step 8: Commit**

```bash
git add packages/search-worker yarn.lock
git commit -m "Add the search worker workspace with its record types and D1 schema" -- packages/search-worker yarn.lock
```

---

### Task 2: Record manifest plugin

**Files:**

- Create: `docs/plugins/search-records/extract.ts`, `docs/plugins/search-records/extract.test.ts`, `docs/plugins/search-records/plugin.ts`
- Modify: `docs/docusaurus.config.ts` (the `plugins` array at line 130)
- Modify: `docs/package.json` (add `htmlparser2`, `domutils`, `domhandler` and `@mailwoman/search-worker` as dependencies)

**Interfaces:**

- Consumes: `SearchRecord`, `SearchManifest`, `SEARCH_SCHEMA_VERSION`, `HIERARCHY_DEPTH` from `@mailwoman/search-worker/record`.
- Produces: `extractRecords(html: string, url: string): SearchRecord[]`; a file `search-records.json` in the Docusaurus output directory.

Extraction rules, from the spec: `lvl0` is the text of the last element matching `.menu__link--sublist.menu__link--active` or `.navbar__link--active`, with `"Documentation"` as the default. Inside `article`, an `h1` through `h6` starts a record at that level. A `tr` whose cells are `td` starts a level-5 record whose heading is the first cell and whose content is the last cell. A `p` or `li` appends its text to the current record. A page with a robots meta tag that contains `noindex`, or without an `article` element, yields zero records.

- [ ] **Step 1: Write the failing test**

`docs/plugins/search-records/extract.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { extractRecords } from "@mailwoman/docs/plugins/search-records/extract"
import { describe, expect, test } from "vitest"

function page(article: string, head = ""): string {
	return `<html><head>${head}</head><body>
		<nav><a class="menu__link menu__link--sublist menu__link--active">Reference</a></nav>
		<article>${article}</article></body></html>`
}

describe("extractRecords", () => {
	test("starts a record at each heading and aggregates the text below it", () => {
		const records = extractRecords(
			page(`<h1>Decoder</h1><p>Intro text.</p><h2 id="objective">Objective</h2><p>First.</p><ul><li>Second.</li></ul>`),
			"/docs/decoder"
		)

		expect(records.map((record) => [record.level, record.anchor, record.content])).toEqual([
			[1, "", "Intro text."],
			[2, "objective", "First. Second."],
		])
		expect(records[1]?.hierarchy).toEqual(["Reference", "Decoder", "Objective", null, null, null, null])
		expect(records.map((record) => record.position)).toEqual([0, 1])
	})

	test("yields one level-5 record per table row, under the enclosing heading", () => {
		const records = extractRecords(
			page(`<h1>Coverage</h1><h2 id="rows">Rows</h2><table><tbody>
				<tr><td>Norway</td><td>ignored middle</td><td>Elected</td></tr>
				<tr><td>Sweden</td><td>x</td><td>Refused</td></tr></tbody></table>`),
			"/docs/coverage"
		)
		const rows = records.filter((record) => record.level === 5)

		expect(rows.map((record) => [record.hierarchy[5], record.content, record.anchor])).toEqual([
			["Norway", "Elected", "rows"],
			["Sweden", "Refused", "rows"],
		])
		expect(rows[0]?.hierarchy.slice(0, 3)).toEqual(["Reference", "Coverage", "Rows"])
	})

	test("resets deeper hierarchy entries when a shallower heading follows", () => {
		const records = extractRecords(page(`<h1>A</h1><h2>B</h2><h3>C</h3><h2>D</h2>`), "/docs/a")

		expect(records.at(-1)?.hierarchy).toEqual(["Reference", "A", "D", null, null, null, null])
	})

	test("gives distinct ids to headings that share an id or have none", () => {
		const records = extractRecords(page(`<h1>A</h1><h2 id="x">B</h2><h2 id="x">C</h2><h2>D</h2>`), "/docs/a")

		expect(new Set(records.map((record) => record.id)).size).toBe(records.length)
	})

	test("gives the same id and hash to the same input, and a new hash to changed text", () => {
		const first = extractRecords(page(`<h1>A</h1><p>one</p>`), "/docs/a")
		const again = extractRecords(page(`<h1>A</h1><p>one</p>`), "/docs/a")
		const changed = extractRecords(page(`<h1>A</h1><p>two</p>`), "/docs/a")

		expect(again).toEqual(first)
		expect(changed[0]?.id).toBe(first[0]?.id)
		expect(changed[0]?.hash).not.toBe(first[0]?.hash)
	})

	test("uses the default category when the page marks no active sidebar entry", () => {
		const records = extractRecords(`<html><body><article><h1>A</h1></article></body></html>`, "/a")

		expect(records[0]?.hierarchy[0]).toBe("Documentation")
	})

	test("yields zero records for a noindex page and for a page without an article", () => {
		expect(extractRecords(page(`<h1>A</h1>`, `<meta name="robots" content="noindex, nofollow">`), "/a")).toEqual([])
		expect(extractRecords(`<html><body><h1>A</h1></body></html>`, "/a")).toEqual([])
	})
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Find the docs workspace's Vitest entry by reading how `docs/plugins/runtime-assets/artifacts.test.ts` runs; it is part of the root sweep in `vitest.config.ts`.

Run: `yarn vitest run docs/plugins/search-records/extract.test.ts`
Expected: FAIL. The module `@mailwoman/docs/plugins/search-records/extract` cannot be resolved.

- [ ] **Step 3: Implement the extractor**

Add `"@mailwoman/search-worker": "workspace:*"`, `"htmlparser2": "^12.0.0"`, `"domutils"` and `"domhandler"` to `docs/package.json` at the versions `packages/core/package.json` declares, then run `yarn install`. Add the `./plugins/search-records/extract` subpath to the docs `exports` map in the same shape as `./plugins/runtime-assets/artifacts`.

`docs/plugins/search-records/extract.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads one built docs page into search records. A heading starts a record, a table row is a level-5
 *   record named by its first cell, and paragraph and list text joins the record of the heading above it.
 */

import { createHash } from "node:crypto"

import { HIERARCHY_DEPTH, type SearchRecord } from "@mailwoman/search-worker/record"
import type { Element } from "domhandler"
import { findAll, findOne, getAttributeValue, textContent } from "domutils"
import { parseDocument } from "htmlparser2"

const DEFAULT_CATEGORY = "Documentation"
const HEADING = /^h([1-6])$/
const TABLE_ROW_LEVEL = 5

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex")
}

function cleanText(element: Element): string {
	return textContent(element).replace(/\s+/g, " ").trim()
}

function hasClass(element: Element, name: string): boolean {
	return (getAttributeValue(element, "class") ?? "").split(/\s+/).includes(name)
}

function category(document: ReturnType<typeof parseDocument>): string {
	const active = findAll(
		(element) =>
			(hasClass(element, "menu__link--sublist") && hasClass(element, "menu__link--active")) ||
			hasClass(element, "navbar__link--active"),
		document.children
	)

	return (active.at(-1) && cleanText(active.at(-1) as Element)) || DEFAULT_CATEGORY
}

function isNoIndex(document: ReturnType<typeof parseDocument>): boolean {
	return findAll(
		(element) => element.name === "meta" && getAttributeValue(element, "name") === "robots",
		document.children
	).some((meta) => (getAttributeValue(meta, "content") ?? "").includes("noindex"))
}

interface Draft {
	anchor: string
	hierarchy: (string | null)[]
	level: number
	parts: string[]
}

export function extractRecords(html: string, url: string): SearchRecord[] {
	const document = parseDocument(html)
	const article = findOne((element) => element.name === "article", document.children)

	if (!article || isNoIndex(document)) return []

	const hierarchy: (string | null)[] = Array.from({ length: HIERARCHY_DEPTH }, () => null)

	hierarchy[0] = category(document)

	const drafts: Draft[] = []
	let anchor = ""
	let section: Draft | undefined

	const elements = findAll(
		(element) => HEADING.test(element.name) || element.name === "tr" || element.name === "p" || element.name === "li",
		article.children
	)

	for (const element of elements) {
		const heading = HEADING.exec(element.name)

		if (heading) {
			const level = Number(heading[1])

			hierarchy[level] = cleanText(element)
			hierarchy.fill(null, level + 1)
			anchor = level === 1 ? "" : (getAttributeValue(element, "id") ?? anchor)
			section = { anchor, hierarchy: [...hierarchy], level, parts: [] }
			drafts.push(section)
		} else if (element.name === "tr") {
			const cells = findAll((cell) => cell.name === "td", element.children)
			const first = cells[0]
			const last = cells.at(-1)

			if (!first || !last || cleanText(first) === "") continue

			const rowHierarchy = [...hierarchy]

			rowHierarchy[TABLE_ROW_LEVEL] = cleanText(first)
			rowHierarchy.fill(null, TABLE_ROW_LEVEL + 1)
			drafts.push({
				anchor,
				hierarchy: rowHierarchy,
				level: TABLE_ROW_LEVEL,
				parts: cells.length > 1 ? [cleanText(last)] : [],
			})
		} else if (section) {
			// A list item that holds a paragraph would add the same text twice.
			if (element.name === "li" && findOne((child) => child.name === "p", element.children)) continue

			const text = cleanText(element)

			if (text !== "") section.parts.push(text)
		}
	}

	return drafts.map((draft, position) => {
		const content = draft.parts.join(" ")

		return {
			id: sha256(`${url}#${draft.anchor}\n${position}`).slice(0, 32),
			url,
			anchor: draft.anchor,
			hierarchy: draft.hierarchy,
			content,
			level: draft.level,
			position,
			hash: sha256(JSON.stringify([draft.hierarchy, content])),
		}
	})
}
```

The repository's `mailwoman/prefer-home` lint may direct the HTML parsing to `@mailwoman/core/html`. When it does, read `packages/core/lib/html/document.ts` and use its reader where it offers the same traversal; keep the test unchanged.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `yarn vitest run docs/plugins/search-records/extract.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Implement the plugin and register it**

`docs/plugins/search-records/plugin.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Writes `search-records.json` into the built site: one record per heading-scoped section and per
 *   reference-table row of every built page. The search worker ingests this file on a schedule.
 */

import type { LoadContext, Plugin } from "@docusaurus/types"
import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { SEARCH_SCHEMA_VERSION, type SearchManifest, type SearchRecord } from "@mailwoman/search-worker/record"
import { resolvePath } from "path-ts"

import { extractRecords } from "./extract.ts"

export const SEARCH_MANIFEST_FILENAME = "search-records.json"

export default function searchRecordsPlugin(context: LoadContext): Plugin {
	return {
		name: "search-records",

		async postBuild({ outDir, routesPaths }) {
			const records: SearchRecord[] = []
			const seen = new Map<string, string>()

			for (const route of routesPaths) {
				const url = route.replace(/\/$/, "") || "/"
				const file = resolvePath(outDir, `.${url === "/" ? "" : url}`, "index.html")
				const html = await readLocalTextFile(file)

				for (const record of extractRecords(html, url)) {
					const earlier = seen.get(record.id)

					if (earlier) throw new Error(`search-records: ${url} and ${earlier} produced the same record id ${record.id}`)

					seen.set(record.id, url)
					records.push(record)
				}
			}

			if (records.length === 0) throw new Error("search-records: the build produced zero records")

			const manifest: SearchManifest = {
				schemaVersion: SEARCH_SCHEMA_VERSION,
				commit: String(context.siteConfig.customFields?.buildCommit ?? ""),
				records,
			}

			await writeLocalJSONFile(manifest, resolvePath(outDir, SEARCH_MANIFEST_FILENAME))
			console.log(`search-records: wrote ${records.length} records from ${routesPaths.length} routes`)
		},
	}
}
```

Before relying on the file layout, check two facts in a built site: whether a route such as `/docs/pricing` is emitted as `docs/pricing/index.html` or `docs/pricing.html` (the `trailingSlash` setting decides), and whether every entry of `routesPaths` has an HTML file (the `/404.html` route and redirect routes may differ). Adjust the path computation to the observed layout, and skip a route only when it is a redirect stub or the 404 page; any other missing file must throw. `writeLocalJSONFile` takes `(value, path)`.

Add `"./plugins/search-records/plugin.ts",` to the `plugins` array in `docs/docusaurus.config.ts` after `"./plugins/runtime-assets/plugin.ts",`.

- [ ] **Step 6: Build the docs and measure the record count**

Load the `run-docs` skill for the build prerequisites, then run: `yarn workspace @mailwoman/docs build`
Expected: the log line `search-records: wrote N records from M routes`, and the file `docs/build/search-records.json`.

Record `N` and the file size in the commit message. This answers spec measurement 1. Decision rule: Workers AI accepts 100 texts per embedding call, so a first ingest makes `ceil(N / 100)` embedding calls plus `ceil(N / 1000)` Vectorize calls. When that total is under 900, the worker performs the first ingest itself. When it is 900 or more, stop and report to the operator, because Task 3 then needs a resumable ingest.

Also confirm that the six URL paths in the spec's acceptance list occur in the manifest: `grep -c '"url":"/docs/engineering/reference/decoder-grammar"' docs/build/search-records.json` and the same for the other five. Correct the spec's table to the observed paths.

- [ ] **Step 7: Commit**

```bash
git add docs/plugins/search-records docs/docusaurus.config.ts docs/package.json yarn.lock
git commit -m "Write a search record manifest from the docs build (N records)" -- docs/plugins/search-records docs/docusaurus.config.ts docs/package.json yarn.lock docs/superpowers/specs/2026-10-02-docs-search-worker-design.md
```

---

### Task 3: Ingest

**Files:**

- Create: `packages/search-worker/lib/embed.ts`, `lib/ingest.ts`, `lib/ingest.test.ts`, `test/support/fakes.ts`

**Interfaces:**

- Consumes: `parseManifest`, `SearchRecord`, `SearchManifest`, `headingsText` from `#record`; `storedHashes`, `upsertStatements`, `deleteStatements` from `#store`.
- Produces from `#embed`: `interface Embedder { embed(texts: readonly string[]): Promise<number[][]> }`, `interface VectorStore { upsert(entries: readonly VectorEntry[]): Promise<void>; remove(ids: readonly string[]): Promise<void>; query(values: readonly number[], topK: number): Promise<string[]> }`, `interface VectorEntry { id: string; values: number[] }`, `workersAIEmbedder(ai: Ai): Embedder`, `vectorizeStore(index: VectorizeIndex): VectorStore`, `embeddingText(record: SearchRecord): string`.
- Produces from `#ingest`: `planIngest(stored: ReadonlyMap<string, string>, manifest: SearchManifest): IngestPlan`, `class IngestRefusal extends Error`, `runIngest(deps: IngestDependencies, options?: { force?: boolean }): Promise<IngestReport>`, `interface IngestDependencies { db: D1Database; vectors: VectorStore; embedder: Embedder; fetchManifest: () => Promise<Response>; now?: () => Date }`, `interface IngestReport { startedAt: string; commit: string; added: number; changed: number; removed: number; outcome: string }`.
- Produces from `#test/support/fakes`: `fakeEmbedder(): Embedder & { calls: string[][] }`, `fakeVectors(): VectorStore & { entries: Map<string, number[]> }`.

- [ ] **Step 1: Write the fakes**

`packages/search-worker/test/support/fakes.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   In-memory stand-ins for Workers AI and Vectorize, which the test pool does not simulate. The fake
 *   embedding is a letter-frequency vector, so texts that share letters have a high cosine similarity.
 */

import type { Embedder, VectorStore } from "#embed"

const LETTERS = 26

function letterVector(text: string): number[] {
	const vector = Array.from({ length: LETTERS }, () => 0)

	for (const character of text.toLowerCase()) {
		const index = character.charCodeAt(0) - 97

		if (index >= 0 && index < LETTERS) vector[index] = (vector[index] ?? 0) + 1
	}

	return vector
}

function cosine(a: readonly number[], b: readonly number[]): number {
	let dot = 0
	let normA = 0
	let normB = 0

	for (let index = 0; index < a.length; index++) {
		dot += (a[index] ?? 0) * (b[index] ?? 0)
		normA += (a[index] ?? 0) ** 2
		normB += (b[index] ?? 0) ** 2
	}

	return normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB)
}

export function fakeEmbedder(): Embedder & { calls: string[][] } {
	const calls: string[][] = []

	return {
		calls,
		async embed(texts) {
			calls.push([...texts])

			return texts.map(letterVector)
		},
	}
}

export function fakeVectors(): VectorStore & { entries: Map<string, number[]> } {
	const entries = new Map<string, number[]>()

	return {
		entries,
		async upsert(batch) {
			for (const entry of batch) entries.set(entry.id, entry.values)
		},
		async remove(ids) {
			for (const id of ids) entries.delete(id)
		},
		async query(values, topK) {
			return [...entries]
				.map(([id, stored]) => ({ id, score: cosine(values, stored) }))
				.sort((a, b) => b.score - a.score)
				.slice(0, topK)
				.map((match) => match.id)
		},
	}
}
```

- [ ] **Step 2: Write the failing ingest test**

`packages/search-worker/lib/ingest.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { env } from "cloudflare:workers"
import { beforeAll, beforeEach, describe, expect, it } from "vitest"

import { type IngestDependencies, IngestRefusal, planIngest, runIngest } from "#ingest"
import type { SearchManifest } from "#record"
import { storedHashes } from "#store"
import { fakeEmbedder, fakeVectors } from "#test/support/fakes"
import { applyMigrations } from "#test/support/migrations"
import { manifest, record } from "#test/support/records"

beforeAll(async () => {
	await applyMigrations(env.SEARCH_DB)
})

beforeEach(async () => {
	await env.SEARCH_DB.batch([
		env.SEARCH_DB.prepare("DELETE FROM records"),
		env.SEARCH_DB.prepare("DELETE FROM ingest_runs"),
	])
})

let clock = Date.UTC(2026, 9, 2)

function deps(body: unknown, init: ResponseInit = {}) {
	const embedder = fakeEmbedder()
	const vectors = fakeVectors()
	const dependencies: IngestDependencies = {
		db: env.SEARCH_DB,
		embedder,
		vectors,
		fetchManifest: async () => (body instanceof Response ? body : Response.json(body, init)),
		// Each run needs its own `started_at`, the primary key of `ingest_runs`.
		now: () => new Date((clock += 1000)),
	}

	return { dependencies, embedder, vectors }
}

function tenRecords(): SearchManifest {
	return manifest(Array.from({ length: 10 }, (_, index) => record({ id: `r${index}`, hash: `h${index}` })))
}

describe("planIngest", () => {
	it("classifies records as added, changed, unchanged and removed", () => {
		const stored = new Map([
			["same", "h1"],
			["edited", "h1"],
			["gone", "h1"],
		])
		const plan = planIngest(
			stored,
			manifest([record({ id: "same", hash: "h1" }), record({ id: "edited", hash: "h2" }), record({ id: "new" })])
		)

		expect(plan.added.map((entry) => entry.id)).toEqual(["new"])
		expect(plan.changed.map((entry) => entry.id)).toEqual(["edited"])
		expect(plan.removed).toEqual(["gone"])
		expect(plan.unchanged).toBe(1)
	})
})

describe("runIngest", () => {
	it("loads every record into an empty index and embeds each one", async () => {
		const { dependencies, embedder, vectors } = deps(tenRecords())
		const report = await runIngest(dependencies)

		expect(report).toMatchObject({ added: 10, changed: 0, removed: 0, outcome: "applied" })
		expect((await storedHashes(env.SEARCH_DB)).size).toBe(10)
		expect(vectors.entries.size).toBe(10)
		expect(embedder.calls.flat()).toHaveLength(10)
	})

	it("embeds only the changed record on a second run and records the run", async () => {
		await runIngest(deps(tenRecords()).dependencies)

		const next = tenRecords()

		next.records[0] = { ...next.records[0]!, hash: "edited", content: "new text" }

		const { dependencies, embedder } = deps(next)
		const report = await runIngest(dependencies)

		expect(report).toMatchObject({ added: 0, changed: 1, removed: 0, outcome: "applied" })
		expect(embedder.calls.flat()).toHaveLength(1)
	})

	it("reports unchanged and embeds zero records when the manifest matches the index", async () => {
		await runIngest(deps(tenRecords()).dependencies)

		const { dependencies, embedder } = deps(tenRecords())

		expect((await runIngest(dependencies)).outcome).toBe("unchanged")
		expect(embedder.calls).toHaveLength(0)
	})

	it("applies a manifest that removes exactly 30% of the stored records", async () => {
		await runIngest(deps(tenRecords()).dependencies)

		const { dependencies, vectors } = deps(manifest(tenRecords().records.slice(0, 7)))
		const report = await runIngest(dependencies)

		expect(report).toMatchObject({ removed: 3, outcome: "applied" })
		expect((await storedHashes(env.SEARCH_DB)).size).toBe(7)
		expect(vectors.entries.has("r9")).toBe(false)
	})

	it("refuses a manifest that removes more than 30% and leaves the index as it was", async () => {
		await runIngest(deps(tenRecords()).dependencies)

		await expect(runIngest(deps(manifest(tenRecords().records.slice(0, 6))).dependencies)).rejects.toBeInstanceOf(
			IngestRefusal
		)
		expect((await storedHashes(env.SEARCH_DB)).size).toBe(10)

		const last = await env.SEARCH_DB.prepare("SELECT outcome FROM ingest_runs ORDER BY started_at DESC LIMIT 1").first<{
			outcome: string
		}>()

		expect(last?.outcome).toMatch(/^refused: /)
	})

	it("applies a removal above 30% when forced", async () => {
		await runIngest(deps(tenRecords()).dependencies)

		const report = await runIngest(deps(manifest(tenRecords().records.slice(0, 2))).dependencies, { force: true })

		expect(report).toMatchObject({ removed: 8, outcome: "applied" })
	})

	it.each([
		["a 404 response", new Response("not found", { status: 404 })],
		["a 200 response with an HTML body", new Response("<!doctype html><html></html>", { status: 200 })],
		["an unknown schema version", Response.json({ schemaVersion: 2, commit: "", records: [] })],
	])("refuses %s and leaves the index as it was", async (_name, response) => {
		await runIngest(deps(tenRecords()).dependencies)

		await expect(runIngest(deps(response).dependencies)).rejects.toBeInstanceOf(IngestRefusal)
		expect((await storedHashes(env.SEARCH_DB)).size).toBe(10)
	})

	it("writes zero rows when the embedding call throws", async () => {
		const { dependencies } = deps(tenRecords())

		dependencies.embedder = {
			async embed() {
				throw new Error("model unavailable")
			},
		}

		await expect(runIngest(dependencies)).rejects.toThrow("model unavailable")
		expect((await storedHashes(env.SEARCH_DB)).size).toBe(0)
	})
})
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `yarn workspace @mailwoman/search-worker test lib/ingest.test.ts`
Expected: FAIL. `#ingest` and `#embed` cannot be resolved.

- [ ] **Step 4: Implement `embed.ts` and `ingest.ts`**

`packages/search-worker/lib/embed.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The embedding model and the vector index, behind two interfaces. The worker builds them from the
 *   Workers AI and Vectorize bindings; a test passes in-memory implementations.
 */

import { headingsText, type SearchRecord } from "#record"

export const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5"

/**
 * Workers AI accepts this many texts in one embedding call.
 */
const EMBED_BATCH = 100

/**
 * The Vectorize binding accepts this many vectors in one upsert and this many ids in one delete.
 */
const VECTOR_BATCH = 1000

export interface VectorEntry {
	id: string
	values: number[]
}

export interface Embedder {
	/**
	 * One vector per text, in the order given.
	 */
	embed(texts: readonly string[]): Promise<number[][]>
}

export interface VectorStore {
	upsert(entries: readonly VectorEntry[]): Promise<void>
	remove(ids: readonly string[]): Promise<void>
	/**
	 * The ids of the `topK` nearest entries, nearest first.
	 */
	query(values: readonly number[], topK: number): Promise<string[]>
}

/**
 * The text embedded for a record: its heading path, then its content.
 */
export function embeddingText(record: SearchRecord): string {
	return `${headingsText(record)}\n${record.content}`.trim()
}

function chunks<T>(items: readonly T[], size: number): T[][] {
	const out: T[][] = []

	for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size))

	return out
}

export function workersAIEmbedder(ai: Ai): Embedder {
	return {
		async embed(texts) {
			const vectors: number[][] = []

			for (const batch of chunks(texts, EMBED_BATCH)) {
				const result = (await ai.run(EMBEDDING_MODEL, { text: batch })) as { data?: number[][] }

				if (!result.data || result.data.length !== batch.length) {
					throw new Error(`embedding call returned ${result.data?.length ?? "no"} vectors for ${batch.length} texts`)
				}

				vectors.push(...result.data)
			}

			return vectors
		},
	}
}

export function vectorizeStore(index: VectorizeIndex): VectorStore {
	return {
		async upsert(entries) {
			for (const batch of chunks(entries, VECTOR_BATCH)) await index.upsert(batch)
		},
		async remove(ids) {
			for (const batch of chunks(ids, VECTOR_BATCH)) await index.deleteByIds(batch)
		},
		async query(values, topK) {
			const result = await index.query([...values], { topK })

			return result.matches.map((match) => match.id)
		},
	}
}
```

Check the `Ai` and `VectorizeIndex` type names against the installed `@cloudflare/workers-types`; the Vectorize binding type may be named `Vectorize`.

`packages/search-worker/lib/ingest.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   One ingest run: fetch the manifest, compare record hashes with the stored index, embed what changed,
 *   and write both stores. A run that cannot read the manifest, or that would remove more than the allowed
 *   share of the index, throws {@linkcode IngestRefusal} before any write.
 *
 *   Vectorize and D1 share no transaction. The vectors are written first and the D1 hash last, so an
 *   interrupted run leaves stale hashes and the following run embeds those records again.
 */

import { type Embedder, embeddingText, type VectorStore } from "#embed"
import { parseManifest, type SearchManifest, type SearchRecord } from "#record"
import { deleteStatements, storedHashes, upsertStatements } from "#store"

/**
 * A run is refused when it would remove more than this share of the stored records.
 */
export const MAX_REMOVED_SHARE = 0.3

/**
 * Statements per `D1Database.batch` call.
 */
const WRITE_BATCH = 500

export interface IngestPlan {
	added: SearchRecord[]
	changed: SearchRecord[]
	removed: string[]
	unchanged: number
}

export interface IngestDependencies {
	db: D1Database
	vectors: VectorStore
	embedder: Embedder
	fetchManifest: () => Promise<Response>
	now?: () => Date
}

export interface IngestReport {
	startedAt: string
	commit: string
	added: number
	changed: number
	removed: number
	outcome: string
}

export class IngestRefusal extends Error {
	override name = "IngestRefusal"
}

export function planIngest(stored: ReadonlyMap<string, string>, manifest: SearchManifest): IngestPlan {
	const plan: IngestPlan = { added: [], changed: [], removed: [], unchanged: 0 }
	const present = new Set<string>()

	for (const record of manifest.records) {
		present.add(record.id)

		const hash = stored.get(record.id)

		if (hash === undefined) plan.added.push(record)
		else if (hash !== record.hash) plan.changed.push(record)
		else plan.unchanged++
	}

	for (const id of stored.keys()) if (!present.has(id)) plan.removed.push(id)

	return plan
}

async function fetchedManifest(fetchManifest: () => Promise<Response>): Promise<SearchManifest> {
	let response: Response

	try {
		response = await fetchManifest()
	} catch (error) {
		throw new IngestRefusal(`manifest fetch failed: ${error instanceof Error ? error.message : String(error)}`)
	}

	if (!response.ok) throw new IngestRefusal(`manifest answered status ${response.status}`)

	try {
		return parseManifest(await response.json())
	} catch (error) {
		throw new IngestRefusal(`manifest is unreadable: ${error instanceof Error ? error.message : String(error)}`)
	}
}

async function recordRun(db: D1Database, report: IngestReport): Promise<void> {
	await db
		.prepare(
			"INSERT INTO ingest_runs (started_at, commit_sha, added, changed, removed, outcome) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
		)
		.bind(report.startedAt, report.commit, report.added, report.changed, report.removed, report.outcome)
		.run()
}

async function batched(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
	for (let start = 0; start < statements.length; start += WRITE_BATCH) {
		await db.batch(statements.slice(start, start + WRITE_BATCH))
	}
}

export async function runIngest(deps: IngestDependencies, options: { force?: boolean } = {}): Promise<IngestReport> {
	const startedAt = (deps.now?.() ?? new Date()).toISOString()
	const report: IngestReport = { startedAt, commit: "", added: 0, changed: 0, removed: 0, outcome: "" }

	try {
		const manifest = await fetchedManifest(deps.fetchManifest)
		const stored = await storedHashes(deps.db)
		const plan = planIngest(stored, manifest)

		report.commit = manifest.commit
		report.added = plan.added.length
		report.changed = plan.changed.length
		report.removed = plan.removed.length

		if (!options.force && stored.size > 0 && plan.removed.length > stored.size * MAX_REMOVED_SHARE) {
			throw new IngestRefusal(`the manifest removes ${plan.removed.length} of ${stored.size} stored records`)
		}

		const writes = [...plan.added, ...plan.changed]

		if (writes.length === 0 && plan.removed.length === 0) {
			report.outcome = "unchanged"
		} else {
			const vectors = await deps.embedder.embed(writes.map(embeddingText))

			await deps.vectors.upsert(writes.map((record, index) => ({ id: record.id, values: vectors[index] as number[] })))
			await batched(deps.db, [...upsertStatements(deps.db, writes), ...deleteStatements(deps.db, plan.removed)])
			await deps.vectors.remove(plan.removed)
			report.outcome = "applied"
		}
	} catch (error) {
		if (error instanceof IngestRefusal) {
			report.outcome = `refused: ${error.message}`
			await recordRun(deps.db, report)
		}

		throw error
	}

	await recordRun(deps.db, report)

	return report
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `yarn workspace @mailwoman/search-worker test lib/ingest.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/search-worker/lib/embed.ts packages/search-worker/lib/ingest.ts packages/search-worker/lib/ingest.test.ts packages/search-worker/test/support/fakes.ts
git commit -m "Ingest the record manifest by hash, with the 30% removal refusal" -- packages/search-worker
```

---

### Task 4: Lexical arm

**Files:**

- Create: `packages/search-worker/lib/lexical.ts`, `lib/lexical.test.ts`

**Interfaces:**

- Consumes: `rowToRecord` from `#store`; `SearchRecord` from `#record`.
- Produces: `queryTokens(q: string): string[]`, `primaryMatch(tokens: readonly string[]): string | undefined`, `trigramMatch(tokens: readonly string[]): string | undefined`, `lexicalSearch(db: D1Database, q: string): Promise<LexicalResult>`, `interface LexicalResult { arm: "primary" | "trigram" | "empty"; records: SearchRecord[] }`, `LEXICAL_ROWS = 40`.

The primary expression quotes each token as an FTS5 string and marks the last token as a prefix. The trigram expression is the `OR` of every distinct three-character window of every token, so a record that shares most windows with a misspelled word ranks first by `bm25`.

- [ ] **Step 1: Write the failing test**

`packages/search-worker/lib/lexical.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { env } from "cloudflare:workers"
import { beforeAll, describe, expect, it } from "vitest"

import { lexicalSearch, primaryMatch, queryTokens, trigramMatch } from "#lexical"
import { upsertStatements } from "#store"
import { applyMigrations } from "#test/support/migrations"
import { record } from "#test/support/records"

beforeAll(async () => {
	await applyMigrations(env.SEARCH_DB)
	await env.SEARCH_DB.batch(
		upsertStatements(env.SEARCH_DB, [
			record({ id: "heading", url: "/a", hierarchy: ["Reference", "Decoder grammar", null, null, null, null, null] }),
			record({ id: "body", url: "/b", content: "The decoder grammar is described elsewhere." }),
			record({
				id: "coverage",
				url: "/c",
				hierarchy: ["Reference", "Jurisdiction coverage", null, null, null, null, null],
			}),
			record({ id: "plural", url: "/d", content: "Two parsers disagree." }),
		])
	)
})

describe("queryTokens", () => {
	it("keeps tokens that contain a letter or a digit", () => {
		expect(queryTokens('  tier-1  "regression" -- *** ')).toEqual(["tier-1", '"regression"'])
	})
})

describe("primaryMatch", () => {
	it("quotes every token and marks the last one as a prefix", () => {
		expect(primaryMatch(["decoder", "gram"])).toBe('"decoder" "gram"*')
	})

	it("doubles a quote character inside a token", () => {
		expect(primaryMatch(['say"hi'])).toBe('"say""hi"*')
	})

	it("returns undefined for zero tokens", () => {
		expect(primaryMatch([])).toBeUndefined()
	})
})

describe("trigramMatch", () => {
	it("joins the distinct three-character windows of each token with OR", () => {
		expect(trigramMatch(["abcd", "bcd"])).toBe('"abc" OR "bcd"')
	})

	it("returns undefined when every token is shorter than three characters", () => {
		expect(trigramMatch(["ab", "c"])).toBeUndefined()
	})
})

describe("lexicalSearch", () => {
	it("ranks a heading match above a content match", async () => {
		const result = await lexicalSearch(env.SEARCH_DB, "decoder grammar")

		expect(result.arm).toBe("primary")
		expect(result.records.map((entry) => entry.id)).toEqual(["heading", "body"])
	})

	it("matches the last token as a prefix", async () => {
		expect((await lexicalSearch(env.SEARCH_DB, "decoder gram")).records.map((entry) => entry.id)).toContain("heading")
	})

	it("matches a singular query against a plural word", async () => {
		expect((await lexicalSearch(env.SEARCH_DB, "parser")).records.map((entry) => entry.id)).toEqual(["plural"])
	})

	it("answers a misspelled query from the trigram table", async () => {
		const result = await lexicalSearch(env.SEARCH_DB, "jurisdction coverage")

		expect(result.arm).toBe("trigram")
		expect(result.records[0]?.id).toBe("coverage")
	})

	it("reports an empty arm for a query without a letter or digit", async () => {
		expect(await lexicalSearch(env.SEARCH_DB, "-- ***")).toEqual({ arm: "empty", records: [] })
	})

	it.each(['"', "a AND", "NEAR(a b)", "col:value", "a* OR", "(", "a - b", "^a"])(
		"returns a result without throwing for the FTS5 syntax %s",
		async (q) => {
			await expect(lexicalSearch(env.SEARCH_DB, q)).resolves.toHaveProperty("arm")
		}
	)
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `yarn workspace @mailwoman/search-worker test lib/lexical.test.ts`
Expected: FAIL. `#lexical` cannot be resolved.

- [ ] **Step 3: Implement `lexical.ts`**

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The lexical arm. Every token of the user's text becomes a quoted FTS5 string, so the text can never
 *   reach the FTS5 parser as an operator, a column filter or a bare `*`.
 */

import type { SearchRecord } from "#record"
import { rowToRecord } from "#store"

export const LEXICAL_ROWS = 40

/**
 * `bm25` column weights: a match in the heading path counts ten times a match in the content.
 */
const HEADINGS_WEIGHT = 10
const CONTENT_WEIGHT = 1

const TRIGRAM = 3

/**
 * An OR of more windows than this adds latency without changing which record ranks first.
 */
const MAX_TRIGRAMS = 64

export interface LexicalResult {
	arm: "primary" | "trigram" | "empty"
	records: SearchRecord[]
}

function quote(text: string): string {
	return `"${text.replaceAll('"', '""')}"`
}

/**
 * The whitespace-separated parts of `q` that the tokenizer can index: those with a letter or a digit.
 */
export function queryTokens(q: string): string[] {
	return q.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token))
}

export function primaryMatch(tokens: readonly string[]): string | undefined {
	if (tokens.length === 0) return undefined

	return tokens.map((token, index) => (index === tokens.length - 1 ? `${quote(token)}*` : quote(token))).join(" ")
}

export function trigramMatch(tokens: readonly string[]): string | undefined {
	const windows = new Set<string>()

	for (const token of tokens) {
		const characters = [...token.toLowerCase()]

		for (let start = 0; start + TRIGRAM <= characters.length; start++) {
			windows.add(characters.slice(start, start + TRIGRAM).join(""))
		}
	}

	if (windows.size === 0) return undefined

	return [...windows].slice(0, MAX_TRIGRAMS).map(quote).join(" OR ")
}

async function match(
	db: D1Database,
	table: "records_fts" | "records_trigram",
	expression: string
): Promise<SearchRecord[]> {
	const { results } = await db
		.prepare(
			`SELECT r.id, r.url, r.anchor, r.hierarchy, r.content, r.level, r.position, r.hash
			 FROM ${table} JOIN records r ON r.rowid = ${table}.rowid
			 WHERE ${table} MATCH ?1
			 ORDER BY bm25(${table}, ${HEADINGS_WEIGHT}, ${CONTENT_WEIGHT}), r.level, r.position
			 LIMIT ${LEXICAL_ROWS}`
		)
		.bind(expression)
		.all<Parameters<typeof rowToRecord>[0]>()

	return results.map(rowToRecord)
}

export async function lexicalSearch(db: D1Database, q: string): Promise<LexicalResult> {
	const tokens = queryTokens(q)
	const primary = primaryMatch(tokens)

	if (!primary) return { arm: "empty", records: [] }

	const records = await match(db, "records_fts", primary)

	if (records.length > 0) return { arm: "primary", records }

	const trigram = trigramMatch(tokens)

	if (!trigram) return { arm: "empty", records: [] }

	const fuzzy = await match(db, "records_trigram", trigram)

	return fuzzy.length > 0 ? { arm: "trigram", records: fuzzy } : { arm: "empty", records: [] }
}
```

Export the `RecordRow` interface from `#store` and use it in place of `Parameters<typeof rowToRecord>[0]`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `yarn workspace @mailwoman/search-worker test lib/lexical.test.ts`
Expected: PASS, 19 tests. When a syntax case fails with an FTS5 error, the token that reached the parser unquoted is in the error message; fix `queryTokens` or `quote`, and leave the test list as it is.

- [ ] **Step 5: Commit**

```bash
git add packages/search-worker/lib/lexical.ts packages/search-worker/lib/lexical.test.ts
git commit -m "Query the FTS5 tables with quoted tokens and a trigram fallback" -- packages/search-worker
```

---

### Task 5: Fusion and URL collapse

**Files:**

- Create: `packages/search-worker/lib/fusion.ts`, `lib/fusion.test.ts`

**Interfaces:**

- Produces: `fuse(lists: readonly (readonly string[])[]): string[]`, `collapseByURL<T extends { url: string }>(ranked: readonly T[], limit: number): T[]`, `FUSION_CONSTANT = 60`.

- [ ] **Step 1: Write the failing test**

`packages/search-worker/lib/fusion.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { collapseByURL, fuse } from "#fusion"

describe("fuse", () => {
	it("ranks an id that both lists return above an id that one list returns first", () => {
		expect(
			fuse([
				["a", "b"],
				["b", "c"],
			])
		).toEqual(["b", "a", "c"])
	})

	it("keeps the order of a single list", () => {
		expect(fuse([["x", "y", "z"], []])).toEqual(["x", "y", "z"])
	})

	it("breaks a tie in favor of the earlier list", () => {
		expect(fuse([["a"], ["b"]])).toEqual(["a", "b"])
	})

	it("returns an empty list for empty input", () => {
		expect(fuse([[], []])).toEqual([])
	})
})

describe("collapseByURL", () => {
	it("keeps the first record of each url and stops at the limit", () => {
		const ranked = [
			{ id: 1, url: "/a" },
			{ id: 2, url: "/a" },
			{ id: 3, url: "/b" },
			{ id: 4, url: "/c" },
		]

		expect(collapseByURL(ranked, 2).map((entry) => entry.id)).toEqual([1, 3])
	})
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `yarn workspace @mailwoman/search-worker test lib/fusion.test.ts`
Expected: FAIL. `#fusion` cannot be resolved.

- [ ] **Step 3: Implement `fusion.ts`**

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reciprocal rank fusion. The two arms score on unrelated scales, a `bm25` value and a cosine distance,
 *   so the merge reads only each id's rank within its list.
 */

export const FUSION_CONSTANT = 60

/**
 * Merge ranked id lists. An id's score is the sum of `1 / (FUSION_CONSTANT + rank)` over the lists that
 * hold it, with rank starting at 1. Equal scores keep the order of first appearance, earlier list first.
 */
export function fuse(lists: readonly (readonly string[])[]): string[] {
	const scores = new Map<string, number>()

	for (const list of lists) {
		list.forEach((id, index) => {
			scores.set(id, (scores.get(id) ?? 0) + 1 / (FUSION_CONSTANT + index + 1))
		})
	}

	// `Array.prototype.sort` is stable, and the map iterates in insertion order.
	return [...scores].sort((a, b) => b[1] - a[1]).map(([id]) => id)
}

/**
 * The first entry of each `url`, in ranked order, up to `limit` entries.
 */
export function collapseByURL<T extends { url: string }>(ranked: readonly T[], limit: number): T[] {
	const seen = new Set<string>()
	const kept: T[] = []

	for (const entry of ranked) {
		if (seen.has(entry.url)) continue

		seen.add(entry.url)
		kept.push(entry)

		if (kept.length === limit) break
	}

	return kept
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `yarn workspace @mailwoman/search-worker test lib/fusion.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/search-worker/lib/fusion.ts packages/search-worker/lib/fusion.test.ts
git commit -m "Merge the two search arms by reciprocal rank and collapse to one hit per URL" -- packages/search-worker
```

---

### Task 6: Snippets

**Files:**

- Create: `packages/search-worker/lib/snippet.ts`, `lib/snippet.test.ts`

**Interfaces:**

- Produces: `snippet(content: string, tokens: readonly string[]): { snippet: string; highlights: [start: number, end: number][] }`, `SNIPPET_LENGTH = 160`.

- [ ] **Step 1: Write the failing test**

`packages/search-worker/lib/snippet.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { snippet, SNIPPET_LENGTH } from "#snippet"

describe("snippet", () => {
	it("returns short content whole with the range of each token match", () => {
		expect(snippet("The decoder reads a Decoder grammar.", ["decoder"])).toEqual({
			snippet: "The decoder reads a Decoder grammar.",
			highlights: [
				[4, 11],
				[20, 27],
			],
		})
	})

	it("windows long content around the first match and stays within the length", () => {
		const content = `${"lorem ".repeat(100)}needle ${"ipsum ".repeat(100)}`
		const result = snippet(content, ["needle"])

		expect(result.snippet.length).toBeLessThanOrEqual(SNIPPET_LENGTH)
		expect(result.highlights).toHaveLength(1)

		const [start, end] = result.highlights[0]!

		expect(result.snippet.slice(start, end)).toBe("needle")
	})

	it("returns the start of the content when no token occurs in it", () => {
		const result = snippet("a".repeat(500), ["zzz"])

		expect(result.snippet).toBe("a".repeat(SNIPPET_LENGTH))
		expect(result.highlights).toEqual([])
	})

	it("returns an empty snippet for empty content", () => {
		expect(snippet("", ["x"])).toEqual({ snippet: "", highlights: [] })
	})

	it("ignores tokens that are empty after trimming quotes", () => {
		expect(snippet("plain text", ['""']).highlights).toEqual([])
	})
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `yarn workspace @mailwoman/search-worker test lib/snippet.test.ts`
Expected: FAIL. `#snippet` cannot be resolved.

- [ ] **Step 3: Implement `snippet.ts`**

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The excerpt of a record's content that a hit displays, with the character ranges that matched a query
 *   token. Matching here is a case-insensitive substring search; it marks what to emphasize and takes no
 *   part in ranking.
 */

export const SNIPPET_LENGTH = 160

/**
 * Characters of context kept before the first match.
 */
const LEAD = 40

function needles(tokens: readonly string[]): string[] {
	return tokens
		.map((token) => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase())
		.filter((token) => token !== "")
}

export function snippet(
	content: string,
	tokens: readonly string[]
): { snippet: string; highlights: [start: number, end: number][] } {
	const lower = content.toLowerCase()
	const terms = needles(tokens)
	const first = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0)
	const anchor = first.length > 0 ? Math.min(...first) : 0
	const start =
		content.length <= SNIPPET_LENGTH ? 0 : Math.max(0, Math.min(anchor - LEAD, content.length - SNIPPET_LENGTH))
	const text = content.slice(start, start + SNIPPET_LENGTH)
	const window = text.toLowerCase()
	const highlights: [number, number][] = []

	for (const term of terms) {
		for (let index = window.indexOf(term); index >= 0; index = window.indexOf(term, index + term.length)) {
			highlights.push([index, index + term.length])
		}
	}

	highlights.sort((a, b) => a[0] - b[0])

	return { snippet: text, highlights }
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `yarn workspace @mailwoman/search-worker test lib/snippet.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/search-worker/lib/snippet.ts packages/search-worker/lib/snippet.test.ts
git commit -m "Cut a hit's snippet around the first query match" -- packages/search-worker
```

---

### Task 7: Search assembly, routes and worker entry

**Files:**

- Create: `packages/search-worker/lib/search.ts`, `lib/env.ts`, `lib/app.ts`, `lib/index.ts`, `lib/routes/search.ts`, `lib/routes/ingest.ts`, `lib/routes/health.ts`, `lib/app.test.ts`, `wrangler.toml`

**Interfaces:**

- Consumes: `lexicalSearch`, `queryTokens`, `LEXICAL_ROWS` from `#lexical`; `fuse`, `collapseByURL` from `#fusion`; `snippet` from `#snippet`; `recordsByID` from `#store`; `Embedder`, `VectorStore`, `workersAIEmbedder`, `vectorizeStore` from `#embed`; `runIngest`, `IngestRefusal`, `IngestDependencies` from `#ingest`.
- Produces from `#search`: `interface SearchHit { url: string; anchor: string; hierarchy: (string | null)[]; snippet: string; highlights: [number, number][] }`, `interface SearchResponse { query: string; arms: { lexical: "primary" | "trigram" | "empty"; vector: "ok" | "failed" }; hits: SearchHit[] }`, `search(deps: SearchDependencies, q: string, limit: number): Promise<SearchResponse>`, `interface SearchDependencies { db: D1Database; vectors: VectorStore; embedder: Embedder }`.
- Produces from `#app`: `createSearchWorkerApp(env: SearchWorkerEnv, deps: AppDependencies): Hono`, `interface AppDependencies extends SearchDependencies { fetchManifest: () => Promise<Response>; now?: () => Date }`.
- Produces HTTP: `GET /search?q=&limit=`, `POST /ingest[?force=1]`, `GET /health`.

- [ ] **Step 1: Write the failing app test**

`packages/search-worker/lib/app.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { env } from "cloudflare:workers"
import { beforeAll, describe, expect, it } from "vitest"

import { type AppDependencies, createSearchWorkerApp } from "#app"
import { readEnv } from "#env"
import { runIngest } from "#ingest"
import type { SearchResponse } from "#search"
import { fakeEmbedder, fakeVectors } from "#test/support/fakes"
import { applyMigrations } from "#test/support/migrations"
import { manifest, record } from "#test/support/records"

const RECORDS = manifest([
	record({
		id: "top",
		url: "/docs/decoder",
		hierarchy: ["Reference", "Decoder grammar", null, null, null, null, null],
	}),
	record({
		id: "section",
		url: "/docs/decoder",
		anchor: "objective",
		level: 2,
		position: 1,
		hierarchy: ["Reference", "Decoder grammar", "Objective", null, null, null, null],
		content: "The decoder objective is a sum of span scores.",
	}),
	record({
		id: "other",
		url: "/docs/pricing",
		hierarchy: ["Guides", "Pricing", null, null, null, null, null],
		content: "Plans.",
	}),
])

let deps: AppDependencies

beforeAll(async () => {
	await applyMigrations(env.SEARCH_DB)
	deps = {
		db: env.SEARCH_DB,
		embedder: fakeEmbedder(),
		vectors: fakeVectors(),
		fetchManifest: async () => Response.json(RECORDS),
	}
	await runIngest(deps)
})

function app(overrides: Partial<AppDependencies> = {}) {
	return createSearchWorkerApp(readEnv(env), { ...deps, ...overrides })
}

async function get(path: string, overrides: Partial<AppDependencies> = {}) {
	return app(overrides).request(path, { headers: { origin: "https://mailwoman.ai" } })
}

describe("GET /search", () => {
	it("returns one hit per url, with a snippet and both arms reported", async () => {
		const response = await get("/search?q=decoder")
		const body = (await response.json()) as SearchResponse

		expect(response.status).toBe(200)
		expect(body.arms).toEqual({ lexical: "primary", vector: "ok" })
		expect(body.hits.filter((hit) => hit.url === "/docs/decoder")).toHaveLength(1)
		expect(response.headers.get("cache-control")).toBe("public, max-age=300")
		expect(response.headers.get("access-control-allow-origin")).toBe("https://mailwoman.ai")
	})

	it("returns lexical hits and reports the vector arm as failed when the embedding call throws", async () => {
		const response = await get("/search?q=decoder", {
			embedder: {
				async embed() {
					throw new Error("model unavailable")
				},
			},
		})
		const body = (await response.json()) as SearchResponse

		expect(response.status).toBe(200)
		expect(body.arms.vector).toBe("failed")
		expect(body.hits.length).toBeGreaterThan(0)
	})

	it("drops a vector match that has no stored record", async () => {
		const vectors = fakeVectors()

		await vectors.upsert([{ id: "orphan", values: Array.from({ length: 26 }, () => 1) }])

		const body = (await (await get("/search?q=zzzz", { vectors })).json()) as SearchResponse

		expect(body.hits).toEqual([])
	})

	it("returns zero hits and an empty lexical arm for a query of punctuation", async () => {
		const body = (await (
			await get(`/search?q=${encodeURIComponent("-- ***")}`, { vectors: fakeVectors() })
		).json()) as SearchResponse

		expect(body.arms.lexical).toBe("empty")
		expect(body.hits).toEqual([])
	})

	it("honors the limit", async () => {
		const body = (await (await get("/search?q=decoder&limit=1")).json()) as SearchResponse

		expect(body.hits).toHaveLength(1)
	})

	it.each([
		"/search",
		"/search?q=",
		"/search?q=%20%20",
		`/search?q=${"a".repeat(201)}`,
		"/search?q=a&limit=0",
		"/search?q=a&limit=21",
	])("answers 400 for %s", async (path) => {
		expect((await get(path)).status).toBe(400)
	})
})

describe("POST /ingest", () => {
	it("answers 401 without the token", async () => {
		expect((await app().request("/ingest", { method: "POST" })).status).toBe(401)
	})

	it("runs an ingest with the token and returns the report", async () => {
		const response = await app().request("/ingest", {
			method: "POST",
			headers: { authorization: "Bearer test-ingest-token" },
		})

		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({ outcome: "unchanged" })
	})

	it("answers 409 with the reason when the run is refused", async () => {
		const response = await app({ fetchManifest: async () => new Response("gone", { status: 404 }) }).request(
			"/ingest",
			{
				method: "POST",
				headers: { authorization: "Bearer test-ingest-token" },
			}
		)

		expect(response.status).toBe(409)
		expect(await response.json()).toMatchObject({ error: "manifest answered status 404" })
	})
})

describe("GET /health", () => {
	it("reports the record count and the latest ingest run", async () => {
		const body = (await (await get("/health")).json()) as { records: number; lastRun: { outcome: string } }

		expect(body.records).toBe(3)
		expect(typeof body.lastRun.outcome).toBe("string")
	})
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `yarn workspace @mailwoman/search-worker test lib/app.test.ts`
Expected: FAIL. `#app`, `#env` and `#search` cannot be resolved.

- [ ] **Step 3: Implement `search.ts`**

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   One query: the lexical arm and the vector arm run concurrently, their ranked ids are fused, and the
 *   best record of each page becomes a hit. The lexical arm must answer. The vector arm may fail, and the
 *   response then says so.
 */

import type { Embedder, VectorStore } from "#embed"
import { collapseByURL, fuse } from "#fusion"
import { LEXICAL_ROWS, type LexicalResult, lexicalSearch, queryTokens } from "#lexical"
import type { SearchRecord } from "#record"
import { snippet } from "#snippet"
import { recordsByID } from "#store"

export const VECTOR_ROWS = LEXICAL_ROWS

export interface SearchDependencies {
	db: D1Database
	vectors: VectorStore
	embedder: Embedder
}

export interface SearchHit {
	url: string
	anchor: string
	hierarchy: (string | null)[]
	snippet: string
	highlights: [start: number, end: number][]
}

export interface SearchResponse {
	query: string
	arms: { lexical: LexicalResult["arm"]; vector: "ok" | "failed" }
	hits: SearchHit[]
}

async function vectorIDs(deps: SearchDependencies, q: string): Promise<string[]> {
	const [values] = await deps.embedder.embed([q])

	if (!values) throw new Error("the embedding call returned no vector")

	return deps.vectors.query(values, VECTOR_ROWS)
}

export async function search(deps: SearchDependencies, q: string, limit: number): Promise<SearchResponse> {
	const tokens = queryTokens(q)
	// A query without an indexable token has no meaning to embed either.
	const vectorArm = tokens.length === 0 ? Promise.resolve<string[]>([]) : vectorIDs(deps, q)
	const [lexical, vector] = await Promise.allSettled([lexicalSearch(deps.db, q), vectorArm])

	if (lexical.status === "rejected") throw lexical.reason

	if (vector.status === "rejected") console.error(`vector arm failed: ${String(vector.reason)}`)

	const vectorList = vector.status === "fulfilled" ? vector.value : []
	const records = new Map<string, SearchRecord>(lexical.value.records.map((record) => [record.id, record]))
	const missing = vectorList.filter((id) => !records.has(id))

	for (const [id, record] of await recordsByID(deps.db, missing)) records.set(id, record)

	const ranked = fuse([lexical.value.records.map((record) => record.id), vectorList])
		.map((id) => records.get(id))
		.filter((record): record is SearchRecord => record !== undefined)

	return {
		query: q,
		arms: { lexical: lexical.value.arm, vector: vector.status === "fulfilled" ? "ok" : "failed" },
		hits: collapseByURL(ranked, limit).map((record) => ({
			url: record.url,
			anchor: record.anchor,
			hierarchy: record.hierarchy,
			...snippet(record.content, tokens),
		})),
	}
}
```

- [ ] **Step 4: Implement `env.ts`, the routes, `app.ts` and `index.ts`**

`packages/search-worker/lib/env.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The worker's bindings. `SEARCH_VECTORS` and `AI` are absent in the test pool, which injects fakes, so
 *   only the entry point reads them.
 */

import { z } from "zod"

export interface SearchWorkerBindings {
	SEARCH_DB: D1Database
	SEARCH_VECTORS?: VectorizeIndex
	AI?: Ai
	SEARCH_LIMITER: RateLimit
	INGEST_TOKEN: string
	SITE_ORIGIN: string
	MANIFEST_URL: string
}

const VarsSchema = z.object({
	INGEST_TOKEN: z.string().min(16),
	SITE_ORIGIN: z.url(),
	MANIFEST_URL: z.url(),
})

export type SearchWorkerEnv = SearchWorkerBindings

/**
 * @throws when a var or the ingest secret is missing or malformed.
 */
export function readEnv(bindings: SearchWorkerBindings): SearchWorkerEnv {
	VarsSchema.parse(bindings)

	return bindings
}
```

`packages/search-worker/lib/routes/search.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { Hono } from "hono"

import type { SearchWorkerEnv } from "#env"
import { search, type SearchDependencies } from "#search"

export const MAX_QUERY_LENGTH = 200
export const DEFAULT_LIMIT = 8
export const MAX_LIMIT = 20

export function registerSearchRoute(app: Hono, env: SearchWorkerEnv, deps: SearchDependencies): void {
	app.get("/search", async (c) => {
		const { success } = await env.SEARCH_LIMITER.limit({ key: c.req.header("cf-connecting-ip") ?? "unknown" })

		if (!success) return c.json({ error: "rate limit exceeded" }, 429, { "Cache-Control": "no-store" })

		const q = (c.req.query("q") ?? "").trim()
		const limitText = c.req.query("limit")
		const limit = limitText === undefined ? DEFAULT_LIMIT : Number(limitText)

		if (q === "" || q.length > MAX_QUERY_LENGTH) {
			return c.json({ error: `q must be 1 to ${MAX_QUERY_LENGTH} characters` }, 400, { "Cache-Control": "no-store" })
		}

		if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
			return c.json({ error: `limit must be an integer from 1 to ${MAX_LIMIT}` }, 400, { "Cache-Control": "no-store" })
		}

		return c.json(await search(deps, q, limit), 200, { "Cache-Control": "public, max-age=300" })
	})
}
```

`packages/search-worker/lib/routes/ingest.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { Hono } from "hono"

import type { SearchWorkerEnv } from "#env"
import { type IngestDependencies, IngestRefusal, runIngest } from "#ingest"

/**
 * Compare two strings in time that depends on their lengths alone.
 */
function sameToken(given: string, expected: string): boolean {
	const encoder = new TextEncoder()
	const a = encoder.encode(given)
	const b = encoder.encode(expected)
	let difference = a.length ^ b.length

	for (let index = 0; index < b.length; index++) difference |= (a[index] ?? 0) ^ (b[index] as number)

	return difference === 0
}

export function registerIngestRoute(app: Hono, env: SearchWorkerEnv, deps: IngestDependencies): void {
	app.post("/ingest", async (c) => {
		c.header("Cache-Control", "no-store")

		const given = c.req.header("authorization") ?? ""

		if (!sameToken(given, `Bearer ${env.INGEST_TOKEN}`)) return c.json({ error: "unauthorized" }, 401)

		try {
			return c.json(await runIngest(deps, { force: c.req.query("force") === "1" }))
		} catch (error) {
			if (error instanceof IngestRefusal) return c.json({ error: error.message }, 409)

			throw error
		}
	})
}
```

Search the repository for an existing constant-time comparison before keeping `sameToken`: run `mwdev_symbol` with `describes: "constant-time string comparison"`. Use the existing helper when it runs on the Workers runtime.

`packages/search-worker/lib/routes/health.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The deploy receipt and the operator's view of the index: how many records it holds and how the latest
 *   ingest run ended.
 */

import type { Hono } from "hono"

interface RunRow {
	started_at: string
	commit_sha: string
	added: number
	changed: number
	removed: number
	outcome: string
}

export function registerHealthRoute(app: Hono, db: D1Database): void {
	app.get("/health", async (c) => {
		const [count, lastRun] = await Promise.all([
			db.prepare("SELECT COUNT(*) AS records FROM records").first<{ records: number }>(),
			db.prepare("SELECT * FROM ingest_runs ORDER BY started_at DESC LIMIT 1").first<RunRow>(),
		])

		if (!count) throw new Error("the record count query returned no row")

		return c.json({ records: count.records, lastRun }, 200, { "Cache-Control": "no-store" })
	})
}
```

`packages/search-worker/lib/app.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The search worker's Hono app. Dependencies arrive as values so a test can pass in-memory vector and
 *   embedding implementations and a manifest it controls.
 */

import { Hono } from "hono"
import { cors } from "hono/cors"

import type { SearchWorkerEnv } from "#env"
import type { IngestDependencies } from "#ingest"
import { registerHealthRoute } from "#routes/health"
import { registerIngestRoute } from "#routes/ingest"
import { registerSearchRoute } from "#routes/search"
import type { SearchDependencies } from "#search"

export interface AppDependencies extends SearchDependencies, IngestDependencies {}

const LOCAL_DOCS_ORIGIN = "http://localhost:3000"

export function createSearchWorkerApp(env: SearchWorkerEnv, deps: AppDependencies): Hono {
	const app = new Hono()

	app.use("/search", cors({ origin: [env.SITE_ORIGIN, LOCAL_DOCS_ORIGIN], allowMethods: ["GET"] }))

	app.onError((error, c) => {
		console.error(error instanceof Error ? error.message : String(error))

		return c.json({ error: "search unavailable" }, 502, { "Cache-Control": "no-store" })
	})

	registerSearchRoute(app, env, deps)
	registerIngestRoute(app, env, deps)
	registerHealthRoute(app, deps.db)

	return app
}
```

`packages/search-worker/lib/index.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The worker's entry points. `fetch` serves queries, and `scheduled` runs one ingest.
 */

import type { ExportedHandler } from "@cloudflare/workers-types"
import { stringifyJSON } from "@mailwoman/core/json"

import { type AppDependencies, createSearchWorkerApp } from "#app"
import { vectorizeStore, workersAIEmbedder } from "#embed"
import { readEnv, type SearchWorkerBindings, type SearchWorkerEnv } from "#env"
import { runIngest } from "#ingest"

function dependencies(env: SearchWorkerEnv): AppDependencies {
	if (!env.SEARCH_VECTORS || !env.AI) throw new Error("the SEARCH_VECTORS and AI bindings are required")

	return {
		db: env.SEARCH_DB,
		vectors: vectorizeStore(env.SEARCH_VECTORS),
		embedder: workersAIEmbedder(env.AI),
		fetchManifest: () => fetch(env.MANIFEST_URL, { headers: { accept: "application/json" }, cf: { cacheTtl: 0 } }),
	}
}

const handler: ExportedHandler<SearchWorkerBindings> = {
	async fetch(request, bindings) {
		let env: SearchWorkerEnv
		let deps: AppDependencies

		try {
			env = readEnv(bindings)
			deps = dependencies(env)
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error))

			return Response.json({ error: "worker misconfigured" }, { status: 503, headers: { "cache-control": "no-store" } })
		}

		return createSearchWorkerApp(env, deps).fetch(request)
	},

	async scheduled(_controller, bindings, ctx) {
		const env = readEnv(bindings)

		// The rejection propagates so the cron invocation is recorded as failed in the Cloudflare dashboard.
		ctx.waitUntil(runIngest(dependencies(env)).then((report) => console.log(stringifyJSON({ ingest: report }))))
	},
}

export default handler
```

`packages/search-worker/wrangler.toml`:

```toml
# The docs search worker: the docs build's record manifest in, hybrid search results out.
#
# This file is production. `wrangler.sandbox.toml` is the test pool's config and declares only the bindings
# Miniflare simulates. The one secret is INGEST_TOKEN, set with `wrangler secret put INGEST_TOKEN`.
# Keep `routes` above [vars]: a top-level key placed after a table header joins that table.

name = "mailwoman-search"
main = "./lib/index.ts"
compatibility_date = "2026-08-22"
routes = [{ pattern = "search.mailwoman.ai", custom_domain = true }]

[triggers]
crons = ["0 */6 * * *"]

[vars]
SITE_ORIGIN = "https://mailwoman.ai"
MANIFEST_URL = "https://mailwoman.ai/search-records.json"

[ai]
binding = "AI"

[[vectorize]]
binding = "SEARCH_VECTORS"
index_name = "mailwoman-docs"

[[d1_databases]]
binding = "SEARCH_DB"
database_name = "mailwoman-search"
database_id = "REPLACE_WITH_THE_ID_FROM_TASK_10"
migrations_dir = "migrations"

[[ratelimits]]
name = "SEARCH_LIMITER"
namespace_id = "2101"
simple = { limit = 60, period = 60 }
```

- [ ] **Step 5: Run the whole worker suite and confirm it passes**

Run: `yarn workspace @mailwoman/search-worker test`
Expected: PASS for every file. The `/search` failure test expects status 200 when the embedder throws; a 502 there means `search` awaited the vector arm outside `Promise.allSettled`.

- [ ] **Step 6: Type-check and commit**

Run: `yarn tsc -b packages/search-worker && yarn tsc -p packages/search-worker/tsconfig.test.json --noEmit`
Expected: zero errors.

```bash
git add packages/search-worker
git commit -m "Serve hybrid search, authenticated ingest and a health receipt from the search worker" -- packages/search-worker
```

---

### Task 8: Search modal in `@mailwoman/react`

**Files:**

- Create: `packages/react/lib/search/client.ts`, `packages/react/lib/search/SearchModal.tsx`, `packages/react/lib/search/SearchModal.test.tsx`, `packages/react/lib/search/search.css`, `packages/react/lib/search.ts`
- Modify: `packages/react/package.json` (exports for `./search`, `./search/client`, `./search/SearchModal`; run the `workspace-exports` fix), `packages/react/styles.css` (import `search.css` the way the other component styles are included)

**Interfaces:**

- Consumes: the wire shape of `SearchResponse` and `SearchHit` via `import type` from `@mailwoman/search-worker/search`. Add `@mailwoman/search-worker` to `packages/react` `devDependencies`; the type import adds no runtime dependency.
- Produces: `searchDocs(origin: string, q: string, signal: AbortSignal): Promise<SearchResponse>`, `SearchModal(props: SearchModalProps)`, `interface SearchModalProps { origin: string; open: boolean; onClose: () => void; onNavigate?: (href: string) => void; search?: typeof searchDocs }`.

Read `packages/react/lib/common/CopyButton.tsx`, its test, and `packages/react/test/render.tsx` first. Follow their class-name convention and use the color, spacing and radius tokens from `packages/react/tokens.css` in `search.css`. Load the `frontend-design:frontend-design` skill before writing the CSS.

- [ ] **Step 1: Write the failing test**

`packages/react/lib/search/SearchModal.test.tsx`:

```tsx
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { SearchModal } from "@mailwoman/react/search/SearchModal"
import type { SearchResponse } from "@mailwoman/search-worker/search"
import { expect, test, vi } from "vitest"
import { userEvent } from "vitest/browser"

import { renderComponent } from "../../test/render.tsx"

function response(query: string, urls: string[]): SearchResponse {
	return {
		query,
		arms: { lexical: "primary", vector: "ok" },
		hits: urls.map((url, index) => ({
			url,
			anchor: index === 0 ? "" : "section",
			hierarchy: [index < 2 ? "Reference" : "Guides", `Title ${url}`, null, null, null, null, null],
			snippet: `Snippet for ${url}`,
			highlights: [[0, 7]],
		})),
	}
}

function mount(search: (origin: string, q: string, signal: AbortSignal) => Promise<SearchResponse>) {
	const onClose = vi.fn()
	const onNavigate = vi.fn()
	const view = renderComponent(
		<SearchModal origin="https://search.test" open onClose={onClose} onNavigate={onNavigate} search={search} />
	)
	const dialog = view.container.querySelector("dialog") as HTMLDialogElement
	const input = view.container.querySelector('input[type="search"]') as HTMLInputElement

	return { ...view, dialog, input, onClose, onNavigate }
}

test("opens a modal dialog and focuses a search input that is a combobox", async () => {
	const { dialog, input } = mount(async (_origin, q) => response(q, []))

	await vi.waitFor(() => expect(dialog.open).toBe(true))
	expect(dialog.matches(":modal")).toBe(true)
	expect(dialog.hasAttribute("role")).toBe(false)
	expect(document.activeElement).toBe(input)
	expect(input.getAttribute("role")).toBe("combobox")
	expect(input.getAttribute("aria-autocomplete")).toBe("list")
	expect(input.getAttribute("aria-expanded")).toBe("false")
})

test("renders hits as options in labeled groups and selects the first", async () => {
	const { container, input } = mount(async (_origin, q) => response(q, ["/a", "/b", "/c"]))

	await userEvent.type(input, "decoder")

	await vi.waitFor(() => expect(container.querySelectorAll('[role="option"]')).toHaveLength(3))

	const listbox = container.querySelector('[role="listbox"]') as HTMLElement
	const groups = [...container.querySelectorAll('[role="group"]')]
	const options = [...container.querySelectorAll('[role="option"]')]

	expect(input.getAttribute("aria-controls")).toBe(listbox.id)
	expect(input.getAttribute("aria-expanded")).toBe("true")
	expect(groups).toHaveLength(2)
	expect(document.getElementById(groups[0]!.getAttribute("aria-labelledby")!)?.textContent).toBe("Reference")
	expect(input.getAttribute("aria-activedescendant")).toBe(options[0]!.id)
	expect(options[0]!.getAttribute("aria-selected")).toBe("true")
	expect(options[1]!.querySelector("a")?.getAttribute("href")).toBe("/b#section")
	expect(options[0]!.querySelector("mark")?.textContent).toBe("Snippet")
})

test("moves the selection with the arrow keys, wraps, and navigates on Enter", async () => {
	const { container, input, onNavigate, onClose } = mount(async (_origin, q) => response(q, ["/a", "/b"]))

	await userEvent.type(input, "x")
	await vi.waitFor(() => expect(container.querySelectorAll('[role="option"]')).toHaveLength(2))

	const options = [...container.querySelectorAll('[role="option"]')]

	await userEvent.keyboard("{ArrowDown}")
	expect(input.getAttribute("aria-activedescendant")).toBe(options[1]!.id)
	await userEvent.keyboard("{ArrowDown}")
	expect(input.getAttribute("aria-activedescendant")).toBe(options[0]!.id)
	await userEvent.keyboard("{ArrowUp}")
	expect(input.getAttribute("aria-activedescendant")).toBe(options[1]!.id)
	expect(document.activeElement).toBe(input)

	await userEvent.keyboard("{Enter}")
	expect(onNavigate).toHaveBeenCalledWith("/b#section")
	expect(onClose).toHaveBeenCalled()
})

test("calls onClose when the dialog closes on Escape", async () => {
	const { dialog, onClose } = mount(async (_origin, q) => response(q, []))

	await vi.waitFor(() => expect(dialog.open).toBe(true))
	await userEvent.keyboard("{Escape}")
	await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
})

test("keeps the results of the latest query when an earlier response arrives later", async () => {
	const pending = new Map<string, (value: SearchResponse) => void>()
	const { container, input } = mount(
		(_origin, q) =>
			new Promise<SearchResponse>((resolve) => {
				pending.set(q, resolve)
			})
	)

	await userEvent.type(input, "a")
	await vi.waitFor(() => expect(pending.has("a")).toBe(true))
	await userEvent.type(input, "b")
	await vi.waitFor(() => expect(pending.has("ab")).toBe(true))

	pending.get("ab")!(response("ab", ["/latest"]))
	await vi.waitFor(() => expect(container.querySelector('[role="option"] a')?.getAttribute("href")).toBe("/latest"))

	pending.get("a")!(response("a", ["/stale"]))
	await new Promise((resolve) => setTimeout(resolve, 50))
	expect(container.querySelector('[role="option"] a')?.getAttribute("href")).toBe("/latest")
})

test("announces zero hits and a failed request in the live region", async () => {
	let fail = false
	const { container, input } = mount(async (_origin, q) => {
		if (fail) throw new Error("network")

		return response(q, [])
	})
	const status = container.querySelector('[aria-live="polite"]') as HTMLElement

	await userEvent.type(input, "zzz")
	await vi.waitFor(() => expect(status.textContent).toBe("No results for “zzz”."))

	fail = true
	await userEvent.type(input, "z")
	await vi.waitFor(() => expect(status.textContent).toBe("Search is unavailable. Try again in a moment."))
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `yarn workspace @mailwoman/react test:browser lib/search/SearchModal.test.tsx`
Expected: FAIL. `@mailwoman/react/search/SearchModal` cannot be resolved.

- [ ] **Step 3: Implement the client**

`packages/react/lib/search/client.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The browser's call to the docs search worker.
 */

import type { SearchHit, SearchResponse } from "@mailwoman/search-worker/search"

/**
 * @throws when the worker answers a status other than 200 or the request is aborted.
 */
export async function searchDocs(origin: string, q: string, signal: AbortSignal): Promise<SearchResponse> {
	const url = new URL("/search", origin)

	url.searchParams.set("q", q)

	const response = await fetch(url, { signal })

	if (!response.ok) throw new Error(`search answered status ${response.status}`)

	return (await response.json()) as SearchResponse
}

/**
 * The site-relative link for a hit.
 */
export function hitHref(hit: Pick<SearchHit, "url" | "anchor">): string {
	return hit.anchor === "" ? hit.url : `${hit.url}#${hit.anchor}`
}
```

- [ ] **Step 4: Implement the modal**

`packages/react/lib/search/SearchModal.tsx`:

```tsx
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The docs search modal. A native `<dialog>` opened with `showModal()` supplies the focus trap, the inert
 *   background, the backdrop, the close on Escape and the return of focus to the opener. The query field is an
 *   `<input type="search">` with the ARIA combobox role. DOM focus stays on the input, and the selected hit is
 *   named by `aria-activedescendant`.
 */

import type { SearchHit, SearchResponse } from "@mailwoman/search-worker/search"
import { type KeyboardEvent, type MouseEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react"

import { useDebouncedValue } from "#common/useDebouncedValue"

import { hitHref, searchDocs } from "./client.ts"

export interface SearchModalProps {
	/**
	 * The search worker's origin, such as `https://search.mailwoman.ai`.
	 */
	origin: string
	open: boolean
	onClose: () => void
	/**
	 * Called with the hit's site-relative link when the reader presses Enter or clicks a hit without a
	 * modifier key. Absent, the link navigates as an ordinary anchor.
	 */
	onNavigate?: (href: string) => void
	search?: typeof searchDocs
}

type Status = { kind: "idle" } | { kind: "results"; query: string; hits: SearchHit[] } | { kind: "failed" }

const DEBOUNCE_MS = 150
const DEFAULT_CATEGORY = "Documentation"

function statusText(status: Status): string {
	if (status.kind === "failed") return "Search is unavailable. Try again in a moment."
	if (status.kind === "idle") return ""
	if (status.hits.length === 0) return `No results for “${status.query}”.`

	return status.hits.length === 1 ? "1 result." : `${status.hits.length} results.`
}

function highlighted(hit: SearchHit): ReactNode[] {
	const parts: ReactNode[] = []
	let cursor = 0

	for (const [start, end] of hit.highlights) {
		if (start < cursor) continue

		parts.push(hit.snippet.slice(cursor, start), <mark key={start}>{hit.snippet.slice(start, end)}</mark>)
		cursor = end
	}

	parts.push(hit.snippet.slice(cursor))

	return parts
}

function title(hit: SearchHit): string {
	return hit.hierarchy
		.slice(1)
		.filter((entry): entry is string => entry !== null)
		.join(" › ")
}

export function SearchModal({ origin, open, onClose, onNavigate, search = searchDocs }: SearchModalProps) {
	const dialogRef = useRef<HTMLDialogElement>(null)
	const inputRef = useRef<HTMLInputElement>(null)
	const baseID = useId()
	const listboxID = `${baseID}-listbox`
	const [query, setQuery] = useState("")
	const [status, setStatus] = useState<Status>({ kind: "idle" })
	const [selected, setSelected] = useState(0)
	const debounced = useDebouncedValue(query.trim(), DEBOUNCE_MS)

	useEffect(() => {
		const dialog = dialogRef.current

		if (!dialog) return

		if (open && !dialog.open) {
			dialog.showModal()
			inputRef.current?.focus()
		} else if (!open && dialog.open) {
			dialog.close()
		}
	}, [open])

	useEffect(() => {
		if (debounced === "") {
			setStatus({ kind: "idle" })

			return
		}

		// Aborting the earlier request is what keeps a late response from replacing newer results.
		const controller = new AbortController()

		search(origin, debounced, controller.signal).then(
			(response: SearchResponse) => {
				if (controller.signal.aborted) return

				setStatus({ kind: "results", query: debounced, hits: response.hits })
				setSelected(0)
			},
			() => {
				if (!controller.signal.aborted) setStatus({ kind: "failed" })
			}
		)

		return () => controller.abort()
	}, [debounced, origin, search])

	const hits = status.kind === "results" ? status.hits : []

	const groups = useMemo(() => {
		const byCategory = new Map<string, { hit: SearchHit; index: number }[]>()

		hits.forEach((hit, index) => {
			const category = hit.hierarchy[0] ?? DEFAULT_CATEGORY

			byCategory.set(category, [...(byCategory.get(category) ?? []), { hit, index }])
		})

		// Options are numbered in display order so the arrow keys follow what the reader sees.
		let order = 0

		return [...byCategory].map(([category, entries]) => ({
			category,
			entries: entries.map((entry) => ({ hit: entry.hit, order: order++ })),
		}))
	}, [hits])

	const ordered = groups.flatMap((group) => group.entries)
	const optionID = (order: number) => `${baseID}-option-${order}`

	function go(hit: SearchHit) {
		const href = hitHref(hit)

		onClose()

		if (onNavigate) onNavigate(href)
		else window.location.assign(href)
	}

	function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
		if (ordered.length === 0) return

		const last = ordered.length - 1
		const next =
			event.key === "ArrowDown"
				? selected === last
					? 0
					: selected + 1
				: event.key === "ArrowUp"
					? selected === 0
						? last
						: selected - 1
					: event.key === "Home"
						? 0
						: event.key === "End"
							? last
							: undefined

		if (next !== undefined) {
			event.preventDefault()
			setSelected(next)
			document.getElementById(optionID(next))?.scrollIntoView({ block: "nearest" })
		} else if (event.key === "Enter") {
			event.preventDefault()

			const entry = ordered[selected]

			if (entry) go(entry.hit)
		}
	}

	function onDialogClick(event: MouseEvent<HTMLDialogElement>) {
		// A click whose target is the dialog element itself landed on the backdrop.
		if (event.target === event.currentTarget) event.currentTarget.close()
	}

	function onLinkClick(event: MouseEvent<HTMLAnchorElement>, hit: SearchHit) {
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return

		event.preventDefault()
		go(hit)
	}

	return (
		<dialog
			ref={dialogRef}
			className="mw-search"
			aria-label="Search the documentation"
			onClose={onClose}
			onClick={onDialogClick}
		>
			<form role="search" className="mw-search__form" onSubmit={(event) => event.preventDefault()}>
				<input
					ref={inputRef}
					type="search"
					className="mw-search__input"
					role="combobox"
					aria-label="Search the documentation"
					aria-autocomplete="list"
					aria-expanded={ordered.length > 0}
					aria-controls={listboxID}
					aria-activedescendant={ordered.length > 0 ? optionID(selected) : undefined}
					autoComplete="off"
					spellCheck={false}
					placeholder="Search the documentation"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					onKeyDown={onKeyDown}
				/>
			</form>

			<div id={listboxID} role="listbox" aria-label="Search results" className="mw-search__results">
				{groups.map((group, groupIndex) => (
					<div
						key={group.category}
						role="group"
						aria-labelledby={`${baseID}-group-${groupIndex}`}
						className="mw-search__group"
					>
						<div id={`${baseID}-group-${groupIndex}`} role="presentation" className="mw-search__category">
							{group.category}
						</div>
						{group.entries.map(({ hit, order }) => (
							<div
								key={order}
								id={optionID(order)}
								role="option"
								aria-selected={order === selected}
								className="mw-search__option"
								onPointerMove={() => setSelected(order)}
							>
								<a
									href={hitHref(hit)}
									tabIndex={-1}
									className="mw-search__link"
									onClick={(event) => onLinkClick(event, hit)}
								>
									<span className="mw-search__title">{title(hit)}</span>
									{hit.snippet !== "" && <span className="mw-search__snippet">{highlighted(hit)}</span>}
								</a>
							</div>
						))}
					</div>
				))}
			</div>

			<p aria-live="polite" className="mw-search__status">
				{statusText(status)}
			</p>
		</dialog>
	)
}
```

The component omits the `closedby` attribute and closes on a backdrop click through `onDialogClick`, which behaves the same in every browser. Set padding on `.mw-search__form`, `.mw-search__results` and `.mw-search__status`, and zero padding on the `dialog` element, so a click inside the visible panel never has the dialog as its target.

`packages/react/lib/search.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The docs search modal and its client.
 */

export { hitHref, searchDocs } from "./search/client.ts"
export { SearchModal } from "./search/SearchModal.tsx"
export type { SearchModalProps } from "./search/SearchModal.tsx"
```

Write `packages/react/lib/search/search.css` with rules for `.mw-search` (panel width `min(40rem, 92vw)`, `max-height: 70vh`, zero padding, top-aligned with `margin-top: 12vh`), `.mw-search::backdrop`, `.mw-search__input` (full width, at least 44px tall), `.mw-search__results` (scrolls vertically), `.mw-search__category`, `.mw-search__option[aria-selected="true"]` (a background that meets 3:1 contrast against the panel), `.mw-search__link`, `.mw-search__title`, `.mw-search__snippet`, `.mw-search__snippet mark`, and `.mw-search__status`. Every color, radius and spacing value is a custom property from `tokens.css`. Add a `@media (prefers-reduced-motion: no-preference)` block for any open transition, and none outside it.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `yarn workspace @mailwoman/react test:browser lib/search/SearchModal.test.tsx`
Expected: PASS, 6 tests.

- [ ] **Step 6: Register exports, lint and commit**

Run: `git add packages/react/lib/search packages/react/lib/search.ts && yarn lint`
Expected: the `workspace-exports` check reports the missing `./search` entries. Apply the fix it names, then run `yarn lint` again and expect zero findings for `packages/react`.

```bash
git commit -m "Add a docs search modal on a native dialog and an ARIA combobox" -- packages/react yarn.lock
```

---

### Task 9: Mount the modal in the docs site and remove Algolia

**Files:**

- Create: `docs/src/theme/SearchBar.tsx`
- Modify: `docs/docusaurus.config.ts` (delete the `algolia` block at lines 262–266; add `searchOrigin` to `customFields` at line 44)

**Interfaces:**

- Consumes: `SearchModal` from `@mailwoman/react/search/SearchModal`.

- [ ] **Step 1: Edit the Docusaurus config**

Delete this block from `themeConfig`:

```ts
		algolia: {
			appId: "1AEXFQAAAJ",
			indexName: "Mailwoman Site",
			apiKey: "637194a77c844e7df987b51d59505272",
		},
```

Add one entry to `customFields`:

```ts
		searchOrigin: process.env["MAILWOMAN_SEARCH_ORIGIN"] ?? "https://search.mailwoman.ai",
```

Read how the config reads other environment values first, and use the same accessor when the file has one.

- [ ] **Step 2: Create the theme component**

`docs/src/theme/SearchBar.tsx`:

```tsx
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The navbar search control. It opens the search modal on a click, on Ctrl+K or Cmd+K, and on `/`
 *   pressed outside a text field.
 */

import { useHistory } from "@docusaurus/router"
import useDocusaurusContext from "@docusaurus/useDocusaurusContext"
import { SearchModal } from "@mailwoman/react/search/SearchModal"
import { useEffect, useState } from "react"

function isEditable(target: EventTarget | null): boolean {
	return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
}

export default function SearchBar() {
	const { siteConfig } = useDocusaurusContext()
	const history = useHistory()
	const [open, setOpen] = useState(false)
	const origin = String(siteConfig.customFields?.["searchOrigin"])

	useEffect(() => {
		function onKeyDown(event: KeyboardEvent) {
			const shortcut =
				(event.key === "k" && (event.metaKey || event.ctrlKey)) || (event.key === "/" && !isEditable(event.target))

			if (!shortcut) return

			event.preventDefault()
			setOpen(true)
		}

		window.addEventListener("keydown", onKeyDown)

		return () => window.removeEventListener("keydown", onKeyDown)
	}, [])

	return (
		<>
			<button
				type="button"
				className="navbar__search-button"
				aria-keyshortcuts="Control+K Meta+K /"
				onClick={() => setOpen(true)}
			>
				Search
			</button>
			<SearchModal
				origin={origin}
				open={open}
				onClose={() => setOpen(false)}
				onNavigate={(href) => history.push(href)}
			/>
		</>
	)
}
```

Style `.navbar__search-button` in the docs site's custom CSS file beside the existing navbar rules. Confirm the docs site already loads `@mailwoman/react/styles.css`; add the import where the other `@mailwoman/react` styles are loaded when it does not.

- [ ] **Step 3: Verify in a browser**

Load the `run-docs` skill. Start the worker with `yarn workspace @mailwoman/search-worker dev` only when Vectorize and Workers AI are reachable; otherwise set `MAILWOMAN_SEARCH_ORIGIN` to the production worker after Task 10. Start the docs site and check with the Chrome DevTools tools:

1. `Ctrl+K` opens the dialog and focus is in the search field.
2. The query `decoder` lists hits within one second; `ArrowDown` moves the selection; `Enter` opens the page without a full reload.
3. `Escape` closes the dialog and focus returns to the Search button.
4. A click on the backdrop closes the dialog.
5. `git grep -niE "algolia|docsearch" -- docs/docusaurus.config.ts docs/src docs/package.json` prints zero lines.

Run the `chrome-devtools-mcp:a11y-debugging` skill's audit on the open dialog and fix each finding in `packages/react/lib/search/`.

- [ ] **Step 4: Build and commit**

Run: `yarn workspace @mailwoman/docs build`
Expected: the build succeeds and prints the `search-records: wrote N records` line.

```bash
git add docs/src/theme/SearchBar.tsx
git commit -m "Mount the search modal in the docs navbar and delete the Algolia config" -- docs/src/theme/SearchBar.tsx docs/docusaurus.config.ts docs/src
```

---

### Task 10: Repository wiring and Cloudflare resources

**Files:**

- Modify: `package.json` (root): `ci:workers` at line 33, and a new `test:search-worker` script beside `test:license-worker` at line 75
- Modify: `vitest.config.ts` (root): the exclude list at line 136
- Modify: `knip.json`: a `packages/search-worker` entry beside `packages/license-worker` at line 91
- Modify: `packages/release-kit/lib/deploy/targets.ts`: `DeployTargetID` at line 19 and the `DEPLOY_TARGETS` table
- Modify: `.github/workflows/test.yml`: a step beside "Test license worker (Workers pool)" at line 524
- Modify: `.github/workflows/docs-build.yml`: an ingest call after the site upload
- Modify: `docs/engineering/reference/workspaces.mdx`, `AGENTS.md`
- Modify: `packages/search-worker/wrangler.toml` (the D1 database id)

- [ ] **Step 1: Root scripts and tool configs**

In root `package.json`, change `ci:workers` to end with `tsc -b packages/license-worker packages/tile-worker packages/search-worker` and add:

```json
		"test:search-worker": "yarn workspace @mailwoman/search-worker test",
```

In root `vitest.config.ts`, add `"**/search-worker/**/*.test.ts",` beside the `license-worker` exclusion. In `knip.json`, add:

```json
		"packages/search-worker": {
			"entry": ["lib/index.ts", "test/**/*.ts", "vitest.config.ts"],
			"ignoreDependencies": ["@cloudflare/vitest-pool-workers", "cloudflare", "wrangler"]
		},
```

In `.github/workflows/test.yml`, add after the license worker step:

```yaml
- name: Test search worker (Workers pool)
  run: yarn test:search-worker
```

- [ ] **Step 2: Deploy target**

In `packages/release-kit/lib/deploy/targets.ts`, add `"search"` to `DeployTargetID`, update the "five Workers" comment to the new count, and add this row after the `license` row:

```ts
	{
		id: "search",
		worker: "mailwoman-search",
		workspace: "@mailwoman/search-worker",
		cwd: "packages/search-worker",
		build: "",
		body: "",
		deployArgs: "",
		receipt: "https://search.mailwoman.ai/health",
	},
```

Update the `workflow_dispatch` `targets` description in `.github/workflows/deploy.yml` line 26 to list `search`. Run the tests beside `targets.ts` and correct any count they derive from the table: `yarn vitest run packages/release-kit/lib/deploy`.

- [ ] **Step 3: Workspace registration and catalog**

Follow the workspace check in `packages/release-kit/AGENTS.md` for a new private workspace. Add a `@mailwoman/search-worker` row to `docs/engineering/reference/workspaces.mdx` in the form the `license-worker` row uses. In `AGENTS.md`, raise the scoped package count, the workspace count and the private workspace count by one each, and rewrite those sentences as if the new counts had always held.

- [ ] **Step 4: Operator creates the Cloudflare resources**

These commands create billed resources and need the operator's Cloudflare credentials. Ask the operator to run them from `packages/search-worker`:

```bash
yarn wrangler d1 create mailwoman-search
yarn wrangler vectorize create mailwoman-docs --dimensions=768 --metric=cosine
yarn wrangler d1 migrations apply SEARCH_DB --remote
openssl rand -hex 32 | yarn wrangler secret put INGEST_TOKEN
```

Put the `database_id` printed by the first command into `packages/search-worker/wrangler.toml`. The operator also adds the same token as the `SEARCH_INGEST_TOKEN` secret of the GitHub environment the docs deploy job uses.

- [ ] **Step 5: Ingest after a docs deploy**

Read `.github/workflows/docs-build.yml` and add this step after the step that publishes the site, in the same job, with the secret in that job's `env`:

```yaml
- name: Ingest the search manifest
  env:
    SEARCH_INGEST_TOKEN: ${{ secrets.SEARCH_INGEST_TOKEN }}
  run: |
    curl --fail-with-body --silent --show-error -X POST \
      -H "Authorization: Bearer ${SEARCH_INGEST_TOKEN}" \
      https://search.mailwoman.ai/ingest
```

A refused ingest answers status 409, and `--fail-with-body` fails the step and prints the reason.

- [ ] **Step 6: Lint, type-check, test and commit**

Run: `git add -- package.json vitest.config.ts knip.json packages/release-kit .github docs/engineering/reference/workspaces.mdx AGENTS.md packages/search-worker/wrangler.toml && yarn lint && yarn typecheck && yarn test && yarn test:search-worker`
Expected: each command exits 0.

```bash
git commit -m "Register the search worker in the build, test, deploy and workspace catalogs" -- package.json vitest.config.ts knip.json packages/release-kit .github docs/engineering/reference/workspaces.mdx AGENTS.md packages/search-worker/wrangler.toml
```

---

### Task 11: Acceptance against the real manifest

**Files:**

- Create: `packages/search-worker/vitest.integration.config.ts`, `packages/search-worker/lib/search.integration.test.ts`
- Modify: `packages/search-worker/package.json` (add `"test:integration": "vitest run --config vitest.integration.config.ts"`)

**Interfaces:**

- Consumes: `runIngest` from `#ingest`; `search` from `#search`; `fakeEmbedder`, `fakeVectors` from `#test/support/fakes`; the file `docs/build/search-records.json` from Task 2.

The vector arm is a fake here, so this suite measures the lexical arm and the fusion on the real records. The production check in Step 4 measures the complete system.

- [ ] **Step 1: Write the integration config**

`packages/search-worker/vitest.integration.config.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The acceptance suite. It reads the manifest of a real docs build and hands it to the test runtime as a
 *   binding. Build the docs first with `yarn workspace @mailwoman/docs build`.
 */

import { readFile } from "node:fs/promises"

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"

const manifestPath = `${import.meta.dirname}/../../docs/build/search-records.json`
const migrations = await readD1Migrations(`${import.meta.dirname}/migrations`)

// A missing manifest throws here, so the suite cannot pass without reading one.
const manifest = await readFile(manifestPath, "utf8")

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.sandbox.toml" },
			miniflare: {
				bindings: { INGEST_TOKEN: "test-ingest-token", TEST_MIGRATIONS: migrations, TEST_MANIFEST: manifest },
			},
		}),
	],
	test: { include: ["lib/**/*.integration.test.ts"] },
})
```

Replace `node:fs/promises` with the `@mailwoman/core/fs/readers` reader that `docs/plugins/runtime-assets/artifacts.test.ts` uses, and add the `TEST_MANIFEST: string` binding to the test declaration file from Task 1.

- [ ] **Step 2: Write the acceptance test**

`packages/search-worker/lib/search.integration.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { env } from "cloudflare:workers"
import { beforeAll, describe, expect, it } from "vitest"

import { runIngest } from "#ingest"
import { search, type SearchDependencies } from "#search"
import { fakeEmbedder, fakeVectors } from "#test/support/fakes"
import { applyMigrations } from "#test/support/migrations"

/**
 * The spec's acceptance list. Each query must return the page within this many hits.
 */
const WITHIN = 3

const ACCEPTANCE: [query: string, url: string][] = [
	["decoder grammar", "/docs/engineering/reference/decoder-grammar"],
	["ComponentTag", "/docs/engineering/reference/SCHEMA"],
	["jurisdiction coverage", "/docs/engineering/reference/jurisdiction-coverage"],
	["layer manifest", "/docs/engineering/reference/layer-interface"],
	["tier-1 regression", "/docs/engineering/CONTRIBUTING_MODEL_WORK"],
	["jurisdction coverage", "/docs/engineering/reference/jurisdiction-coverage"],
]

let deps: SearchDependencies

beforeAll(async () => {
	await applyMigrations(env.SEARCH_DB)
	deps = { db: env.SEARCH_DB, embedder: fakeEmbedder(), vectors: fakeVectors() }

	const report = await runIngest({ ...deps, fetchManifest: async () => new Response(env.TEST_MANIFEST) })

	expect(report.outcome).toBe("applied")
	expect(report.added).toBeGreaterThan(0)
}, 120_000)

describe("the acceptance list", () => {
	it.each(ACCEPTANCE)(`returns the page for "%s" within the first ${WITHIN} hits`, async (query, url) => {
		const response = await search(deps, query, WITHIN)

		expect(response.hits.map((hit) => hit.url)).toContain(url)
	})
})
```

Use the URL paths that Task 2 Step 6 confirmed in the manifest and wrote into the spec.

- [ ] **Step 3: Run the suite**

Run: `yarn workspace @mailwoman/docs build && yarn workspace @mailwoman/search-worker test:integration`
Expected: PASS, 6 tests.

For a failing row, print the first eight hits for that query with their `hierarchy` before changing code, and identify which stage ranks the expected page low: the `bm25` order, the fusion with the fake vector list, or the URL collapse. Change the column weights in `lexical.ts` only when the `bm25` order is the cause, and rerun `lib/lexical.test.ts` afterward.

- [ ] **Step 4: Production check after the first deploy**

After the branch merges and the deploy workflow publishes `mailwoman-search`, run the first ingest and the acceptance queries against production:

```bash
curl --fail-with-body -sS -X POST -H "Authorization: Bearer $SEARCH_INGEST_TOKEN" https://search.mailwoman.ai/ingest
curl -sS https://search.mailwoman.ai/health
curl -sS "https://search.mailwoman.ai/search?q=jurisdction%20coverage&limit=3"
```

Expected: the ingest report has `"outcome":"applied"` and `added` equal to the record count from Task 2; `/health` reports the same count; the search response has `"vector":"ok"` and the jurisdiction coverage page among its hits. Report the three outputs to the operator.

- [ ] **Step 5: Commit**

```bash
git add packages/search-worker/vitest.integration.config.ts packages/search-worker/lib/search.integration.test.ts
git commit -m "Run the spec's acceptance queries against the real docs manifest" -- packages/search-worker
```

---

## After the plan

The spec's retirement step is the operator's: after the worker serves production search for one week without a refused ingest, delete the Algolia crawler and application and revoke both Algolia keys.
