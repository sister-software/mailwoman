# Docs Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Algolia DocSearch on `https://mailwoman.ai` with a gzip-compressed SQLite FTS5 index written by the docs build and queried in the browser through the sqlite-wasm worker the repository already ships, behind a native-element search modal in `@mailwoman/react`.

**Architecture:** The docs build extracts heading-scoped records from the built HTML and writes `search-index.db.gz`. The browser opens it whole in the existing range worker, which gains a `whole` open strategy with `DecompressionStream`. Pure query code in `docs/src/search/` runs BM25 lexical search with prefix matching and vocabulary-based typo correction over a two-method `SearchDatabase` interface, so the same code is tested in Node over `node:sqlite`. The modal in `@mailwoman/react` takes a `search` function and owns no data access.

**Tech Stack:** Docusaurus 3 plugin API, `htmlparser2`, `node:sqlite`, `node:zlib`, `@sqlite.org/sqlite-wasm` 3.53, React 19, Vitest (node and browser modes), Playwright.

**Spec:** `docs/superpowers/specs/2026-10-02-docs-search-design.md`

## Global Constraints

- Read `AGENTS.md` at the repository root and `packages/sqlite/AGENTS.md` before the first edit. The FTS5 `MATCH`, `bm25` and `fts5vocab` statements stay raw SQL; `packages/sqlite/AGENTS.md` describes the raw-SQL boundary.
- Relative imports include `.ts` or `.tsx`. Use `import type` for types. No `enum`, no constructor parameter properties.
- Acronyms are capitalized as a whole component: `collapseByURL`, `parseJSON`, `recordID`.
- A test sits beside its module as `<name>.test.ts`; the slow suite uses `<name>.integration.test.ts`.
- Node-side filesystem access goes through `@mailwoman/core/fs`; paths use `path-ts`.
- Browser code imports no Node builtin. The worker file `range-worker.ts` is bundled for the browser.
- The index file is `search-index.db.gz` at the site root. Pages are emitted as `<route>.html`.
- Lexical query reads 40 rows; `limit` is 1 to 20 with default 8; the modal caps text at 200 characters before a query runs.
- Typo correction: 10 candidates from `terms_trigram`; accepted when the Damerau-Levenshtein distance is at most 2, and at most 1 for a token under 6 characters; only tokens of at least 3 characters are corrected.
- The modal uses `<dialog>` with `showModal()`, `<input type="search">` with `role="combobox"`, and a `role="listbox"` result list. It adds no focus-trap code and no `role="dialog"` attribute.
- Shell commands may not write files inside the repository. Create and edit files with the file-editing tool.
- Stage by path. Never run `git add -A`. Run `git add` on a new file before `yarn lint`.

## Review Focus

1. User text containing FTS5 syntax (`"`, `*`, `:`, `-`, `AND`, `NEAR(`, `(`, `^`) returns hits or an empty list, never a thrown FTS5 syntax error. Test in Task 3.
2. Text of punctuation only (`--`, `***`) returns zero hits without a query reaching the database. Test in Task 3.
3. A response for an earlier query that resolves after a later query's response does not replace the later results in the modal. Test in Task 5.
4. A page with two headings sharing an `id`, or a heading without an `id`, yields distinct record ids and the build succeeds. Test in Task 2.
5. The gzip file is corrupt or truncated on the server: the worker rejects the open with the SQLite error text, and the modal states that search is unavailable. The worker half runs only in a browser and is covered by the Playwright test in Task 6; the modal's failure text is tested in Task 5.

---

## File Structure

```text
packages/resolver-wof-wasm/lib/httpvfs/
  worker-protocol.ts            OpenRequest gains `strategy`
  range-worker.ts               whole-file open with DecompressionStream and sqlite3_deserialize
  database.ts                   openWholeDatabase
  database.test.ts              the request the client posts for each strategy
docs/plugins/search-index/
  extract.ts                    HTML to SearchRecord[]
  extract.test.ts
  schema.ts                     the SQL schema, shared by the writer and the tests
  write-index.ts                records to a gzip-compressed SQLite file
  write-index.test.ts
  plugin.ts                     postBuild writer
docs/src/search/
  constants.ts                  file name and runtime path, browser-safe
  database.ts                   SearchDatabase interface
  database.node.ts              node:sqlite adapter and fixture database for tests
  fixtures.ts                   fixture records for the tests
  lexical.ts                    tokens, match expression, the FTS5 query
  lexical.test.ts
  correct.ts                    vocabulary typo correction
  correct.test.ts
  snippet.ts
  snippet.test.ts
  search.ts                     composes a SearchResponse
  search.test.ts
  search.integration.test.ts    acceptance list against docs/build
docs/src/theme/SearchBar.tsx    navbar button, lazy database open, the modal
docs/test/search.spec.ts        Playwright: the modal returns a hit on the built site
packages/react/lib/search.ts
packages/react/lib/search/types.ts
packages/react/lib/search/SearchModal.tsx
packages/react/lib/search/SearchModal.test.tsx
packages/react/lib/search/search.css
```

---

### Task 1: Whole-file open in the sqlite-wasm worker

**Files:**

- Modify: `packages/resolver-wof-wasm/lib/httpvfs/worker-protocol.ts` (`OpenRequest`)
- Modify: `packages/resolver-wof-wasm/lib/httpvfs/range-worker.ts` (the `open` handler)
- Modify: `packages/resolver-wof-wasm/lib/httpvfs/database.ts` (`openWholeDatabase`, and `strategy: "range"` in `openRangeDatabase`)
- Create: `packages/resolver-wof-wasm/lib/httpvfs/database.test.ts`

**Interfaces:**

- Produces: `openWholeDatabase(databaseURL: string, runtimeBaseURL: string): Promise<RangeDatabase>`; `OpenRequest.strategy: "range" | "whole"`.

Read `range-worker.ts` in full first; its `open` handler installs the range VFS and opens the database by name. The whole strategy skips the VFS.

- [ ] **Step 1: Write the failing test**

`packages/resolver-wof-wasm/lib/httpvfs/database.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The client half of the protocol: which `open` request each opener posts. The worker half runs only in
 *   a browser and is covered by the docs Playwright suite.
 */

import { afterEach, describe, expect, test, vi } from "vitest"

import { DEFAULT_CHUNK_SIZE, openRangeDatabase, openWholeDatabase } from "#httpvfs/database"
import type { RangeWorkerCall } from "#httpvfs/worker-protocol"

class FakeWorker extends EventTarget {
	static posted: RangeWorkerCall[] = []

	readonly url: string

	constructor(url: string) {
		super()
		this.url = url
	}

	postMessage(call: RangeWorkerCall): void {
		FakeWorker.posted.push(call)

		const result =
			call.type === "open"
				? { sqliteVersion: "3.53.0" }
				: call.type === "query"
					? [{ n: 1 }]
					: { requests: 1, bytes: 4 }

		queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: { id: call.id, result } })))
	}

	terminate(): void {}
}

afterEach(() => {
	FakeWorker.posted = []
	vi.unstubAllGlobals()
})

describe("the open request", () => {
	test("openRangeDatabase posts the range strategy with the chunk size", async () => {
		vi.stubGlobal("Worker", FakeWorker)
		vi.stubGlobal("location", { href: "https://example.test/page" })

		await openRangeDatabase("/data.db", "/sqlite/")

		expect(FakeWorker.posted[0]).toMatchObject({ type: "open", strategy: "range", chunkSize: DEFAULT_CHUNK_SIZE })
	})

	test("openWholeDatabase posts the whole strategy with the absolute database url", async () => {
		vi.stubGlobal("Worker", FakeWorker)
		vi.stubGlobal("location", { href: "https://example.test/page" })

		await openWholeDatabase("/search-index.db.gz", "/mailwoman/sqlite/")

		expect(FakeWorker.posted[0]).toMatchObject({
			type: "open",
			strategy: "whole",
			databaseURL: "https://example.test/search-index.db.gz",
			runtimeModuleURL: "https://example.test/mailwoman/sqlite/index.mjs",
		})
	})
})
```

Check how this package's other tests run (its `vitest.config.ts` or the root sweep) and whether `Worker` and `location` exist in that environment; the stubs assume they do not.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `yarn vitest run packages/resolver-wof-wasm/lib/httpvfs/database.test.ts`
Expected: FAIL. `openWholeDatabase` is not exported, and the posted request has no `strategy`.

- [ ] **Step 3: Extend the protocol and the worker**

In `worker-protocol.ts`, add to `OpenRequest`:

