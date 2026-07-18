# POI Data + MCP (Plan 3 of 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** poi.db (layer #1: Overture Places US/CA/MX/FR, res-9 H3-clustered, layer-contract-conforming), its builder command, the reader, the executor that turns a `POIIntent` into ranked results (with the abstain paths), the `@mailwoman/mcp` agent surface, the `mailwoman poi` CLI, and the docs inline tester.

**Architecture:** Spec §2–§3.5 + the Plan-2 final-review rides (this plan MUST land: abstain via `requiresBuildLocalLayer`, an `emitOverpassQL` surface, a CLI path that reaches `poiIntent`). Schema/reader live in `resolver-wof-sqlite` (the probe-pattern home); the builder is a Pastel command (`gazetteer build poi` — auto-registers, no registry); the executor lives in `mailwoman/` and extends the `poiQueryKind` flag; `@mailwoman/mcp` is a greenfield workspace on `@modelcontextprotocol/sdk` (stdio transport). Ancestry deviation from the spec, pre-declared: WOF ancestry is decorated at READ time (reverse-geocode the ≤k returned results), not at build time — same observable, avoids ~20M build-time PIPs; the manifest's spine key is `h3` (res 9).

**Tech Stack:** TypeScript erasable-only; Kysely/node:sqlite (DDL) + raw positional INSERTs (bulk load); `@duckdb/node-api` (lazy import, optional peer) for the Overture ingest; `h3-js` `latLngToCell` + `@mailwoman/spatial` `shortenH3Cell`; `@modelcontextprotocol/sdk`; vitest; oxfmt/oxlint.

## Global Constraints