```ts
/**
 * `range` reads pages on demand through the HTTP range VFS. `whole` fetches the file once, inflates a
 * `.gz` URL, and opens the bytes in memory; it suits a file small enough to download in one request.
 */
strategy: "range" | "whole"
```

In `range-worker.ts`, add a whole-file open beside the range open and route the `open` handler on `request.strategy`:

```ts
async function fetchWhole(url: string): Promise<Uint8Array> {
	const response = await fetch(url)

	if (!response.ok || !response.body) throw new Error(`${url} returned HTTP ${response.status}`)

	const body = url.endsWith(".gz") ? response.body.pipeThrough(new DecompressionStream("gzip")) : response.body

	return new Uint8Array(await new Response(body).arrayBuffer())
}

function openInMemory(sqlite3: Sqlite3Static, bytes: Uint8Array): Database {
	const db = new sqlite3.oo1.DB(":memory:", "c")
	const pointer = sqlite3.wasm.alloc(bytes.byteLength)

	sqlite3.wasm.heap8u().set(bytes, pointer)

	const rc = sqlite3.capi.sqlite3_deserialize(
		db.pointer!,
		"main",
		pointer,
		bytes.byteLength,
		bytes.byteLength,
		sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_READONLY
	)

	if (rc !== sqlite3.capi.SQLITE_OK) {
		sqlite3.wasm.dealloc(pointer)
		db.close()
		throw new Error(`sqlite3_deserialize failed: ${sqlite3.capi.sqlite3_js_rc_str(rc)}`)
	}

	return db
}
```

For `strategy === "whole"`: `const bytes = await fetchWhole(request.databaseURL)`, then `database = openInMemory(sqlite3, bytes)`, and record the stats as one request of `bytes.byteLength` so `stats` reports the decompressed size. `SQLITE_DESERIALIZE_READONLY` replaces the resizeable flag the main-thread loader uses, because the search index is never written. Check the exact flag and `sqlite3_js_rc_str` names against the installed `@sqlite.org/sqlite-wasm` types.

In `database.ts`, add `strategy: "range"` to the request `openRangeDatabase` posts, extract the `base` URL computation into one private function, and add:

```ts
/**
 * Opens the SQLite database at `databaseURL` by fetching the whole file into memory.
 *
 * A URL ending in `.gz` is inflated in the worker. Use this for a file small enough to download in one
 * request, such as the docs search index; `openRangeDatabase` suits a file read in pieces.
 */
export async function openWholeDatabase(databaseURL: string, runtimeBaseURL: string): Promise<RangeDatabase> {
	const base = runtimeBase(runtimeBaseURL)
	const client = new RangeWorkerClient(new URL(RANGE_WORKER_FILE, base).href)

	try {
		await client.call({
			type: "open",
			strategy: "whole",
			databaseURL: new URL(databaseURL, globalThis.location.href).href,
			runtimeModuleURL: new URL(SQLITE_RUNTIME_MODULE_FILE, base).href,
			chunkSize: 0,
		})

		return client
	} catch (error) {
		client.terminate()
		throw error
	}
}
```

- [ ] **Step 4: Run the test and the package's existing tests**

Run: `yarn vitest run packages/resolver-wof-wasm/lib/httpvfs`
Expected: PASS, including the existing `resolver.test.ts`, `street.test.ts` and `candidate-parity.test.ts`.

- [ ] **Step 5: Compile and commit**

Run: `yarn tsc -b packages/resolver-wof-wasm`
Expected: zero errors, and `packages/resolver-wof-wasm/out/httpvfs/range-worker.js` is rewritten; the docs plugin stages this file.

```bash
git add packages/resolver-wof-wasm/lib/httpvfs/worker-protocol.ts packages/resolver-wof-wasm/lib/httpvfs/range-worker.ts packages/resolver-wof-wasm/lib/httpvfs/database.ts packages/resolver-wof-wasm/lib/httpvfs/database.test.ts
git commit -m "Open a remote SQLite file whole in the range worker, inflating a gzip URL" -- packages/resolver-wof-wasm/lib/httpvfs
```

---

### Task 2: Record extraction and the index writer

**Files:**

- Create: `packages/react/lib/search/types.ts`
- Create: `docs/src/search/constants.ts`, `docs/src/search/fixtures.ts`
- Create: `docs/plugins/search-index/extract.ts`, `extract.test.ts`, `schema.ts`, `write-index.ts`, `write-index.test.ts`, `plugin.ts`
- Modify: `docs/docusaurus.config.ts` (the `plugins` array at line 130)
- Modify: `docs/package.json` (add `htmlparser2`, `domutils`, `domhandler` at the versions `packages/core/package.json` declares)
- Modify: `packages/react/package.json` (export `./search/types`; the `workspace-exports` fix adds it)

**Interfaces:**

- Produces from `@mailwoman/react/search/types`: `SearchRecord { id; url; anchor; hierarchy: (string | null)[]; content; level; position }`, `SearchHit`, `SearchResponse`, `HIERARCHY_DEPTH = 7`.
- Produces from `constants.ts`: `SEARCH_INDEX_FILENAME = "search-index.db.gz"`, `SEARCH_INDEX_PATH = "/search-index.db.gz"`, `SQLITE_RUNTIME_PATH = "/mailwoman/sqlite/"`.
- Produces from `extract.ts`: `extractRecords(html: string, url: string): SearchRecord[]`.
- Produces from `schema.ts`: `SCHEMA_SQL: string`, `FILL_SQL: string`.
- Produces from `write-index.ts`: `insertRecords(db: DatabaseSync, records: readonly SearchRecord[], build: BuildStamp): void`, `writeSearchIndex(records: readonly SearchRecord[], output: PathBuilderLike, build: BuildStamp): Promise<{ bytes: number; gzipBytes: number }>`, `interface BuildStamp { commit: string; builtAt: string }`.
- Produces from `fixtures.ts`: `FIXTURE_RECORDS: SearchRecord[]`.

- [ ] **Step 1: Write the types and constants**

`packages/react/lib/search/types.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The record the docs build indexes and the response the search modal renders. The modal and the
 *   query code share these through `import type`.
 */

/**
 * The number of hierarchy entries: the sidebar category, then `h1` through `h6`.
 */
export const HIERARCHY_DEPTH = 7

export interface SearchRecord {
	/** The first 32 hex characters of `sha256(url + "#" + anchor + "\n" + position)`. */
	id: string
	/** Site-relative path without the anchor, such as `/docs/developers/reference/cli`. */
	url: string
	/** The heading id the record links to; the empty string for the top of the page. */
	anchor: string
	/** Seven entries, `lvl0` through `lvl6`; `null` below the record's own level. */
	hierarchy: (string | null)[]
	/** Aggregated text under the heading; the empty string for a heading without body text. */
	content: string
	/** Depth of the deepest non-null hierarchy entry, 0 through 6. */
	level: number
	/** Zero-based order of the record on its page. */
	position: number
}

export interface SearchHit {
	url: string
	anchor: string
	hierarchy: (string | null)[]
	/** At most 160 characters of content around the first match. */
	snippet: string
	/** Character ranges within `snippet` that matched a query token. */
	highlights: [start: number, end: number][]
}

export interface SearchResponse {
	query: string
	/** The text actually searched when a token was corrected against the vocabulary. */
	corrected?: string
	hits: SearchHit[]
}
```

`docs/src/search/constants.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

export const SEARCH_INDEX_FILENAME = "search-index.db.gz"
export const SEARCH_INDEX_PATH = `/${SEARCH_INDEX_FILENAME}`
/**
 * Where the `runtime-assets` plugin stages the sqlite-wasm worker and runtime.
 */
export const SQLITE_RUNTIME_PATH = "/mailwoman/sqlite/"
```

- [ ] **Step 2: Write the failing extraction test**

`docs/plugins/search-index/extract.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { extractRecords } from "./extract.ts"

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

	test("counts a list item's paragraph text once", () => {
		const records = extractRecords(page(`<h1>A</h1><ul><li><p>Once.</p></li></ul>`), "/docs/a")

		expect(records[0]?.content).toBe("Once.")
	})

	test("gives distinct ids to headings that share an id or have none", () => {
		const records = extractRecords(page(`<h1>A</h1><h2 id="x">B</h2><h2 id="x">C</h2><h2>D</h2>`), "/docs/a")

		expect(new Set(records.map((record) => record.id)).size).toBe(records.length)
	})

	test("gives the same id to the same heading across builds", () => {
		const first = extractRecords(page(`<h1>A</h1><p>one</p>`), "/docs/a")
		const changed = extractRecords(page(`<h1>A</h1><p>two</p>`), "/docs/a")

		expect(changed[0]?.id).toBe(first[0]?.id)
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

- [ ] **Step 3: Run the test and confirm it fails**

Run: `yarn vitest run docs/plugins/search-index/extract.test.ts`
Expected: FAIL. `./extract.ts` does not exist.

- [ ] **Step 4: Implement the extractor**

Add the three HTML dependencies to `docs/package.json` and run `yarn install`.

`docs/plugins/search-index/extract.ts`:

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

import { HIERARCHY_DEPTH, type SearchRecord } from "@mailwoman/react/search/types"
import type { Document, Element } from "domhandler"
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

function category(document: Document): string {
	const active = findAll(
		(element) =>
			(hasClass(element, "menu__link--sublist") && hasClass(element, "menu__link--active")) ||
			hasClass(element, "navbar__link--active"),
		document.children
	)
	const last = active.at(-1)

	return (last && cleanText(last)) || DEFAULT_CATEGORY
}

function isNoIndex(document: Document): boolean {
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

	return drafts.map((draft, position) => ({
		id: sha256(`${url}#${draft.anchor}\n${position}`).slice(0, 32),
		url,
		anchor: draft.anchor,
		hierarchy: draft.hierarchy,
		content: draft.parts.join(" "),
		level: draft.level,
		position,
	}))
}
```

The `mailwoman/prefer-home` lint may direct the HTML parsing to `@mailwoman/core/html`; read `packages/core/lib/html/document.ts` and use its reader where it offers the same traversal.

- [ ] **Step 5: Run the test and confirm it passes**

Run: `yarn vitest run docs/plugins/search-index/extract.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Write the fixtures and the failing writer test**

`docs/src/search/fixtures.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Records the search tests share. Two share a URL so the collapse to one hit per page is observable,
 *   and one is a level-5 table row.
 */

import type { SearchRecord } from "@mailwoman/react/search/types"

const N = null

export const FIXTURE_RECORDS: SearchRecord[] = [
	{
		id: "viterbi-top",
		url: "/docs/kb/decoding-and-viterbi",
		anchor: "",
		hierarchy: ["Address intelligence", "Decoding and Viterbi", N, N, N, N, N],
		content: "The decoder reads a grammar.",
		level: 1,
		position: 0,
	},
	{
		id: "viterbi-section",
		url: "/docs/kb/decoding-and-viterbi",
		anchor: "objective",
		hierarchy: ["Address intelligence", "Decoding and Viterbi", "The objective", N, N, N, N],
		content: "The viterbi objective is a sum of span scores over the decoder grammar.",
		level: 2,
		position: 1,
	},
	{
		id: "tiers",
		url: "/docs/reference/locales-and-tiers",
		anchor: "",
		hierarchy: ["Reference", "Locales and tiers", N, N, N, N, N],
		content: "Tier-1 locales ship with a regression bar.",
		level: 1,
		position: 0,
	},
	{
		id: "parsers",
		url: "/docs/how-to/validate",
		anchor: "",
		hierarchy: ["How-to guides", "Validate addresses", N, N, N, N, N],
		content: "Two parsers disagree on a flat number.",
		level: 1,
		position: 0,
	},
	{
		id: "row",
		url: "/docs/reference/coverage",
		anchor: "rows",
		hierarchy: ["Reference", "Coverage", "Rows", N, N, "Norway", N],
		content: "Elected",
		level: 5,
		position: 3,
	},
]
```

`docs/plugins/search-index/write-index.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { DatabaseSync } from "node:sqlite"
import { gunzipSync } from "node:zlib"

import { readLocalFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { resolvePath } from "path-ts"
import { describe, expect, test } from "vitest"

import { SEARCH_INDEX_FILENAME } from "../../src/search/constants.ts"
import { FIXTURE_RECORDS } from "../../src/search/fixtures.ts"
import { writeSearchIndex } from "./write-index.ts"

const STAMP = { commit: "abc1234", builtAt: "2026-10-03T00:00:00Z" }

describe("writeSearchIndex", () => {
	test("writes a gzip SQLite file with the records, the vocabulary and the build row", async () => {
		await using scratch = await temporaryDirectory("search-index-")
		const output = resolvePath(scratch.path, SEARCH_INDEX_FILENAME)
		const report = await writeSearchIndex(FIXTURE_RECORDS, output, STAMP)
		const bytes = gunzipSync(await readLocalFile(output))
		const plainPath = resolvePath(scratch.path, "plain.db")

		expect(report.gzipBytes).toBeLessThan(report.bytes)
		expect(bytes.byteLength).toBe(report.bytes)

		await writeLocalFile(bytes, plainPath)

		const db = new DatabaseSync(plainPath, { readOnly: true })

		expect(db.prepare("SELECT count(*) AS n FROM records").get()).toEqual({ n: FIXTURE_RECORDS.length })
		expect(db.prepare(`SELECT count(*) AS n FROM records_fts WHERE records_fts MATCH '"viterbi"'`).get()).toEqual({
			n: 2,
		})
		expect(db.prepare("SELECT documents FROM terms WHERE term = 'viterbi'").get()).toEqual({ documents: 2 })
		expect(db.prepare(`SELECT count(*) AS n FROM terms_trigram WHERE terms_trigram MATCH '"ter"'`).get()).toEqual({
			n: 1,
		})
		expect(db.prepare("SELECT commit_sha, records FROM build").get()).toEqual({
			commit_sha: "abc1234",
			records: FIXTURE_RECORDS.length,
		})
		db.close()
	})

	test("throws on a duplicate record id", async () => {
		await using scratch = await temporaryDirectory("search-index-")
		const twice = [FIXTURE_RECORDS[0]!, FIXTURE_RECORDS[0]!]

		await expect(writeSearchIndex(twice, resolvePath(scratch.path, SEARCH_INDEX_FILENAME), STAMP)).rejects.toThrow(
			/duplicate record id/
		)
	})

	test("throws on zero records", async () => {
		await using scratch = await temporaryDirectory("search-index-")

		await expect(writeSearchIndex([], resolvePath(scratch.path, SEARCH_INDEX_FILENAME), STAMP)).rejects.toThrow(
			/zero records/
		)
	})
})
```

Check the names of the binary reader and writer in `@mailwoman/core/fs/readers` and `@mailwoman/core/fs/writers` before use. The `"ter"` trigram count is 1 because `viterbi` is the only vocabulary term containing it; `terms` holds the stemmed form of every indexed word of at least three characters, so `decoder` is stored as `decod`.

- [ ] **Step 7: Run the test and confirm it fails**

Run: `yarn vitest run docs/plugins/search-index/write-index.test.ts`
Expected: FAIL. `./write-index.ts` does not exist.

- [ ] **Step 8: Implement the schema and the writer**

`docs/plugins/search-index/schema.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The search index schema. The FTS5 virtual tables are external-content tables over `records` and
 *   `terms`, so the text is stored once. `porter unicode61` folds plurals; `trigram` over the vocabulary
 *   supports typo correction against indexed terms rather than against page content.
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
```

`docs/plugins/search-index/write-index.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Writes the search records to a gzip-compressed SQLite file. The whole file is republished with every
 *   site deploy, so the writer builds from scratch in a temporary file and compresses the result.
 */

import { DatabaseSync } from "node:sqlite"
import { gzipSync } from "node:zlib"

import { readLocalFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import type { SearchRecord } from "@mailwoman/react/search/types"
import { type PathBuilderLike, resolvePath } from "path-ts"

import { FILL_SQL, SCHEMA_SQL } from "./schema.ts"

/**
 * The index is read whole into memory in the browser, so the page size is tuned for in-memory b-tree
 * depth rather than for range requests.
 */
const PAGE_SIZE = 4096

export interface BuildStamp {
	commit: string
	builtAt: string
}

export function headingsText(record: Pick<SearchRecord, "hierarchy">): string {
	return record.hierarchy.filter((entry): entry is string => entry !== null).join("\n")
}

/**
 * Inserts the rows into a database that already holds the schema. Shared with the test fixtures.
 */
export function insertRecords(db: DatabaseSync, records: readonly SearchRecord[], build: BuildStamp): void {
	const insert = db.prepare("INSERT INTO records VALUES (?, ?, ?, ?, ?, ?, ?, ?)")

	db.exec("BEGIN")

	for (const record of records) {
		insert.run(
			record.id,
			record.url,
			record.anchor,
			stringifyJSON(record.hierarchy),
			headingsText(record),
			record.content,
			record.level,
			record.position
		)
	}

	db.prepare("INSERT INTO build VALUES (?, ?, ?)").run(build.commit, build.builtAt, records.length)
	db.exec("COMMIT")
}

export async function writeSearchIndex(
	records: readonly SearchRecord[],
	output: PathBuilderLike,
	build: BuildStamp
): Promise<{ bytes: number; gzipBytes: number }> {
	if (records.length === 0) throw new Error("search-index: the build produced zero records")

	const seen = new Map<string, string>()

	for (const record of records) {
		const earlier = seen.get(record.id)

		if (earlier) throw new Error(`search-index: duplicate record id ${record.id} on ${record.url} and ${earlier}`)

		seen.set(record.id, record.url)
	}

	await using scratch = await temporaryDirectory("search-index-")
	const plain = resolvePath(scratch.path, "search-index.db")
	const db = new DatabaseSync(plain)

	try {
		db.exec(`PRAGMA page_size = ${PAGE_SIZE};`)
		db.exec(SCHEMA_SQL)
		insertRecords(db, records, build)
		db.exec(FILL_SQL)
		db.exec("VACUUM")
	} finally {
		db.close()
	}

	const bytes = await readLocalFile(plain)
	const compressed = gzipSync(bytes, { level: 9 })

	await writeLocalFile(compressed, output)

	return { bytes: bytes.byteLength, gzipBytes: compressed.byteLength }
}
```