- License header on every new `.ts`/`.tsx` file (`@copyright Sister Software` / `@license AGPL-3.0` / `@author Teffen Ellis, et al.`; module docstring merges after the author line).
- Tabs; `.ts` import extensions; erasable-only; acronym casing (`poiDB` is wrong — use `poiDatabasePath`; `categoryID`, `wofID`, `emitOverpassQL`).
- Kysely-only DDL (FTS5 virtual tables stay raw SQL per AGENTS.md); hot bulk INSERTs stay raw positional prepared statements; readers open `new DatabaseSync(path, { readOnly: true })`.
- Sealed-artifact discipline: builders end with `sealDatabase(out)` (`@mailwoman/core/utils`); never mutate a built DB; build-on-copy; promotion = symlink swap.
- DuckDB is ALWAYS `await import("@duckdb/node-api")` (lazy — optional native peer; eager import breaks `ci:smoke`). No eager top-level side effects in command modules.
- New workspace checklist (BOTH times it applies — `mcp`): root `package.json` workspaces, root `tsconfig.json` references, root `vitest.config.ts` alias, `.release-it.json` workspaces, **`scripts/smoke-clean-install.ts` WORKSPACES map**, AGENTS.md table + counts, dual exports maps, version `7.1.0`.
- New subpath (`poi-taxonomy/./table`): BOTH exports maps.
- Every guard step runs `yarn compile` (tsc), not just vitest.
- Work in `/home/lab/Projects/mailwoman-exotic-poi`, branch `feat/poi-data-mcp` (based on post-#1181 main; installed + compiled; weight artifacts already linked in this worktree).
- Commits verified `git log -1 --oneline` (never piped); trailer:
  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_012SJfJddDssHbDWqaqLoEpi
  ```

---

### Task 1: poi.db schema module

**Files:**

- Create: `resolver-wof-sqlite/poi-schema.ts`
- Test: `resolver-wof-sqlite/poi-schema.test.ts`

**Interfaces:**

- Consumes: `kysely`; `LayerContractDatabase`, `createLayerManifestTable`, `createLayerCoverageTable` from `@mailwoman/core/layers` (verify the import specifier resolves from this workspace — resolver-wof-sqlite already depends on core).
- Produces (Tasks 2–3 rely on exact names): `POITable`, `POIStageTable`, `POICategoryCodeTable`, `POIDatabase` (intersecting `LayerContractDatabase`), `POI_COLUMNS`, `createPOIStagingTables(db)`, `createPOITable(db)`, `POI_FTS_TABLE = "poi_search"`, `createPOISearchFTS(db: DatabaseSync)` (raw DDL).

- [ ] **Step 1: Failing test** — `resolver-wof-sqlite/poi-schema.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { DatabaseSync } from "node:sqlite"

import { createLayerCoverageTable, createLayerManifestTable } from "@mailwoman/core/layers"
import { sql } from "kysely"
import { describe, expect, it } from "vitest"

import { DatabaseClient } from "../core/kysley/client.ts"

import {
	createPOISearchFTS,
	createPOIStagingTables,
	createPOITable,
	POI_FTS_TABLE,
	type POIDatabase,
} from "./poi-schema.ts"
```

CORRECTION — resolver-wof-sqlite cannot relative-import core; use the package import the sibling schema tests use. READ `resolver-wof-sqlite/candidate-schema.test.ts` (or the nearest schema test) FIRST and mirror its `DatabaseClient` import exactly; if none exists, import `{ DatabaseClient } from "@mailwoman/core/kysley/client"` and confirm it resolves via the workspace exports (it is a published subpath).

```ts
function openMemory(): { raw: DatabaseSync; kdb: DatabaseClient<POIDatabase> } {
	const raw = new DatabaseSync(":memory:")
	return { raw, kdb: new DatabaseClient<POIDatabase>({ database: raw }) }
}

describe("poi schema", () => {
	it("creates the clustered WITHOUT ROWID poi table with h3_cell leading the PK", async () => {
		const { kdb } = openMemory()
		await createPOITable(kdb)
		const { rows } = await sql<{ sql: string }>`select sql from sqlite_master where name = 'poi'`.execute(kdb)
		const ddl = rows[0]?.sql.toLowerCase() ?? ""
		expect(ddl).toContain("without rowid")
		expect(ddl.indexOf("h3_cell")).toBeLessThan(ddl.indexOf("category_id"))
	})

	it("stages + contract tables coexist and accept typed rows", async () => {
		const { kdb } = openMemory()
		await createPOIStagingTables(kdb)
		await createLayerManifestTable(kdb)
		await createLayerCoverageTable(kdb)
		await kdb
			.insertInto("poi_stage")
			.values({
				h3_cell: 1001,
				category_id: 3,
				brand_wikidata: "Q38076",
				name: "McDonald's",
				name_key: "mcdonalds",
				latitude: 39.78,
				longitude: -89.65,
				country: "US",
				confidence: 0.93,
				gers_id: null,
			})
			.execute()
		const row = await kdb.selectFrom("poi_stage").selectAll().executeTakeFirstOrThrow()
		expect(row.name).toBe("McDonald's")
	})

	it("creates the FTS5 name index (raw DDL — Kysely cannot express virtual tables)", async () => {
		const { raw, kdb } = openMemory()
		await createPOITable(kdb)
		createPOISearchFTS(raw)
		const found = raw.prepare("select name from sqlite_master where name = ?").get(POI_FTS_TABLE)
		expect(found).toBeDefined()
	})
})
```

- [ ] **Step 2: verify FAIL** — `yarn vitest run resolver-wof-sqlite/poi-schema.test.ts`.
- [ ] **Step 3: Implement** `resolver-wof-sqlite/poi-schema.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Typed schema for poi.db — spatial layer #1 (spec §3.4). One clustered `WITHOUT ROWID` B-tree
 *   keyed `(h3_cell, category_id, neg_rank, rowid_key)` so "everything near this res-9 cell" is a
 *   contiguous key range (the byte-range/httpvfs access pattern, same discipline as the candidate
 *   gazetteer). Rows carry denormalized name/brand/coords; category ids are small ints via the
 *   `poi_category_codes` dictionary (poi-taxonomy category ids are the string side). The DB also
 *   embeds the layer-contract tables from `@mailwoman/core/layers` — the builder writes the
 *   manifest (tier `shipped`, spine `h3` res 9) and per-res-6-cell coverage.
 */

import { sql, type Kysely } from "kysely"
import type { DatabaseSync } from "node:sqlite"

import type { LayerContractDatabase } from "@mailwoman/core/layers"

/** One POI row. Clustered PK: h3_cell → category_id → neg_rank → rowid_key. */
export interface POITable {
	/** 48-bit short H3 cell at res 9 (`latLngToCell` → `shortenH3Cell`). */
	h3_cell: number
	/** Small int from {@link POICategoryCodeTable}; 0 = uncategorized. */
	category_id: number
	/** `-log10(confidence + epsilon)` so ASC = most-confident-first within a cell+category. */
	neg_rank: number
	/** Uniquifier within the clustered key (builder-assigned monotonic int). */
	rowid_key: number
	name: string | null
	/** Lowercased, diacritic-flattened probe key for exact name lookups. */
	name_key: string | null
	brand_wikidata: string | null
	latitude: number
	longitude: number
	/** ISO 3166-1 alpha-2 (from the Overture partition). */
	country: string
	/** Overture existence confidence (already filtered ≥ 0.85 at build). */
	confidence: number
	/** GERS id — nullable METADATA ONLY, never a key (the #470 rule). */
	gers_id: string | null
}

/** Staging mirror (loader fills positionally; every column nullable except the coords). */
export type POIStageTable = POITable

/** `(id → poi-taxonomy category id)` dictionary, e.g. `3 → "cafe"`. */
export interface POICategoryCodeTable {
	id: number
	category: string
}

export interface POIDatabase extends LayerContractDatabase {
	poi: POITable
	poi_stage: POIStageTable
	poi_category_codes: POICategoryCodeTable
}

/** Clustered-key-order column list shared by builder + `INSERT INTO poi SELECT … FROM poi_stage`. */
export const POI_COLUMNS = [
	"h3_cell",
	"category_id",
	"neg_rank",
	"rowid_key",
	"name",
	"name_key",
	"brand_wikidata",
	"latitude",
	"longitude",
	"country",
	"confidence",
	"gers_id",
] as const

export async function createPOIStagingTables(db: Kysely<POIDatabase>): Promise<void> {
	await db.schema
		.createTable("poi_category_codes")
		.addColumn("id", "integer", (c) => c.primaryKey())
		.addColumn("category", "text", (c) => c.unique())
		.execute()
	await db.schema
		.createTable("poi_stage")
		.addColumn("h3_cell", "integer")
		.addColumn("category_id", "integer")
		.addColumn("neg_rank", "real")
		.addColumn("rowid_key", "integer")
		.addColumn("name", "text")
		.addColumn("name_key", "text")
		.addColumn("brand_wikidata", "text")
		.addColumn("latitude", "real")
		.addColumn("longitude", "real")
		.addColumn("country", "text")
		.addColumn("confidence", "real")
		.addColumn("gers_id", "text")
		.execute()
}

export async function createPOITable(db: Kysely<POIDatabase>): Promise<void> {
	await db.schema
		.createTable("poi")
		.addColumn("h3_cell", "integer", (c) => c.notNull())
		.addColumn("category_id", "integer", (c) => c.notNull())
		.addColumn("neg_rank", "real", (c) => c.notNull())
		.addColumn("rowid_key", "integer", (c) => c.notNull())
		.addColumn("name", "text")
		.addColumn("name_key", "text")
		.addColumn("brand_wikidata", "text")
		.addColumn("latitude", "real", (c) => c.notNull())
		.addColumn("longitude", "real", (c) => c.notNull())
		.addColumn("country", "text", (c) => c.notNull())
		.addColumn("confidence", "real", (c) => c.notNull())
		.addColumn("gers_id", "text")
		.addPrimaryKeyConstraint("poi_pk", ["h3_cell", "category_id", "neg_rank", "rowid_key"])
		// `WITHOUT ROWID` has no first-class builder; the raw modifier is the idiomatic fallback.
		.modifyEnd(sql`without rowid`)
		.execute()
}

export const POI_FTS_TABLE = "poi_search"

/** FTS5 stays raw SQL by project rule (Kysely can't express virtual tables). Content-keyed by name_key. */
export function createPOISearchFTS(db: DatabaseSync): void {
	db.exec(
		`CREATE VIRTUAL TABLE ${POI_FTS_TABLE} USING fts5(name, name_key UNINDEXED, h3_cell UNINDEXED, tokenize = 'unicode61')`
	)
}
```

- [ ] **Step 4: verify PASS**, then `yarn compile` exit 0.
- [ ] **Step 5:** oxfmt both files; commit `feat(resolver-wof-sqlite): poi.db schema — res-9 clustered layer #1`; verify `git log -1 --oneline`.

---

### Task 2: poi.db reader

**Files:**

- Create: `resolver-wof-sqlite/poi-lookup.ts`
- Test: `resolver-wof-sqlite/poi-lookup.test.ts`

**Interfaces:**

- Consumes: Task 1's schema; `h3-js` (`latLngToCell`, `gridDisk`) — h3-js is NOT currently a resolver-wof-sqlite dep: add `"h3-js": "^4.5.0"` to its package.json dependencies (match spatial's range) + `yarn install` (lockfile committed with this task); `shortenH3Cell`/`expandH3Cell` semantics — REIMPLEMENT locally is FORBIDDEN; import from `@mailwoman/spatial` if it's a dep, else add `"@mailwoman/spatial": "workspace:*"`.
- Produces (Task 4 relies on): `POILookup` class (`implements Disposable`), `POISearchQuery`, `POISearchHit`:

```ts
export interface POISearchQuery {
	/** poi-taxonomy category id (string side of the dictionary). */
	categoryID?: string
	/** Wikidata QID for brand-exact search. */
	brandWikidata?: string
	/** Free-text name (FTS5). */
	name?: string
	/** Search center. Required for category/brand queries (k-ring expansion). */
	center?: { latitude: number; longitude: number }
	/** Ring budget: how many res-9 k-rings to expand before giving up (default 12 ≈ ~4 km). */
	maxRings?: number
	limit?: number
}

export interface POISearchHit {
	name: string | null
	categoryID: string | null
	brandWikidata: string | null
	latitude: number
	longitude: number
	country: string
	confidence: number
	distanceM?: number
}
```

Mechanics: constructor opens read-only, loads `poi_category_codes` into two Maps (candidate-lookup pattern), prepares the cell probe `SELECT … FROM poi WHERE h3_cell = ? AND category_id = ? ORDER BY neg_rank ASC LIMIT ?`. `search(query)`: category/brand path = `latLngToCell(center, 9)` → `gridDisk` ring expansion (ring 0, then growing) probing each cell (brand path probes with `category_id` unconstrained: prepare a second cell probe filtered `brand_wikidata = ?`), accumulate until `limit` hits or `maxRings` exhausted, sort by haversine distance (import `haversineKm` from `@mailwoman/spatial`), set `distanceM`. Name path = FTS5 `MATCH` (sanitize: strip `"`, `*`, `:` — read `resolver-wof-sqlite/fts.ts`'s `sanitizeFTSQuery` and REUSE it if exported) then hydrate rows by `name_key` probe. Throws if category/brand query lacks `center`.

- [ ] **Step 1: Failing test** — build a small fixture db IN the test via Task 1's schema module + raw inserts (12 rows: 3 cafes near Springfield IL coords at increasing distance, 1 McDonald's `Q38076`, rows in a far-away cell, one uncategorized named row "Pier 39"). Assert: category search returns cafes nearest-first with `distanceM` ascending; brand search finds the QID row; name FTS finds "Pier 39"; category search without center throws /center/; limit respected; searching a category with no rows within `maxRings` returns [].
- [ ] **Step 2: verify FAIL.** Step 3: implement. Step 4: verify PASS + `yarn compile`. Step 5: oxfmt, commit `feat(resolver-wof-sqlite): POILookup — k-ring probe + brand/name search`, verify.