`packages/sqlite/AGENTS.md` says whether the repository wraps `node:sqlite`'s `DatabaseSync`; use that wrapper if it exists and accepts raw `exec`.

- [ ] **Step 9: Run the tests and confirm they pass**

Run: `yarn vitest run docs/plugins/search-index`
Expected: PASS, 11 tests.

- [ ] **Step 10: Write the plugin and register it**

`docs/plugins/search-index/plugin.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Writes the search index into the built site: one record per heading-scoped section and per
 *   reference-table row of every built page, in a gzip-compressed SQLite file the browser opens whole.
 */

import type { LoadContext, Plugin } from "@docusaurus/types"
import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import type { SearchRecord } from "@mailwoman/react/search/types"
import { resolvePath } from "path-ts"

import { SEARCH_INDEX_FILENAME } from "../../src/search/constants.ts"
import { extractRecords } from "./extract.ts"
import { writeSearchIndex } from "./write-index.ts"

export default function searchIndexPlugin(context: LoadContext): Plugin {
	return {
		name: "search-index",

		async postBuild({ outDir, routesPaths }) {
			const records: SearchRecord[] = []
			let pages = 0

			for (const route of routesPaths) {
				if (route === "/404.html" || route === "/404") continue

				// `trailingSlash: false` emits `<route>.html`, and the root route `index.html`.
				const file = resolvePath(outDir, route === "/" ? "index.html" : `${route.replace(/^\//, "")}.html`)

				records.push(...extractRecords(await readLocalTextFile(file), route))
				pages++
			}

			const report = await writeSearchIndex(records, resolvePath(outDir, SEARCH_INDEX_FILENAME), {
				commit: String(context.siteConfig.customFields?.buildCommit ?? ""),
				builtAt: new Date().toISOString(),
			})

			console.log(
				`search-index: ${records.length} records from ${pages} pages, ${ByteFormatter.formatIEC(report.bytes)} raw, ${ByteFormatter.formatIEC(report.gzipBytes)} gzip`
			)
		},
	}
}
```

Redirect routes from `plugin-client-redirects` are emitted as HTML without an `article`, so they yield zero records. A missing file for any other route throws through `readLocalTextFile`, which is the intended behavior.

Add `"./plugins/search-index/plugin.ts",` to the `plugins` array in `docs/docusaurus.config.ts` after `"./plugins/runtime-assets/plugin.ts",`.

- [ ] **Step 11: Build the docs and record the counts**

Run: `yarn workspace @mailwoman/docs build`
Expected: the log line `search-index: N records from M pages, X raw, Y gzip` and the file `docs/build/search-index.db.gz`. The probe build produced 2,173 records from 181 pages, 4.06 MB raw; a count far from that means the route-to-file mapping skipped pages.

- [ ] **Step 12: Commit**

```bash
git add docs/plugins/search-index docs/src/search/constants.ts docs/src/search/fixtures.ts packages/react/lib/search/types.ts docs/docusaurus.config.ts docs/package.json packages/react/package.json yarn.lock
git commit -m "Write a gzip SQLite search index from the docs build (N records from M pages)" -- docs/plugins/search-index docs/src/search packages/react/lib/search/types.ts docs/docusaurus.config.ts docs/package.json packages/react/package.json yarn.lock
```

---

### Task 3: Query library

**Files:**

- Create: `docs/src/search/database.ts`, `database.node.ts`, `lexical.ts`, `lexical.test.ts`, `correct.ts`, `correct.test.ts`, `snippet.ts`, `snippet.test.ts`, `search.ts`, `search.test.ts`

**Interfaces:**

- Consumes: `insertRecords`, `SCHEMA_SQL`, `FILL_SQL`, `FIXTURE_RECORDS` from Task 2; the types.
- Produces from `database.ts`: `interface SearchDatabase { query<Row>(sql: string, parameters?: readonly SQLValue[]): Promise<Row[]> }`, `type SQLValue = string | number | bigint | Uint8Array | null`.
- Produces from `database.node.ts` (tests only; imported by no browser module): `nodeSearchDatabase(db: DatabaseSync): SearchDatabase`, `fixtureDatabase(records: readonly SearchRecord[]): SearchDatabase`.
- Produces from `lexical.ts`: `queryTokens(text: string): string[]`, `quoteTerm(text: string): string`, `matchExpression(tokens: readonly string[]): string | undefined`, `lexicalRows(db: SearchDatabase, tokens: readonly string[]): Promise<SearchRecord[]>`, `LEXICAL_ROWS = 40`.
- Produces from `correct.ts`: `correctTokens(db: SearchDatabase, tokens: readonly string[]): Promise<string[] | undefined>` (undefined when no token changed), `damerauLevenshtein(a: string, b: string): number`.
- Produces from `snippet.ts`: `snippet(content: string, tokens: readonly string[]): { snippet: string; highlights: [number, number][] }`, `SNIPPET_LENGTH = 160`.
- Produces from `search.ts`: `search(db: SearchDatabase, text: string, limit?: number): Promise<SearchResponse>`, `DEFAULT_LIMIT = 8`, `MAX_LIMIT = 20`.

- [ ] **Step 1: Write the failing lexical test**

`docs/src/search/lexical.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { fixtureDatabase } from "./database.node.ts"
import { FIXTURE_RECORDS } from "./fixtures.ts"
import { lexicalRows, matchExpression, queryTokens } from "./lexical.ts"

const db = fixtureDatabase(FIXTURE_RECORDS)

describe("queryTokens", () => {
	test("keeps tokens that contain a letter or a digit", () => {
		expect(queryTokens('  tier-1  "regression" -- *** ')).toEqual(["tier-1", '"regression"'])
	})
})

describe("matchExpression", () => {
	test("quotes every token and marks the last one as a prefix", () => {
		expect(matchExpression(["decoder", "gram"])).toBe('"decoder" "gram"*')
	})

	test("doubles a quote character inside a token", () => {
		expect(matchExpression(['say"hi'])).toBe('"say""hi"*')
	})

	test("returns undefined for zero tokens", () => {
		expect(matchExpression([])).toBeUndefined()
	})
})

describe("lexicalRows", () => {
	test("ranks a heading match above a content match", async () => {
		const rows = await lexicalRows(db, ["viterbi"])

		expect(rows.map((row) => row.id)).toEqual(["viterbi-top", "viterbi-section"])
	})

	test("matches the last token as a prefix", async () => {
		expect((await lexicalRows(db, ["decoder", "gram"])).map((row) => row.id)).toContain("viterbi-section")
	})

	test("matches a singular query against a plural word", async () => {
		expect((await lexicalRows(db, ["parser"])).map((row) => row.id)).toEqual(["parsers"])
	})

	test("returns an empty list for zero tokens", async () => {
		expect(await lexicalRows(db, [])).toEqual([])
	})

	test.each(['"', "a AND", "NEAR(a b)", "col:value", "a* OR", "(", "a - b", "^a", "-"])(
		"returns rows or an empty list for the FTS5 syntax %s",
		async (text) => {
			await expect(lexicalRows(db, queryTokens(text))).resolves.toBeInstanceOf(Array)
		}
	)
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `yarn vitest run docs/src/search/lexical.test.ts`
Expected: FAIL. The modules do not exist.

- [ ] **Step 3: Implement `database.ts`, `database.node.ts` and `lexical.ts`**

`docs/src/search/database.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The one interface the query code needs. The browser passes the sqlite-wasm worker's `RangeDatabase`;
 *   the tests pass a `node:sqlite` adapter from `database.node.ts`.
 */

export type SQLValue = string | number | bigint | Uint8Array | null

export interface SearchDatabase {
	query<Row>(sql: string, parameters?: readonly SQLValue[]): Promise<Row[]>
}
```

`docs/src/search/database.node.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Node-side `SearchDatabase` over `node:sqlite`, for the tests. Imported by no browser module.
 */

import { DatabaseSync } from "node:sqlite"

import type { SearchRecord } from "@mailwoman/react/search/types"

import { FILL_SQL, SCHEMA_SQL } from "../../plugins/search-index/schema.ts"
import { insertRecords } from "../../plugins/search-index/write-index.ts"
import type { SearchDatabase, SQLValue } from "./database.ts"

export function nodeSearchDatabase(db: DatabaseSync): SearchDatabase {
	return {
		async query<Row>(sql: string, parameters: readonly SQLValue[] = []): Promise<Row[]> {
			return db.prepare(sql).all(...parameters) as Row[]
		},
	}
}

export function fixtureDatabase(records: readonly SearchRecord[]): SearchDatabase {
	const db = new DatabaseSync(":memory:")

	db.exec(SCHEMA_SQL)
	insertRecords(db, records, { commit: "fixture", builtAt: "2026-10-03T00:00:00Z" })
	db.exec(FILL_SQL)

	return nodeSearchDatabase(db)
}
```

`docs/src/search/lexical.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The lexical query. Every token of the user's text becomes a quoted FTS5 string, so the text never
 *   reaches the FTS5 parser as an operator, a column filter or a bare `*`.
 */

import type { SearchRecord } from "@mailwoman/react/search/types"

import type { SearchDatabase } from "./database.ts"

export const LEXICAL_ROWS = 40

/**
 * `bm25` column weights: a match in the heading path counts ten times a match in the content.
 */
const HEADINGS_WEIGHT = 10
const CONTENT_WEIGHT = 1

interface RecordRow {
	id: string
	url: string
	anchor: string
	hierarchy: string
	content: string
	level: number
	position: number
}

const SQL = `SELECT r.id, r.url, r.anchor, r.hierarchy, r.content, r.level, r.position
 FROM records_fts JOIN records r ON r.rowid = records_fts.rowid
 WHERE records_fts MATCH ?
 ORDER BY bm25(records_fts, ${HEADINGS_WEIGHT}, ${CONTENT_WEIGHT}), r.level, r.position
 LIMIT ${LEXICAL_ROWS}`

export function quoteTerm(text: string): string {
	return `"${text.replaceAll('"', '""')}"`
}

/**
 * The whitespace-separated parts of the text that the tokenizer can index: those with a letter or a digit.
 */
export function queryTokens(text: string): string[] {
	return text.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token))
}

export function matchExpression(tokens: readonly string[]): string | undefined {
	if (tokens.length === 0) return undefined

	return tokens
		.map((token, index) => (index === tokens.length - 1 ? `${quoteTerm(token)}*` : quoteTerm(token)))
		.join(" ")
}

export async function lexicalRows(db: SearchDatabase, tokens: readonly string[]): Promise<SearchRecord[]> {
	const expression = matchExpression(tokens)

	if (!expression) return []

	const rows = await db.query<RecordRow>(SQL, [expression])

	return rows.map((row) => ({ ...row, hierarchy: JSON.parse(row.hierarchy) as (string | null)[] }))
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `yarn vitest run docs/src/search/lexical.test.ts`
Expected: PASS, 17 tests. The error message of a failing syntax case contains the token that reached the parser unquoted; fix `queryTokens` or `quoteTerm` and leave the case list as it is.

- [ ] **Step 5: Write the failing correction test**

`docs/src/search/correct.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { correctTokens, damerauLevenshtein } from "./correct.ts"
import { fixtureDatabase } from "./database.node.ts"
import { FIXTURE_RECORDS } from "./fixtures.ts"

const db = fixtureDatabase(FIXTURE_RECORDS)

describe("damerauLevenshtein", () => {
	test.each([
		["viterbi", "viterbi", 0],
		["vitrebi", "viterbi", 1],
		["vitebi", "viterbi", 1],
		["decodr", "decod", 1],
		["grammer", "grammar", 1],
		["abc", "xyz", 3],
	])("%s to %s is %i", (a, b, distance) => {
		expect(damerauLevenshtein(a, b)).toBe(distance)
	})
})

describe("correctTokens", () => {
	test("replaces a transposed token with the vocabulary term", async () => {
		expect(await correctTokens(db, ["vitrebi"])).toEqual(["viterbi"])
	})

	test("corrects only the tokens that need it", async () => {
		// The vocabulary holds stemmed terms, so `grammer` corrects to `grammar` and `viterbi` stays.
		expect(await correctTokens(db, ["viterbi", "grammer"])).toEqual(["viterbi", "grammar"])
	})

	test("accepts one edit only for a token under six characters", async () => {
		// `tier` is in the vocabulary. `tr` is two edits away and stays as typed; `teir` is one.
		expect(await correctTokens(db, ["tr"])).toBeUndefined()
		expect(await correctTokens(db, ["teir"])).toEqual(["tier"])
	})

	test("returns undefined when no token has a close term", async () => {
		expect(await correctTokens(db, ["zzzzzzz"])).toBeUndefined()
	})

	test("leaves a token under three characters as typed", async () => {
		expect(await correctTokens(db, ["ab"])).toBeUndefined()
	})
})
```

Confirm the stemmed vocabulary against the fixture database with `SELECT term FROM terms` before trusting the expectations above; adjust an expected term to what the porter tokenizer stores, and keep the behavior: a corrected token is a vocabulary term, and the primary query stems it again.

- [ ] **Step 6: Run the test and confirm it fails**

Run: `yarn vitest run docs/src/search/correct.test.ts`
Expected: FAIL. `./correct.ts` does not exist.

- [ ] **Step 7: Implement `correct.ts`**

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Typo correction against the index vocabulary. The trigram table over `terms` proposes candidates
 *   that share character windows with the token; the edit distance decides whether one is close enough.
 */

import type { SearchDatabase } from "./database.ts"
import { quoteTerm } from "./lexical.ts"

const MIN_TOKEN = 3
const CANDIDATES = 10
const SHORT_TOKEN = 6
const MAX_EDITS = 2
const MAX_EDITS_SHORT = 1
const TRIGRAM = 3

const CANDIDATE_SQL = `SELECT t.term FROM terms_trigram JOIN terms t ON t.rowid = terms_trigram.rowid
 WHERE terms_trigram MATCH ? ORDER BY bm25(terms_trigram), t.documents DESC LIMIT ${CANDIDATES}`

/**
 * Edit distance counting insertions, deletions, substitutions and adjacent transpositions as one edit each.
 */
export function damerauLevenshtein(a: string, b: string): number {
	const rows = a.length + 1
	const cols = b.length + 1
	const d: number[][] = Array.from({ length: rows }, (_, i) =>
		Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
	)

	for (let i = 1; i < rows; i++) {
		for (let j = 1; j < cols; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1

			d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost)

			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1)
			}
		}
	}

	return d[rows - 1]![cols - 1]!
}

function trigramExpression(token: string): string | undefined {
	const windows = new Set<string>()
	const characters = [...token.toLowerCase()]

	for (let start = 0; start + TRIGRAM <= characters.length; start++) {
		windows.add(characters.slice(start, start + TRIGRAM).join(""))
	}

	return windows.size === 0 ? undefined : [...windows].map(quoteTerm).join(" OR ")
}

async function correctToken(db: SearchDatabase, token: string): Promise<string | undefined> {
	if (token.length < MIN_TOKEN) return undefined

	const expression = trigramExpression(token)

	if (!expression) return undefined

	const candidates = await db.query<{ term: string }>(CANDIDATE_SQL, [expression])
	const lower = token.toLowerCase()
	const allowed = token.length < SHORT_TOKEN ? MAX_EDITS_SHORT : MAX_EDITS
	let best: { term: string; distance: number } | undefined

	for (const { term } of candidates) {
		const distance = damerauLevenshtein(lower, term)

		if (distance === 0) return undefined

		if (distance <= allowed && (!best || distance < best.distance)) best = { term, distance }
	}

	return best?.term
}