---

### Task 3: Builder command `gazetteer build poi`

**Files:**

- Create: `mailwoman/commands/gazetteer/build/poi.tsx` (auto-registers as `mailwoman gazetteer build poi` — no registry)
- Create: `mailwoman/gazetteer-pipeline/poi/build-poi.ts` (the logic — command stays thin)
- Test: `mailwoman/gazetteer-pipeline/poi/build-poi.test.ts` (parquet→db phase only, tiny fixture parquet NOT required — feed the loader rows via an injected iterator)

**Pattern anchors (from recon — read these files first):** `mailwoman/commands/gazetteer/overture-ingest.tsx` (lazy DuckDB, S3 glob, `SET s3_region='us-west-2'`, `threads=4`, `memory_limit='8GB'`, per-country `COPY (SELECT …) TO parquet`), `mailwoman/gazetteer-pipeline/index.ts` (`sealDatabase` after build; build-on-copy), `resolver-wof-sqlite/build-candidate.ts` (staging bulk-load → materialize → dictionaries).

Two phases in `build-poi.ts`:

1. **Ingest** (`ingestPlaces(opts)`): DuckDB (lazy import) over `s3://overturemaps-us-west-2/release/${release}/theme=places/type=place/*.parquet`; per country `COPY (SELECT id, names.primary AS name, categories, brand, confidence, ST_X(geometry) AS lon, ST_Y(geometry) AS lat, country FROM read_parquet(…, hive_partitioning = 1) WHERE country = '${cc}' AND confidence >= 0.85) TO '<data-root>/overture/<release>/places-<cc>.parquet'`. CAUTION: the Places schema's category/brand columns are STRUCTs and the NEW `taxonomy` property may or may not exist in the pinned release — the implementer MUST first probe the schema (`DESCRIBE SELECT * FROM read_parquet(…) LIMIT 1`) and select whichever of `taxonomy.primary` / `categories.primary` exists (prefer `taxonomy.primary`), extracting `brand.wikidata` and `brand.names.primary` when present. Record which property was used in the build report. Default release: pin the repo's `DEFAULT_RELEASE` from overture-ingest.tsx unless `--release` given.
2. **Build** (`buildPOIDatabase(opts)`): read the country parquets via DuckDB → stream rows into `poi_stage` with raw positional prepared INSERTs inside `BEGIN`/`COMMIT` batches (10k); map category string → small int via `poi_category_codes` (insert-on-first-sight); unknown/missing category → 0; `h3_cell` = `shortenH3Cell(latLngToCell(lat, lon, 9))` — h3 cell packing MUST go through `@mailwoman/spatial` (`H3Cell` cast per its types); `name_key` = reuse the same normalizer the candidate builder uses (find it in `build-candidate.ts` — likely `normalizeLocalityForKey` from a shared module; import, don't copy); `neg_rank = -Math.log10(confidence + 1e-6)` NEGATED so ASC = best first — verify sign against the candidate builder's `neg_rank` convention and match it; materialize `INSERT INTO poi SELECT ${POI_COLUMNS.join(", ")} FROM poi_stage ORDER BY h3_cell, category_id, neg_rank, rowid_key`; drop stage; build FTS (`createPOISearchFTS` + `INSERT INTO poi_search SELECT name, name_key, h3_cell FROM poi WHERE name IS NOT NULL`); write layer manifest (`writeLayerManifest`: name `poi`, tier `shipped`, license `CDLA-Permissive-2.0`, attribution `Overture Maps Foundation`, source `overture-places`, sourceVintage = release, buildCmd `mailwoman gazetteer build poi`, buildSHA = `git rev-parse --short HEAD` passed in by the command, freshnessPolicy `sealed`, spineKeys `{ h3: { column: "h3_cell", resolution: 9 } }`, createdAt passed in); write coverage (aggregate per res-6 cell: `observed_rows` count, `completeness` = 1.0 for Overture-covered countries — document that this is source-level coverage, not survey completeness); `ANALYZE`; `VACUUM`; close; `sealDatabase(out)`.

Command (`poi.tsx`): zod options `release?, countries? (default "US,CA,MX,FR"), out?, limit?, skipIngest (boolean, default false)`; `useCommandTask` runner; result lines: per-country row counts + db size + manifest echo. Mirror `overture-ingest.tsx`'s component tail exactly.

Test (injected-iterator): `buildPOIDatabase` accepts `rows: AsyncIterable<POISourceRow> | Iterable<POISourceRow>` as an alternative to parquet paths (design the signature so the DuckDB read is just the default row source). Feed 30 synthetic rows across 2 countries/3 categories; assert: clustered order on disk (probe returns best-confidence first), dictionary round-trip, manifest reads back valid (`readLayerManifest`), coverage rows exist at res 6, file sealed (mode 0444 — check with `fs.statSync(out).mode & 0o222 === 0`), `POILookup` (Task 2) finds a seeded row end-to-end.

- [ ] Steps: failing test → FAIL → implement build-poi.ts → PASS → wire poi.tsx → `yarn compile` → CLI help sanity: `node mailwoman/out/cli.js gazetteer build poi --help` shows the options → oxfmt → commit `feat(gazetteer): build poi — Overture Places ingest + sealed res-9 layer db` → verify.

---

### Task 4: Executor — POIIntent → results, with the abstain paths

**Files:**

- Modify: `core/pipeline/types.ts` (additive: `POIResult`, `results?` on the intent outcome)
- Create: `mailwoman/poi-executor.ts`
- Modify: `mailwoman/poi-intent.ts` (stage gains the executor + abstain logic)
- Modify: `mailwoman/runtime-pipeline.ts` (`poiQueryKind?: boolean | { poiDatabasePath?: string }`)
- Test: `mailwoman/poi-executor.test.ts`

**Type additions (core, verbatim):**

```ts
/** One executed POI search result (spec §3.4; produced by the executor, absent pre-execution). */
export interface POIResult {
	name: string | null
	categoryID: string | null
	brandWikidata: string | null
	latitude: number
	longitude: number
	country: string
	confidence: number
	distanceM?: number
}
```

and the intent variant of `POIIntentOutcome` gains `results?: POIResult[]` (additive optional — Plan 2 consumers unaffected).

**Executor (`mailwoman/poi-executor.ts`):** `createPOIExecutor(opts: { lookup: POILookup | undefined; requiresBuildLocal: (categoryID: string) => boolean })` returning `execute(intent: POIIntent): POIIntentOutcome`. Logic:

- subject category + `requiresBuildLocal(categoryID)` and no lookup rows for it → `{ type: "abstain", reason: "requires_build_local_layer" }` — THE Plan-2 ride; wire `requiresBuildLayer` via `requiresBuildLocalLayer(getPOICategory(id)!)` from poi-taxonomy in the runtime-pipeline wiring (executor itself stays injectable/pure).
- no lookup at all (no poi.db configured) → `{ type: "intent", intent }` unchanged (intent-only mode — today's Plan-2 behavior).
- anchor: center = anchor tree's deepest resolved node with lat/lon (walk roots for a node with numeric lat/lon — the resolver decorates when wired), else `anchor.biasPoint`, else for category/brand subjects → `{ type: "abstain", reason: "anchor_required" }`; name subjects search the FTS path with no center.
- otherwise run `lookup.search(...)` mapping subject kind → query; return `{ type: "intent", intent, results }`.

**Stage change (`poi-intent.ts`):** `createPOIIntentStage` gains optional `execute?: (intent: POIIntent) => POIIntentOutcome`; when present, the stage returns `execute(intent)` instead of the bare intent (null-match fall-through unchanged). **Wiring (`runtime-pipeline.ts`):** `poiQueryKind: true` keeps intent-only; `poiQueryKind: { poiDatabasePath }` additionally constructs `POILookup` lazily on first call (the placeCountry lazy pattern — the sync factory stays sync) and passes the executor. Abstain wiring for build-local categories applies in BOTH modes (it needs no db).

Tests: executor pure-unit with a stub lookup (category happy path w/ center from a fixture anchor tree; anchor_required; requires_build_local_layer for `fire_hydrant` when the stub returns no rows; intent-only passthrough when lookup undefined; name search without center OK). Plus one wiring test: `createRuntimePipeline({ ...HERMETIC, poiQueryKind: true })` on "fire hydrant" now yields `poiIntent.type === "abstain"` with reason `requires_build_local_layer` (bare infra subject, no local layer, no db) — note this CHANGES a Plan-2 test expectation in `mailwoman/poi-intent.test.ts` ("fire hydrant" returned a bare intent); update that test accordingly and say so in the commit body.

- [ ] Steps: failing tests → FAIL → core types → executor → stage/wiring edits → PASS (executor + poi-intent + poi-branch + geocode-core suites) → `yarn compile` → oxfmt → commit `feat(mailwoman): POI executor — results + abstain paths (anchor_required, requires_build_local_layer)` → verify.

---

### Task 5: CLI — `mailwoman poi` + `--poi` on parse

**Files:**

- Create: `mailwoman/commands/poi.tsx` (auto-registers as `mailwoman poi`)
- Modify: `mailwoman/commands/parse.tsx` (add a `--poi` boolean zod option, default false, `.describe("Enable poi_query detection (poiQueryKind flag)")`; thread it into the pipeline factory call the command builds)
- Test: none beyond compile + manual CLI checks (Ink components are exercised by `ci:smoke`)

`poi.tsx`: positional query string; options `overpass` (boolean — print `emitOverpassQL` output; resolve the osmTag via `getPOICategory`), `db` (string, optional poi.db path → `poiQueryKind: { poiDatabasePath }`), `json` (boolean). Runs the flag-on pipeline, prints: detected intent (subject/anchor), abstain reason when abstained, results table (name, category, distance) when present, OverpassQL block under `--overpass`. Follow the `useCommandTask` + CheckList conventions of sibling commands (read `parse.tsx`'s structure first). This closes two Plan-2 rides: the emitter surface and the reachable `poiIntent` debug path.

- [ ] Steps: implement → `yarn compile` → manual checks (record outputs in the report):
      `node mailwoman/out/cli.js poi "drinking fountain near Springfield" --overpass` → intent + abstain/results + QL block;
      `node mailwoman/out/cli.js poi "fire hydrant"` → abstain `requires_build_local_layer`;
      `node mailwoman/out/cli.js parse "350 5th Ave, New York" ` → unchanged (no --poi);
      → oxfmt → commit `feat(cli): mailwoman poi command + parse --poi flag` → verify.

---

### Task 6: `@mailwoman/mcp` workspace

**Files:**

- Create: `mcp/package.json`, `mcp/tsconfig.json`, `mcp/index.ts`, `mcp/server.ts`, `mcp/tools.ts`, `mcp/cli.ts` (bin entry), `mcp/tools.test.ts`
- Modify (registration, ALL of): root `package.json` workspaces, root `tsconfig.json` references, root `vitest.config.ts` alias, `.release-it.json`, `scripts/smoke-clean-install.ts` WORKSPACES map, `AGENTS.md` (row in the Drop-in APIs group + counts 38→39 scoped / 36→37 publish / 39→40 total), `yarn.lock` via install.

package.json: name `@mailwoman/mcp`, version `7.1.0`, dual exports maps (`.` and `./package.json`), `bin: { "mailwoman-mcp": "./out/cli.js" }`, deps: `@modelcontextprotocol/sdk` (latest ^1 — check npm), `mailwoman: "workspace:*"`, `@mailwoman/core: "workspace:*"`, `@mailwoman/poi-taxonomy: "workspace:*"`, `zod`. Description: "MCP server — mailwoman's spatial toolset for agents (parse, geocode, poi_search, overpass_export, layer_manifest)."

`tools.ts` — pure, transport-free tool table so tests don't need MCP plumbing:

```ts
export interface MCPToolDeps {
	parse: (text: string, opts?: { poi?: boolean }) => Promise<unknown>
	geocode: (text: string) => Promise<unknown>
	poiSearch: (q: { query: string; poiDatabasePath?: string }) => Promise<unknown>
	overpassExport: (query: string) => Promise<string>
	layerManifest: (databasePath: string) => Promise<unknown>
}
export interface MCPToolDef {
	name: string
	description: string
	inputSchema: zod.ZodObject<any>
	handler: (args: any) => Promise<unknown>
}
export function buildToolTable(deps: MCPToolDeps): MCPToolDef[]
```

Five tools: `mailwoman_parse`, `mailwoman_geocode`, `mailwoman_poi_search`, `mailwoman_overpass_export`, `mailwoman_layer_manifest` (opens the db read-only, returns `readLayerManifest` + coverage summary). Descriptions written for an agent consumer (state units, when to use which).

`server.ts`: `createMCPServer(deps)` — `new McpServer({ name: "mailwoman", version })` from `@modelcontextprotocol/sdk/server/mcp.js`, register each tool, return server. `cli.ts`: connect `StdioServerTransport` (`@modelcontextprotocol/sdk/server/stdio.js`), deps built from the real library (pipeline factory with weights auto-resolve; poi flag on; lazy — construct the pipeline on first tool call). CAUTION: the SDK's registration API surface moves between minors — after install, READ `node_modules/@modelcontextprotocol/sdk`'s `.d.ts` for the current `registerTool`/`tool()` signature and adapt mechanically; the tool TABLE (tools.ts) is the stable contract, the SDK glue is thin.

Tests (`tools.test.ts`): buildToolTable with stub deps — five tools present, names/schemas valid (each `inputSchema.safeParse` accepts a canonical example + rejects a bad one), handlers route to the right dep, overpass tool returns the stub string. NO transport/server test (SDK glue is exercised by the smoke run below).

- [ ] Steps: scaffold + registrations + `yarn install` → failing tests → FAIL → implement → PASS → `yarn compile` → stdio smoke: `printf '' | node mcp/out/cli.js` exits without crash (or use the SDK's inspector if trivially available — do not install extra packages) → `yarn ci:smoke` MUST pass (new workspace in the packing closure — expect 29) → oxfmt → commit `feat(mcp): @mailwoman/mcp — agent toolset over stdio` → verify.

---

### Task 7: poi-taxonomy browser-safe entry

**Files:**

- Create: `poi-taxonomy/table.ts` (new subpath `./table`)
- Modify: `poi-taxonomy/package.json` (BOTH exports maps gain `./table`), `poi-taxonomy/lookup.ts` (extract the pure index/matching core so it's shared)
- Test: `poi-taxonomy/table.test.ts`

Refactor WITHOUT behavior change: pull the index construction + match logic out of `lookup.ts` into an internal `createLookupCore(table: POITaxonomyTable)` (not exported from the node entry barrel); `lookup.ts` keeps its `node:fs` loader + module-level singletons + identical public API (all existing tests must pass untouched). `table.ts` exports `createPOITaxonomyLookup(table: POITaxonomyTable)` returning `{ lookupPOICategory, getPOICategory, getAllCategories, requiresBuildLocalLayer }` bound to the INJECTED table — zero node imports, bundler-safe (the docs tester imports the JSON via webpack and injects it). Test: inject a two-category table, same semantics as the node entry (one locale-gated case, one infra flag case); plus a node-entry regression run.

- [ ] Steps: failing test → FAIL → refactor + table.ts + both maps → PASS (`yarn vitest run poi-taxonomy/` — ALL green incl. Plan-1/2 tests) → `yarn compile` → oxfmt → commit `feat(poi-taxonomy): browser-safe ./table entry (injected table, no node:fs)` → verify.

---

### Task 8: Docs inline tester

**Files:**

- Create: `docs/src/components/POIExplorer/POIExplorer.tsx`
- Create: `docs/articles/understanding/exotic-poi/try-it.mdx` (or extend the exotic-poi index page — read `docs/articles/understanding/exotic-poi/` first and place it where the series index links naturally)

**Pattern anchor:** `docs/src/components/PipelineExplorer/PipelineExplorer.tsx` + its MDX usage (BrowserOnly wrapper). This tester is CLIENT-ONLY and needs NO weights and NO network: it imports `matchPOISubject` + `createKindClassifier` from `@mailwoman/kind-classifier` (pure TS), the taxonomy JSON via `import taxonomyTable from "@mailwoman/poi-taxonomy/data/taxonomy.json"` + `createPOITaxonomyLookup` from `@mailwoman/poi-taxonomy/table` (Task 7), and `emitOverpassQL` from... `mailwoman/poi-overpass.ts` is NOT exported — DO NOT import the mailwoman umbrella in docs; instead copy is forbidden too. Resolution: export `emitOverpassQL` from the mailwoman barrel? The umbrella drags node deps into webpack. CORRECT MOVE: relocate `poi-overpass.ts` → `poi-taxonomy/overpass.ts` in THIS task (it depends only on `POIIntent` from core — replace that type import with a local structural type so poi-taxonomy needn't dep core), re-export from both poi-taxonomy maps as `./overpass`, and make `mailwoman/poi-overpass.ts` a thin re-export (`export * from "@mailwoman/poi-taxonomy/overpass"`) so Plan-2 consumers/tests are untouched. Run the Plan-2 emitter tests to prove it.

Component behavior: input box → live (debounced) intent extraction: shows detected subject (category chip + build-local badge via `requiresBuildLocalLayer`), anchor remainder text, confidence, and the OverpassQL block with a copy button; a "no POI intent — parses as an address" state for non-matches. Presets row: `drinking fountain near Springfield`, `fire hydrant`, `McDonald's, Portland OR`, `hospital, 350 5th Ave, New York` (shows the address-wins guard). SSR-safe via BrowserOnly. Live poi.db results are NOT in this task (needs the R2-published layer — Task 10 note).

- [ ] Steps: Task-7-dependent; implement → `yarn workspace @mailwoman/docs typecheck` green → `yarn compile` (poi-taxonomy move) → ALL Plan-2 emitter tests green from their new home → docs build spot-check if cheap (`yarn compile` first per worktree-prereq memory) → oxfmt → commit `feat(docs): POI intent inline tester + emitter relocation to poi-taxonomy/overpass` → verify.

---

### Task 9: Whole-tree verification

- [ ] `yarn compile` exit 0; `yarn typecheck:scripts` exit 0.
- [ ] `yarn vitest run resolver-wof-sqlite/ poi-taxonomy/ core/pipeline/ kind-classifier/ mailwoman/poi-intent.test.ts mailwoman/poi-executor.test.ts mailwoman/poi-overpass.test.ts mcp/` — all green, counts reported.
- [ ] `yarn vitest run mailwoman/` full suite (weights are linked in this worktree; the parse gate must pass).
- [ ] `yarn lint` clean for branch files; `yarn workspace @mailwoman/docs typecheck`.
- [ ] `yarn ci:smoke` PASS (29 workspaces packing).
- [ ] `git status --short` clean → `git push -u origin feat/poi-data-mcp`.

---

### Task 10 (operator-visible, post-review): data builds

NOT a subagent task — the controller runs these after the final review, as background jobs:

1. Smoke-scale: `gazetteer build poi --countries US --limit 50000` → verify `mailwoman poi "coffee near Springfield IL" --db <out>` returns ranked cafes.
2. Full 4-country build (bandwidth-bound; run detached, log to scratchpad).
3. Demo slice decision (record, don't block): a CA-only `poi-demo.db` for R2/httpvfs is the Tier-A candidate; publishing rides the existing `gazetteer publish` path and the budget review the spec requires.

## Execution notes

- Tasks 1→2→3→4→5 are sequential (each consumes the prior's exports). Task 6 (MCP) depends on 4–5; Task 7 is independent after Plan 2; Task 8 depends on 7. Do NOT parallelize implementers (shared tree).
- Deviations pre-declared: read-time WOF ancestry (vs spec's build-time PIP); `poi-overpass.ts` relocation (Task 8) — both recorded here so reviewers judge against THIS plan.
- `forceFullPipeline` semantics (Plan-2 ride): DECIDED — it continues to NOT bypass the poi branch (it disables fast-paths; the poi branch is a routing branch, not a fast-path). Task 4 adds one doc line to `PipelineOpts.forceFullPipeline` saying so.
- Loader ENOENT-vs-parse distinction (joint variant-aliases fix) stays a post-arc follow-up — do not fold in here.