/**
 * The tokens with each correctable token replaced by its nearest vocabulary term, or `undefined` when
 * no token changed.
 */
export async function correctTokens(db: SearchDatabase, tokens: readonly string[]): Promise<string[] | undefined> {
	const corrected = await Promise.all(tokens.map(async (token) => (await correctToken(db, token)) ?? token))

	return corrected.some((token, index) => token !== tokens[index]) ? corrected : undefined
}
```

- [ ] **Step 8: Run the test and confirm it passes**

Run: `yarn vitest run docs/src/search/correct.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 9: Write the failing snippet test, then implement**

`docs/src/search/snippet.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { snippet, SNIPPET_LENGTH } from "./snippet.ts"

describe("snippet", () => {
	test("returns short content whole with the range of each token match", () => {
		expect(snippet("The decoder reads a Decoder grammar.", ["decoder"])).toEqual({
			snippet: "The decoder reads a Decoder grammar.",
			highlights: [
				[4, 11],
				[20, 27],
			],
		})
	})

	test("windows long content around the first match and stays within the length", () => {
		const content = `${"lorem ".repeat(100)}needle ${"ipsum ".repeat(100)}`
		const result = snippet(content, ["needle"])
		const [start, end] = result.highlights[0]!

		expect(result.snippet.length).toBeLessThanOrEqual(SNIPPET_LENGTH)
		expect(result.snippet.slice(start, end)).toBe("needle")
	})

	test("returns the start of the content when no token occurs in it", () => {
		expect(snippet("a".repeat(500), ["zzz"])).toEqual({ snippet: "a".repeat(SNIPPET_LENGTH), highlights: [] })
	})

	test("returns an empty snippet for empty content", () => {
		expect(snippet("", ["x"])).toEqual({ snippet: "", highlights: [] })
	})

	test("ignores tokens that are empty after trimming punctuation", () => {
		expect(snippet("plain text", ['""']).highlights).toEqual([])
	})
})
```

Run: `yarn vitest run docs/src/search/snippet.test.ts`
Expected: FAIL. `./snippet.ts` does not exist.

`docs/src/search/snippet.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The excerpt a hit displays, with the character ranges that matched a query token. Matching here is
 *   a case-insensitive substring search; it marks what to emphasize and takes no part in ranking.
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

Run: `yarn vitest run docs/src/search/snippet.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 10: Write the failing search test**

`docs/src/search/search.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { fixtureDatabase } from "./database.node.ts"
import type { SearchDatabase, SQLValue } from "./database.ts"
import { FIXTURE_RECORDS } from "./fixtures.ts"
import { search } from "./search.ts"

const db = fixtureDatabase(FIXTURE_RECORDS)

describe("search", () => {
	test("returns one hit per url with a snippet and highlights", async () => {
		const response = await search(db, "viterbi")

		expect(response.hits.filter((hit) => hit.url === "/docs/kb/decoding-and-viterbi")).toHaveLength(1)
		expect(response.hits[0]?.hierarchy[1]).toBe("Decoding and Viterbi")
		expect(response.corrected).toBeUndefined()
	})

	test("corrects a misspelled token and reports the corrected text", async () => {
		const response = await search(db, "vitrebi")

		expect(response.corrected).toBe("viterbi")
		expect(response.hits[0]?.url).toBe("/docs/kb/decoding-and-viterbi")
	})

	test("returns zero hits for text without a letter or digit, and runs no query", async () => {
		let queries = 0
		const counting: SearchDatabase = {
			query<Row>(sql: string, parameters?: readonly SQLValue[]) {
				queries++

				return db.query<Row>(sql, parameters)
			},
		}

		expect((await search(counting, "-- ***")).hits).toEqual([])
		expect(queries).toBe(0)
	})

	test("honors the limit", async () => {
		expect((await search(db, "the", 1)).hits).toHaveLength(1)
	})

	test("returns zero hits when nothing matches and no correction is close", async () => {
		expect(await search(db, "zzzzzzz")).toEqual({ query: "zzzzzzz", hits: [] })
	})
})
```

Run: `yarn vitest run docs/src/search/search.test.ts`
Expected: FAIL. `./search.ts` does not exist.

- [ ] **Step 11: Implement `search.ts`**

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   One query: the lexical rows, a vocabulary correction when they are empty, then the first record of
 *   each page with its snippet. A second ranked list, such as a vector arm, would merge here.
 */

import type { SearchRecord, SearchResponse } from "@mailwoman/react/search/types"

import { correctTokens } from "./correct.ts"
import type { SearchDatabase } from "./database.ts"
import { lexicalRows, queryTokens } from "./lexical.ts"
import { snippet } from "./snippet.ts"

export const DEFAULT_LIMIT = 8
export const MAX_LIMIT = 20

function collapseByURL(ranked: readonly SearchRecord[], limit: number): SearchRecord[] {
	const seen = new Set<string>()
	const kept: SearchRecord[] = []

	for (const record of ranked) {
		if (seen.has(record.url)) continue

		seen.add(record.url)
		kept.push(record)

		if (kept.length === limit) break
	}

	return kept
}

export async function search(db: SearchDatabase, text: string, limit = DEFAULT_LIMIT): Promise<SearchResponse> {
	const bounded = Math.min(Math.max(1, Math.trunc(limit)), MAX_LIMIT)
	let tokens = queryTokens(text)

	if (tokens.length === 0) return { query: text, hits: [] }

	let rows = await lexicalRows(db, tokens)
	let corrected: string | undefined

	if (rows.length === 0) {
		const replacement = await correctTokens(db, tokens)

		if (replacement) {
			tokens = replacement
			corrected = replacement.join(" ")
			rows = await lexicalRows(db, tokens)
		}
	}

	const response: SearchResponse = {
		query: text,
		hits: collapseByURL(rows, bounded).map((record) => ({
			url: record.url,
			anchor: record.anchor,
			hierarchy: record.hierarchy,
			...snippet(record.content, tokens),
		})),
	}

	if (corrected !== undefined && response.hits.length > 0) response.corrected = corrected

	return response
}
```

- [ ] **Step 12: Run the whole query suite and commit**

Run: `yarn vitest run docs/src/search docs/plugins/search-index`
Expected: PASS for every file.

```bash
git add docs/src/search
git commit -m "Query the search index: quoted FTS5 tokens, vocabulary typo correction, one hit per page" -- docs/src/search
```

---

### Task 4: Acceptance against the real build

**Files:**

- Create: `docs/src/search/search.integration.test.ts`

**Interfaces:**

- Consumes: `search`, `extractRecords`, `insertRecords`, `SCHEMA_SQL`, `FILL_SQL`, `nodeSearchDatabase`; `docs/build` from Task 2 Step 11.

- [ ] **Step 1: Write the test**

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The spec's acceptance list against an index built from the real `docs/build`. The test throws when
 *   the build directory is absent rather than passing on an empty index.
 */

import { DatabaseSync } from "node:sqlite"

import { pathExists, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { relativePath, resolvePath } from "path-ts"
import { beforeAll, describe, expect, test } from "vitest"

import { extractRecords } from "../../plugins/search-index/extract.ts"
import { FILL_SQL, SCHEMA_SQL } from "../../plugins/search-index/schema.ts"
import { insertRecords } from "../../plugins/search-index/write-index.ts"
import { nodeSearchDatabase } from "./database.node.ts"
import type { SearchDatabase } from "./database.ts"
import { search } from "./search.ts"

const BUILD_DIR = resolvePath(import.meta.dirname, "../../build")
const WITHIN = 3

const ACCEPTANCE: [query: string, url: string][] = [
	["locales and tiers", "/docs/developers/reference/locales-and-tiers"],
	["viterbi", "/docs/developers/knowledge-base/address-intelligence/decoding-and-viterbi"],
	["validate addresses", "/docs/developers/how-to/validate-addresses"],
	["mcp server", "/docs/developers/how-to/use-the-mcp-server"],
	["parse in the browser", "/docs/developers/tutorials/parse-in-the-browser"],
	["vitrebi", "/docs/developers/knowledge-base/address-intelligence/decoding-and-viterbi"],
]

let db: SearchDatabase

beforeAll(async () => {
	if (!(await pathExists(BUILD_DIR)))
		throw new Error(`${BUILD_DIR} is absent; run yarn workspace @mailwoman/docs build first`)

	const records = []

	for (const file of await htmlFiles(BUILD_DIR)) {
		const route = `/${relativePath(BUILD_DIR, file)}`.replace(/\/index\.html$/, "").replace(/\.html$/, "")

		if (route === "/404") continue

		records.push(...extractRecords(await readLocalTextFile(file), route === "" ? "/" : route))
	}

	const sqlite = new DatabaseSync(":memory:")

	sqlite.exec(SCHEMA_SQL)
	insertRecords(sqlite, records, { commit: "test", builtAt: "" })
	sqlite.exec(FILL_SQL)
	db = nodeSearchDatabase(sqlite)

	expect(records.length).toBeGreaterThan(1000)
}, 120_000)

describe("the acceptance list", () => {
	test.each(ACCEPTANCE)(`returns the page for "%s" within the first ${WITHIN} hits`, async (query, url) => {
		const response = await search(db, query, WITHIN)

		expect(response.hits.map((hit) => hit.url)).toContain(url)
	})
})
```

`htmlFiles` is the recursive `.html` lister; `@mailwoman/core/fs/readers` exports a directory walker, and `mwdev_symbol` with `describes: "list files recursively by extension"` finds its name. Use it instead of a local walker.

- [ ] **Step 2: Run it against the build from Task 2**

Run: `yarn vitest run docs/src/search/search.integration.test.ts`
Expected: PASS, 6 tests. For a failing row, print the first eight hits with their hierarchy before changing anything, and name which stage ranks the expected page low: the `bm25` order with the 10:1 column weights, the correction, or the collapse. Change the weights in `lexical.ts` only when the `bm25` order is the cause, and rerun `lexical.test.ts` afterward. If an expected URL is absent from the build, correct the spec's table and this list to the published URL and say so in the commit message.

- [ ] **Step 3: Commit**

```bash
git add docs/src/search/search.integration.test.ts docs/superpowers/specs/2026-10-02-docs-search-design.md
git commit -m "Run the spec's acceptance queries against an index of the real docs build" -- docs/src/search/search.integration.test.ts docs/superpowers/specs/2026-10-02-docs-search-design.md
```

---

### Task 5: Search modal in `@mailwoman/react`

**Files:**

- Create: `packages/react/lib/search/SearchModal.tsx`, `SearchModal.test.tsx`, `search.css`, `packages/react/lib/search.ts`
- Modify: `packages/react/package.json` (exports for `./search` and `./search/SearchModal`), `packages/react/styles.css` (include `search.css` as the other component styles are included)

**Interfaces:**

- Consumes: `SearchHit`, `SearchResponse` from `./types.ts`.
- Produces: `SearchModal(props: SearchModalProps)`, `interface SearchModalProps { open: boolean; onClose: () => void; onNavigate?: (href: string) => void; search: (q: string, signal: AbortSignal) => Promise<SearchResponse> }`, `hitHref(hit: Pick<SearchHit, "url" | "anchor">): string`.

Read `packages/react/lib/common/CopyButton.tsx`, its test and `packages/react/test/render.tsx` first, and follow their class-name convention. Load the `frontend-design:frontend-design` skill before writing `search.css`, and take every color, radius and spacing value from `packages/react/tokens.css`.

- [ ] **Step 1: Write the failing test**

`packages/react/lib/search/SearchModal.test.tsx`:

```tsx
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { SearchModal } from "@mailwoman/react/search/SearchModal"
import type { SearchResponse } from "@mailwoman/react/search/types"
import { expect, test, vi } from "vitest"
import { userEvent } from "vitest/browser"

import { renderComponent } from "../../test/render.tsx"

function response(query: string, urls: string[], corrected?: string): SearchResponse {
	return {
		query,
		...(corrected ? { corrected } : {}),
		hits: urls.map((url, index) => ({
			url,
			anchor: index === 0 ? "" : "section",
			hierarchy: [index < 2 ? "Reference" : "Guides", `Title ${url}`, null, null, null, null, null],
			snippet: `Snippet for ${url}`,
			highlights: [[0, 7]],
		})),
	}
}

function mount(search: (q: string, signal: AbortSignal) => Promise<SearchResponse>) {
	const onClose = vi.fn()
	const onNavigate = vi.fn()
	const view = renderComponent(<SearchModal open onClose={onClose} onNavigate={onNavigate} search={search} />)
	const dialog = view.container.querySelector("dialog") as HTMLDialogElement
	const input = view.container.querySelector('input[type="search"]') as HTMLInputElement

	return { ...view, dialog, input, onClose, onNavigate }
}

test("opens a modal dialog and focuses a search input that is a combobox", async () => {
	const { dialog, input } = mount(async (q) => response(q, []))

	await vi.waitFor(() => expect(dialog.open).toBe(true))
	expect(dialog.matches(":modal")).toBe(true)
	expect(dialog.hasAttribute("role")).toBe(false)
	expect(document.activeElement).toBe(input)
	expect(input.getAttribute("role")).toBe("combobox")
	expect(input.getAttribute("aria-autocomplete")).toBe("list")
	expect(input.getAttribute("aria-expanded")).toBe("false")
})

test("renders hits as options in labeled groups and selects the first", async () => {
	const { container, input } = mount(async (q) => response(q, ["/a", "/b", "/c"]))

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
	const { container, input, onNavigate, onClose } = mount(async (q) => response(q, ["/a", "/b"]))

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
	const { dialog, onClose } = mount(async (q) => response(q, []))

	await vi.waitFor(() => expect(dialog.open).toBe(true))
	await userEvent.keyboard("{Escape}")
	await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
})

test("keeps the results of the latest query when an earlier response arrives later", async () => {
	const pending = new Map<string, (value: SearchResponse) => void>()
	const { container, input } = mount((q) => new Promise<SearchResponse>((resolve) => pending.set(q, resolve)))

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

test("shows the corrected query, and announces zero hits and a failure in the live region", async () => {
	let fail = false
	const { container, input } = mount(async (q) => {
		if (fail) throw new Error("network")

		return q === "vitrebi" ? response(q, ["/v"], "viterbi") : response(q, [])
	})
	const status = container.querySelector('[aria-live="polite"]') as HTMLElement

	await userEvent.type(input, "vitrebi")
	await vi.waitFor(() => expect(container.textContent).toContain("Showing results for “viterbi”"))

	await userEvent.clear(input)
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

- [ ] **Step 3: Implement the modal**

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
 *   named by `aria-activedescendant`. The component owns no data access: `search` is passed in.
 */

import { type KeyboardEvent, type MouseEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react"

import { useDebouncedValue } from "#common/useDebouncedValue"

import type { SearchHit, SearchResponse } from "./types.ts"

export interface SearchModalProps {
	open: boolean
	onClose: () => void
	/**
	 * Called with the hit's site-relative link on Enter or on an unmodified click. Absent, the link
	 * navigates as an ordinary anchor.
	 */
	onNavigate?: (href: string) => void
	search: (q: string, signal: AbortSignal) => Promise<SearchResponse>
}

type Status = { kind: "idle" } | { kind: "results"; response: SearchResponse } | { kind: "failed" }

const DEBOUNCE_MS = 150
const MAX_QUERY_LENGTH = 200
const DEFAULT_CATEGORY = "Documentation"

/**
 * The site-relative link for a hit.
 */
export function hitHref(hit: Pick<SearchHit, "url" | "anchor">): string {
	return hit.anchor === "" ? hit.url : `${hit.url}#${hit.anchor}`
}

function statusText(status: Status): string {
	if (status.kind === "failed") return "Search is unavailable. Try again in a moment."
	if (status.kind === "idle") return ""

	const { response } = status

	if (response.hits.length === 0) return `No results for “${response.query}”.`

	return response.hits.length === 1 ? "1 result." : `${response.hits.length} results.`
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

export function SearchModal({ open, onClose, onNavigate, search }: SearchModalProps) {
	const dialogRef = useRef<HTMLDialogElement>(null)
	const inputRef = useRef<HTMLInputElement>(null)
	const baseID = useId()
	const listboxID = `${baseID}-listbox`
	const [query, setQuery] = useState("")
	const [status, setStatus] = useState<Status>({ kind: "idle" })
	const [selected, setSelected] = useState(0)
	const debounced = useDebouncedValue(query.trim().slice(0, MAX_QUERY_LENGTH), DEBOUNCE_MS)

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

		search(debounced, controller.signal).then(
			(response) => {
				if (controller.signal.aborted) return

				setStatus({ kind: "results", response })
				setSelected(0)
			},
			() => {
				if (!controller.signal.aborted) setStatus({ kind: "failed" })
			}
		)

		return () => controller.abort()
	}, [debounced, search])

	const response = status.kind === "results" ? status.response : undefined
	const hits = response?.hits ?? []

	const groups = useMemo(() => {
		const byCategory = new Map<string, SearchHit[]>()

		for (const hit of hits) {
			const category = hit.hierarchy[0] ?? DEFAULT_CATEGORY

			byCategory.set(category, [...(byCategory.get(category) ?? []), hit])
		}

		// Options are numbered in display order so the arrow keys follow what the reader sees.
		let order = 0

		return [...byCategory].map(([category, entries]) => ({
			category,
			entries: entries.map((hit) => ({ hit, order: order++ })),
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
					maxLength={MAX_QUERY_LENGTH}
					placeholder="Search the documentation"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					onKeyDown={onKeyDown}
				/>
			</form>

			{response?.corrected !== undefined && (
				<p className="mw-search__corrected">Showing results for “{response.corrected}”</p>
			)}

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

Set padding on `.mw-search__form`, `.mw-search__results` and `.mw-search__status`, and zero padding on the `dialog` element, so a click inside the visible panel never has the dialog as its target. Write `search.css` with rules for `.mw-search` (width `min(40rem, 92vw)`, `max-height: 70vh`, top-aligned with `margin-top: 12vh`), `.mw-search::backdrop`, `.mw-search__input` (full width, at least 44px tall), `.mw-search__results` (scrolls vertically), `.mw-search__category`, `.mw-search__option[aria-selected="true"]` (3:1 contrast against the panel), `.mw-search__link`, `.mw-search__title`, `.mw-search__snippet`, `.mw-search__snippet mark`, `.mw-search__corrected` and `.mw-search__status`. Any open transition sits inside `@media (prefers-reduced-motion: no-preference)`.

`packages/react/lib/search.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The docs search modal and its wire types.
 */

export { hitHref, SearchModal } from "./search/SearchModal.tsx"
export type { SearchModalProps } from "./search/SearchModal.tsx"
export { HIERARCHY_DEPTH } from "./search/types.ts"
export type { SearchHit, SearchRecord, SearchResponse } from "./search/types.ts"
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `yarn workspace @mailwoman/react test:browser lib/search/SearchModal.test.tsx`
Expected: PASS, 6 tests.

- [ ] **Step 5: Register exports, lint and commit**

Run: `git add packages/react/lib/search packages/react/lib/search.ts && yarn lint`
Expected: the `workspace-exports` check reports the missing `./search` entries; apply the fix it names, rerun `yarn lint`, and expect zero findings under `packages/react`.

```bash
git commit -m "Add a docs search modal on a native dialog and an ARIA combobox" -- packages/react
```

---

### Task 6: Mount the modal, delete Algolia, verify end to end

**Files:**

- Create: `docs/src/theme/SearchBar.tsx`, `docs/test/search.spec.ts`
- Modify: `docs/docusaurus.config.ts` (delete the `algolia` block at lines 262–266)
- Modify: the docs custom CSS file that styles the navbar (add `.navbar__search-button`)

**Interfaces:**

- Consumes: `SearchModal` from `@mailwoman/react/search/SearchModal`; `openWholeDatabase`, `RangeDatabase` from `@mailwoman/resolver-wof-wasm/httpvfs/database`; `search` from `../search/search.ts`; `SEARCH_INDEX_PATH`, `SQLITE_RUNTIME_PATH` from `../search/constants.ts`.

- [ ] **Step 1: Delete the Algolia block**

Remove from `themeConfig` in `docs/docusaurus.config.ts`:

```ts
		algolia: {
			appId: "1AEXFQAAAJ",
			indexName: "Mailwoman Site",
			apiKey: "637194a77c844e7df987b51d59505272",
		},
```

- [ ] **Step 2: Write the theme component**

`docs/src/theme/SearchBar.tsx`:

```tsx
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The navbar search control. It opens the search modal on a click, on Ctrl+K or Cmd+K, and on `/`
 *   pressed outside a text field. The index is opened in the sqlite-wasm worker on the first query and
 *   kept for the page's lifetime.
 */

import { useHistory } from "@docusaurus/router"
import { SearchModal } from "@mailwoman/react/search/SearchModal"
import type { SearchResponse } from "@mailwoman/react/search/types"
import { openWholeDatabase, type RangeDatabase } from "@mailwoman/resolver-wof-wasm/httpvfs/database"
import { useCallback, useEffect, useRef, useState } from "react"

import { SEARCH_INDEX_PATH, SQLITE_RUNTIME_PATH } from "../search/constants.ts"
import { search } from "../search/search.ts"

function isEditable(target: EventTarget | null): boolean {
	return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
}

export default function SearchBar() {
	const history = useHistory()
	const [open, setOpen] = useState(false)
	const database = useRef<Promise<RangeDatabase> | undefined>(undefined)

	const runSearch = useCallback(async (q: string, signal: AbortSignal): Promise<SearchResponse> => {
		// A failed open clears the memo so the next query retries.
		database.current ??= openWholeDatabase(SEARCH_INDEX_PATH, SQLITE_RUNTIME_PATH).catch((error: unknown) => {
			database.current = undefined
			throw error
		})

		const db = await database.current

		if (signal.aborted) throw new DOMException("aborted", "AbortError")

		return search(db, q)
	}, [])

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
				open={open}
				onClose={() => setOpen(false)}
				onNavigate={(href) => history.push(href)}
				search={runSearch}
			/>
		</>
	)
}
```

Confirm that `docs/plugins/runtime-assets/plugin.ts` stages into `static/mailwoman/sqlite`, which the site serves at `/mailwoman/sqlite/`. Confirm the docs site loads `@mailwoman/react/styles.css`; add the import beside the other `@mailwoman/react` style imports when it does not.

- [ ] **Step 3: Write the Playwright test**

Read an existing spec under `docs/test/` for the fixtures and base URL convention, then write `docs/test/search.spec.ts`:

```ts
import { expect, test } from "@playwright/test"

test("the search modal returns a hit for a reference page", async ({ page }) => {
	await page.goto("/")
	await page.keyboard.press("Control+k")

	const dialog = page.locator("dialog.mw-search")

	await expect(dialog).toBeVisible()

	const input = dialog.getByRole("combobox")

	await expect(input).toBeFocused()
	await input.fill("locales and tiers")

	const first = dialog.getByRole("option").first()

	await expect(first).toContainText("Locales and tiers")
	await first.locator("a").click()
	await expect(page).toHaveURL(/\/docs\/developers\/reference\/locales-and-tiers/)
})

test("a misspelled query shows the corrected text", async ({ page }) => {
	await page.goto("/")
	await page.keyboard.press("Control+k")
	await page.locator("dialog.mw-search").getByRole("combobox").fill("vitrebi")
	await expect(page.locator(".mw-search__corrected")).toContainText("viterbi")
})
```

- [ ] **Step 4: Build, serve and run the Playwright test**

Run `yarn workspace @mailwoman/docs build`, then `yarn workspace @mailwoman/docs serve` in the background, then `yarn workspace @mailwoman/docs test:e2e test/search.spec.ts` against the served build (read `docs/playwright.config.ts` for the base URL it expects).

Expected: both tests pass.

Then check in a browser with the Chrome DevTools tools:

1. `Ctrl+K` opens the dialog with focus in the field.
2. The network panel shows one request for `/search-index.db.gz` whose size is near the gzip size the build logged, and no second request for it after the dialog is closed and reopened.
3. `Escape` closes the dialog and focus returns to the Search button; a backdrop click closes it.
4. `git grep -niE "algolia|docsearch" -- docs/docusaurus.config.ts docs/src docs/package.json` prints zero lines.

Run the `chrome-devtools-mcp:a11y-debugging` audit on the open dialog and fix each finding in `packages/react/lib/search/`.

- [ ] **Step 5: Lint, type-check, test and commit**

Run: `git add docs/src/theme/SearchBar.tsx docs/test/search.spec.ts && yarn lint && yarn typecheck && yarn test`
Expected: each command exits 0. `yarn lint` includes the prose check on this plan and the spec.

```bash
git commit -m "Mount the search modal in the docs navbar over the sqlite-wasm index and delete the Algolia config" -- docs/src docs/test/search.spec.ts docs/docusaurus.config.ts
```

---

## After the plan

The deployed site serves `search-index.db.gz` from the next docs deploy. After one week of the site serving its own search, the operator deletes the Algolia crawler and application and revokes both Algolia keys. The probe scripts under the session scratchpad are throwaway and are not committed.
