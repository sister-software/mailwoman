# POI Foundations (Plan 1 of 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The spatial-layer contract (manifest + coverage tables every layer DB embeds) in `@mailwoman/core`, and the new `@mailwoman/poi-taxonomy` data package (category records + synonym lexicon + lookup API).

**Architecture:** Per `docs/superpowers/specs/2026-07-18-spatial-layers-and-poi-design.md` §2.1 and §3.3. The layer contract is a Kysely schema module (house pattern: `resolver-wof-sqlite/candidate-schema.ts`) plus typed read/write helpers. `poi-taxonomy` copies the `variant-aliases` package shape: JSON data file + synchronous loader + indexed lookup. Plan 2 (pipeline) consumes the lookup API; Plan 3 (data) replaces the seed taxonomy with the full Overture snapshot and builds poi.db against the contract.

**Tech Stack:** TypeScript (erasable-only, `.ts` imports), Kysely over `node:sqlite` via `DatabaseClient` (`core/kysley/client.ts`), vitest, oxfmt/oxlint.

## Global Constraints

- License header on every new `.ts` file, verbatim:
  ```ts
  /**
   * @copyright Sister Software
   * @license AGPL-3.0
   * @author Teffen Ellis, et al.
   */
  ```
  (Files with a module docstring merge it into this block after the author line, like `resolver-wof-sqlite/candidate-schema.ts`.)
- `erasableSyntaxOnly`: no `enum` (use `const X = {…} as const` + `type X = (typeof X)[keyof typeof X]`), no constructor parameter properties, no runtime namespaces.
- Relative imports carry explicit `.ts` extensions.
- Indentation: tabs (match the repo).
- Acronym casing in identifiers: whole camelCase components — `wofID`, `buildSHA`, `toPOICategoryID`. DB columns stay `snake_case` (string contracts).
- Kysely is the only DB connector; table DDL through the schema-builder; `WITHOUT ROWID` via `.modifyEnd(sql`without rowid`)`.
- New core subpath ⇒ update **both** exports maps in `core/package.json` (dev `exports` with `node` condition first AND `publishConfig.exports` without it).
- All work in `/home/lab/Projects/mailwoman-exotic-poi` (branch `feat/exotic-poi`). The worktree is already installed + compiled.
- Commits: run the listed `git add` + `git commit`, then verify with `git log -1 --oneline` (the pre-commit hook can fail silently in pipelines — never pipe commit output).
- End every commit message with:
  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_012SJfJddDssHbDWqaqLoEpi
  ```

---

### Task 1: Layer-contract schema module

**Files:**

- Create: `core/layers/schema.ts`
- Test: `core/layers/schema.test.ts`

**Interfaces:**

- Consumes: `kysely` (`Kysely`, `sql`), nothing else.
- Produces: `LayerTier`, `LayerFreshnessPolicy` (const objects + types), `LayerManifestTable`, `LayerCoverageTable`, `LayerContractDatabase`, `createLayerManifestTable(db: Kysely<LayerContractDatabase>): Promise<void>`, `createLayerCoverageTable(db: Kysely<LayerContractDatabase>): Promise<void>`. Tasks 2–3 and Plan 3's poi.db builder rely on these exact names.

- [ ] **Step 1: Write the failing test**

`core/layers/schema.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { DatabaseSync } from "node:sqlite"

import { sql } from "kysely"
import { describe, expect, it } from "vitest"

import { DatabaseClient } from "../kysley/client.ts"

import { createLayerCoverageTable, createLayerManifestTable, LayerTier, type LayerContractDatabase } from "./schema.ts"

function openMemoryDB(): DatabaseClient<LayerContractDatabase> {
	return new DatabaseClient<LayerContractDatabase>({ database: new DatabaseSync(":memory:") })
}

describe("layer contract DDL", () => {
	it("creates layer_manifest and accepts a typed row", async () => {
		using db = openMemoryDB()
		await createLayerManifestTable(db)

		await db
			.insertInto("layer_manifest")
			.values({
				name: "poi",
				version: "0.1.0",
				schema_version: 1,
				tier: LayerTier.Shipped,
				license: "CDLA-Permissive-2.0",
				attribution: "Overture Maps Foundation",
				source: "overture-places",
				source_vintage: "2026-06",
				build_cmd: "mailwoman gazetteer build poi",
				build_sha: "deadbeef",
				freshness_policy: "sealed",
				spine_keys: JSON.stringify({ h3: { column: "h3_cell", resolution: 13 } }),
				created_at: "2026-07-18T00:00:00Z",
			})
			.execute()

		const row = await db.selectFrom("layer_manifest").selectAll().executeTakeFirstOrThrow()
		expect(row.name).toBe("poi")
		expect(row.tier).toBe("shipped")
	})

	it("creates layer_coverage as a WITHOUT ROWID table keyed on h3_cell", async () => {
		using db = openMemoryDB()
		await createLayerCoverageTable(db)

		const { rows } = await sql<{ sql: string }>`select sql from sqlite_master where name = 'layer_coverage'`.execute(db)
		expect(rows[0]?.sql.toLowerCase()).toContain("without rowid")

		await db
			.insertInto("layer_coverage")
			.values({ h3_cell: 123456789, completeness: 0.42, observed_rows: 17 })
			.execute()
		const cell = await db.selectFrom("layer_coverage").selectAll().executeTakeFirstOrThrow()
		expect(cell.completeness).toBeCloseTo(0.42)
	})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/lab/Projects/mailwoman-exotic-poi && yarn vitest run core/layers/schema.test.ts`
Expected: FAIL — `Cannot find module './schema.ts'` (or equivalent resolve error).

- [ ] **Step 3: Write the implementation**

`core/layers/schema.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Typed schema for the spatial-layer contract — the two tables EVERY layer database embeds,
 *   regardless of tier: `layer_manifest` (single-row identity/provenance/licensing record) and
 *   `layer_coverage` (per-H3-cell survey completeness). The contract is what lets shipped,
 *   build-local, and private layers share one query surface. Spec:
 *   docs/superpowers/specs/2026-07-18-spatial-layers-and-poi-design.md §2.1.
 *
 *   Coverage carries the meaning-of-zero rule: a MISSING coverage row means "unmapped/unknown",
 *   never "surveyed and empty". Consumers must treat absence as absence of evidence.
 */

import { sql, type Kysely } from "kysely"

/** Distribution tier of a layer. Shipped = permissive-license, published by us. */
export const LayerTier = {
	Shipped: "shipped",
	/** Share-alike sources (ODbL): we ship the builder CLI, the user builds locally. */
	BuildLocal: "build-local",
	/** The user's own data, conforming to the contract, never distributed. */
	Private: "private",
} as const
export type LayerTier = (typeof LayerTier)[keyof typeof LayerTier]

/** How a layer is kept current. */
export const LayerFreshnessPolicy = {
	/** Immutable artifact; updates are full rebuilds (the gazetteer discipline). */
	Sealed: "sealed",
	/** Periodically re-issued under the same name (e.g. registries of people/programs). */
	VersionedRefresh: "versioned-refresh",
} as const
export type LayerFreshnessPolicy = (typeof LayerFreshnessPolicy)[keyof typeof LayerFreshnessPolicy]

/** The single-row layer identity record. See {@link LayerManifest} for the parsed form. */
export interface LayerManifestTable {
	name: string
	version: string
	schema_version: number
	/** One of {@link LayerTier}. */
	tier: string
	/** SPDX-ish license expression, e.g. `CDLA-Permissive-2.0`, `ODbL-1.0`. */
	license: string
	attribution: string | null
	source: string
	source_vintage: string
	build_cmd: string
	build_sha: string
	/** One of {@link LayerFreshnessPolicy}. */
	freshness_policy: string
	/** JSON-encoded spine-key declaration (see `SpineKeys` in `manifest.ts`). */
	spine_keys: string
	/** ISO-8601, supplied by the build script (never generated in-library). */
	created_at: string
}

/** Per-cell survey completeness. Missing row = unknown, NOT zero. */
export interface LayerCoverageTable {
	/** 48-bit short H3 cell at the resolution declared by the manifest's spine keys. */
	h3_cell: number
	/** Estimated completeness of the source survey in this cell, 0..1. */
	completeness: number
	/** Rows this layer actually holds in the cell. */
	observed_rows: number
}

/** Pass to `new DatabaseClient<LayerContractDatabase>(...)` (or intersect into a layer's own schema). */
export interface LayerContractDatabase {
	layer_manifest: LayerManifestTable
	layer_coverage: LayerCoverageTable
}

/** Create `layer_manifest`. Single row enforced by `name` PK + the writer's insert-once discipline. */
export async function createLayerManifestTable(db: Kysely<LayerContractDatabase>): Promise<void> {
	await db.schema
		.createTable("layer_manifest")
		.addColumn("name", "text", (c) => c.primaryKey())
		.addColumn("version", "text", (c) => c.notNull())
		.addColumn("schema_version", "integer", (c) => c.notNull())
		.addColumn("tier", "text", (c) => c.notNull())
		.addColumn("license", "text", (c) => c.notNull())
		.addColumn("attribution", "text")
		.addColumn("source", "text", (c) => c.notNull())
		.addColumn("source_vintage", "text", (c) => c.notNull())
		.addColumn("build_cmd", "text", (c) => c.notNull())
		.addColumn("build_sha", "text", (c) => c.notNull())
		.addColumn("freshness_policy", "text", (c) => c.notNull())
		.addColumn("spine_keys", "text", (c) => c.notNull())
		.addColumn("created_at", "text", (c) => c.notNull())
		.execute()
}

/** Create `layer_coverage` — small fixed-width rows probed by PK, the WITHOUT ROWID sweet spot. */
export async function createLayerCoverageTable(db: Kysely<LayerContractDatabase>): Promise<void> {
	await db.schema
		.createTable("layer_coverage")
		.addColumn("h3_cell", "integer", (c) => c.primaryKey())
		.addColumn("completeness", "real", (c) => c.notNull())
		.addColumn("observed_rows", "integer", (c) => c.notNull())
		// `WITHOUT ROWID` has no first-class builder; the raw modifier is the idiomatic fallback.
		.modifyEnd(sql`without rowid`)
		.execute()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/lab/Projects/mailwoman-exotic-poi && yarn vitest run core/layers/schema.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Format and commit**

```bash
cd /home/lab/Projects/mailwoman-exotic-poi
yarn oxfmt core/layers/schema.ts core/layers/schema.test.ts
git add core/layers/schema.ts core/layers/schema.test.ts
git commit -m "feat(core): spatial-layer contract schema (layer_manifest + layer_coverage)"
git log -1 --oneline
```

Expected: the new commit hash with the message above.

---

### Task 2: Manifest + coverage read/write helpers

**Files:**

- Create: `core/layers/manifest.ts`
- Test: `core/layers/manifest.test.ts`

**Interfaces:**

- Consumes: Task 1's `LayerContractDatabase`, `LayerTier`, `LayerFreshnessPolicy`, DDL functions.
- Produces: `SpineKeys`, `LayerManifest`, `CoverageCell`, `writeLayerManifest(db, manifest)`, `readLayerManifest(db): Promise<LayerManifest>`, `writeLayerCoverage(db, cells: CoverageCell[])`, `readLayerCoverage(db, h3Cell): Promise<CoverageCell | undefined>`. Plan 3's builder and every layer reader use these.

- [ ] **Step 1: Write the failing test**

`core/layers/manifest.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { DatabaseSync } from "node:sqlite"

import { describe, expect, it } from "vitest"

import { DatabaseClient } from "../kysley/client.ts"

import {
	readLayerCoverage,
	readLayerManifest,
	writeLayerCoverage,
	writeLayerManifest,
	type LayerManifest,
} from "./manifest.ts"
import { createLayerCoverageTable, createLayerManifestTable, type LayerContractDatabase } from "./schema.ts"

const MANIFEST: LayerManifest = {
	name: "poi",
	version: "0.1.0",
	schemaVersion: 1,
	tier: "shipped",
	license: "CDLA-Permissive-2.0",
	attribution: "Overture Maps Foundation",
	source: "overture-places",
	sourceVintage: "2026-06",
	buildCmd: "mailwoman gazetteer build poi",
	buildSHA: "deadbeef",
	freshnessPolicy: "sealed",
	spineKeys: { h3: { column: "h3_cell", resolution: 13 }, wofID: "wof_id" },
	createdAt: "2026-07-18T00:00:00Z",
}

async function openContractDB(): Promise<DatabaseClient<LayerContractDatabase>> {
	const db = new DatabaseClient<LayerContractDatabase>({ database: new DatabaseSync(":memory:") })
	await createLayerManifestTable(db)
	await createLayerCoverageTable(db)
	return db
}

describe("layer manifest IO", () => {
	it("round-trips a manifest", async () => {
		using db = await openContractDB()
		await writeLayerManifest(db, MANIFEST)
		const back = await readLayerManifest(db)
		expect(back).toEqual(MANIFEST)
	})

	it("rejects an unknown tier at write time", async () => {
		using db = await openContractDB()
		await expect(writeLayerManifest(db, { ...MANIFEST, tier: "bootleg" as never })).rejects.toThrow(/tier/)
	})

	it("rejects a manifest with no spine keys", async () => {
		using db = await openContractDB()
		await expect(writeLayerManifest(db, { ...MANIFEST, spineKeys: {} })).rejects.toThrow(/spine/)
	})

	it("throws when reading a database with no manifest", async () => {
		using db = await openContractDB()
		await expect(readLayerManifest(db)).rejects.toThrow(/manifest/)
	})
})

describe("layer coverage IO", () => {
	it("round-trips cells and returns undefined for unsurveyed cells", async () => {
		using db = await openContractDB()
		await writeLayerCoverage(db, [
			{ h3Cell: 1001, completeness: 0.9, observedRows: 240 },
			{ h3Cell: 1002, completeness: 0.1, observedRows: 3 },
		])
		expect(await readLayerCoverage(db, 1001)).toEqual({ h3Cell: 1001, completeness: 0.9, observedRows: 240 })
		// Meaning-of-zero: an unsurveyed cell is UNKNOWN (undefined), never a zero-completeness record.
		expect(await readLayerCoverage(db, 9999)).toBeUndefined()
	})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/lab/Projects/mailwoman-exotic-poi && yarn vitest run core/layers/manifest.test.ts`
Expected: FAIL — cannot resolve `./manifest.ts`.

- [ ] **Step 3: Write the implementation**

`core/layers/manifest.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Read/write helpers over the layer-contract tables. The parsed {@link LayerManifest} is the
 *   camelCase face of `layer_manifest`; validation happens at BOTH ends so a hand-built or
 *   corrupted layer fails loudly at open time rather than misbehaving downstream.
 */

import type { Kysely } from "kysely"

import { LayerFreshnessPolicy, LayerTier, type LayerContractDatabase } from "./schema.ts"

/** Which spine columns a layer carries. At least one key is required. */
export interface SpineKeys {
	h3?: { column: string; resolution: number }
	/** Column name holding WOF ids, when present. */
	wofID?: string
	/** Column name holding `@mailwoman/address-id` keys, when present. */
	addressID?: string
}

/** Parsed manifest — see {@link LayerManifestTable} for the storage form. */
export interface LayerManifest {
	name: string
	version: string
	schemaVersion: number
	tier: LayerTier
	license: string
	attribution?: string
	source: string
	sourceVintage: string
	buildCmd: string
	buildSHA: string
	freshnessPolicy: LayerFreshnessPolicy
	spineKeys: SpineKeys
	createdAt: string
}

export interface CoverageCell {
	h3Cell: number
	completeness: number
	observedRows: number
}

const TIERS = new Set<string>(Object.values(LayerTier))
const POLICIES = new Set<string>(Object.values(LayerFreshnessPolicy))

function assertManifestInvariants(manifest: Pick<LayerManifest, "tier" | "freshnessPolicy" | "spineKeys">): void {
	if (!TIERS.has(manifest.tier)) {
		throw new Error(`layer manifest: unknown tier ${JSON.stringify(manifest.tier)}`)
	}
	if (!POLICIES.has(manifest.freshnessPolicy)) {
		throw new Error(`layer manifest: unknown freshness_policy ${JSON.stringify(manifest.freshnessPolicy)}`)
	}
	if (!manifest.spineKeys.h3 && !manifest.spineKeys.wofID && !manifest.spineKeys.addressID) {
		throw new Error("layer manifest: at least one spine key (h3, wofID, addressID) is required")
	}
}

/** Insert the single manifest row. Call exactly once, from the layer's build script. */
export async function writeLayerManifest(db: Kysely<LayerContractDatabase>, manifest: LayerManifest): Promise<void> {
	assertManifestInvariants(manifest)

	await db
		.insertInto("layer_manifest")
		.values({
			name: manifest.name,
			version: manifest.version,
			schema_version: manifest.schemaVersion,
			tier: manifest.tier,
			license: manifest.license,
			attribution: manifest.attribution ?? null,
			source: manifest.source,
			source_vintage: manifest.sourceVintage,
			build_cmd: manifest.buildCmd,
			build_sha: manifest.buildSHA,
			freshness_policy: manifest.freshnessPolicy,
			spine_keys: JSON.stringify(manifest.spineKeys),
			created_at: manifest.createdAt,
		})
		.execute()
}

/** Read + validate the manifest. Throws if the table is empty, multi-row, or invalid. */
export async function readLayerManifest(db: Kysely<LayerContractDatabase>): Promise<LayerManifest> {
	const rows = await db.selectFrom("layer_manifest").selectAll().execute()

	if (rows.length !== 1) {
		throw new Error(`layer manifest: expected exactly 1 row, found ${rows.length}`)
	}
	const row = rows[0]!
	const manifest: LayerManifest = {
		name: row.name,
		version: row.version,
		schemaVersion: row.schema_version,
		tier: row.tier as LayerTier,
		license: row.license,
		...(row.attribution === null ? {} : { attribution: row.attribution }),
		source: row.source,
		sourceVintage: row.source_vintage,
		buildCmd: row.build_cmd,
		buildSHA: row.build_sha,
		freshnessPolicy: row.freshness_policy as LayerFreshnessPolicy,
		spineKeys: JSON.parse(row.spine_keys) as SpineKeys,
		createdAt: row.created_at,
	}

	assertManifestInvariants(manifest)

	return manifest
}

/** Bulk-insert coverage cells (build-time; cold path, so Kysely inserts are fine). */
export async function writeLayerCoverage(db: Kysely<LayerContractDatabase>, cells: CoverageCell[]): Promise<void> {
	if (cells.length === 0) return

	await db
		.insertInto("layer_coverage")
		.values(cells.map((c) => ({ h3_cell: c.h3Cell, completeness: c.completeness, observed_rows: c.observedRows })))
		.execute()
}

/**
 * Look up coverage for one short H3 cell. `undefined` = the cell was never surveyed (UNKNOWN) —
 * callers must not conflate this with `{completeness: 0}`.
 */
export async function readLayerCoverage(
	db: Kysely<LayerContractDatabase>,
	h3Cell: number
): Promise<CoverageCell | undefined> {
	const row = await db.selectFrom("layer_coverage").selectAll().where("h3_cell", "=", h3Cell).executeTakeFirst()

	if (!row) return undefined

	return { h3Cell: row.h3_cell, completeness: row.completeness, observedRows: row.observed_rows }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/lab/Projects/mailwoman-exotic-poi && yarn vitest run core/layers/manifest.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Format and commit**

```bash
cd /home/lab/Projects/mailwoman-exotic-poi
yarn oxfmt core/layers/manifest.ts core/layers/manifest.test.ts
git add core/layers/manifest.ts core/layers/manifest.test.ts
git commit -m "feat(core): layer manifest + coverage IO with open-time validation"
git log -1 --oneline
```

Expected: new commit hash.

---

### Task 3: Export `@mailwoman/core/layers`

**Files:**

- Create: `core/layers/index.ts`
- Modify: `core/package.json` (BOTH exports maps)

**Interfaces:**

- Consumes: Tasks 1–2 modules.
- Produces: the `@mailwoman/core/layers` subpath re-exporting everything above. Plan 3's builder and any external layer tooling import from here.

- [ ] **Step 1: Write the barrel**

`core/layers/index.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The spatial-layer contract: manifest/coverage schema + IO. Every layer database — shipped,
 *   build-local, or private — embeds these tables. Spec:
 *   docs/superpowers/specs/2026-07-18-spatial-layers-and-poi-design.md §2.1.
 */

export * from "./manifest.ts"
export * from "./schema.ts"
```

- [ ] **Step 2: Add the subpath to BOTH exports maps in `core/package.json`**

In the dev `exports` map (alphabetically near `"./env"`), insert:

```json
"./layers": {
	"node": "./layers/index.ts",
	"default": "./out/layers/index.js",
	"types": "./out/layers/index.d.ts"
},
```

In `publishConfig.exports` (same neighborhood), insert:

```json
"./layers": {
	"types": "./out/layers/index.d.ts",
	"default": "./out/layers/index.js"
},
```

- [ ] **Step 3: Verify resolution from source mode and compile**

Run:

```bash
cd /home/lab/Projects/mailwoman-exotic-poi
node -e 'import("@mailwoman/core/layers").then((m) => console.log(typeof m.writeLayerManifest))'
yarn compile
```

Expected: `function`, then a clean compile (no tsc errors; `core/out/layers/index.js` exists afterwards).

- [ ] **Step 4: Run both layer test files**

Run: `yarn vitest run core/layers/`
Expected: PASS (7 tests total).

- [ ] **Step 5: Commit**

```bash
cd /home/lab/Projects/mailwoman-exotic-poi
git add core/layers/index.ts core/package.json
git commit -m "feat(core): export @mailwoman/core/layers (dev + publish maps)"
git log -1 --oneline
```

Expected: new commit hash.

---

### Task 4: Scaffold the `@mailwoman/poi-taxonomy` workspace

**Files:**

- Create: `poi-taxonomy/package.json`, `poi-taxonomy/tsconfig.json`
- Modify: `package.json` (root workspaces array), `tsconfig.json` (root references), `vitest.config.ts` (alias), `.release-it.json` (workspaces list)

**Interfaces:**

- Produces: an installable, compilable, publishable empty workspace named `@mailwoman/poi-taxonomy`. Tasks 5–6 fill it.

- [ ] **Step 1: Create `poi-taxonomy/package.json`**

```json
{
	"name": "@mailwoman/poi-taxonomy",
	"version": "7.0.0",
	"description": "POI category taxonomy + phrase lexicon — Overture category snapshot, infrastructure extension namespace, and the synonym table mapping query phrases ('drinking fountain', 'fiber hut') to category ids.",
	"license": "AGPL-3.0-only OR LicenseRef-Commercial",
	"repository": {
		"type": "git",
		"url": "https://github.com/sister-software/mailwoman.git",
		"directory": "poi-taxonomy"
	},
	"files": ["out/**/*.js", "out/**/*.js.map", "out/**/*.d.ts", "out/**/*.d.ts.map", "data/**/*.json"],
	"type": "module",
	"exports": {
		"./package.json": "./package.json",
		".": {
			"node": "./index.ts",
			"default": "./out/index.js",
			"types": "./out/index.d.ts"
		}
	},
	"publishConfig": {
		"access": "public"
	}
}
```

- [ ] **Step 2: Create `poi-taxonomy/tsconfig.json`** (copy of the variant-aliases one)

```json
{
	"extends": "@sister.software/tsconfig",
	"compilerOptions": {
		"outDir": "./out",
		"emitDeclarationOnly": false,
		"rewriteRelativeImportExtensions": true,
		"erasableSyntaxOnly": true
	},
	"include": ["./**/*"],
	"exclude": ["./out/**/*", "./**/*.test.ts", "./**/*.test.tsx"],
	"references": []
}
```

- [ ] **Step 3: Register the workspace in the four root files**

1. Root `package.json` `workspaces` array — insert `"poi-taxonomy",` after `"phrase-grouper",`.
2. Root `tsconfig.json` `references` — insert `{ "path": "./poi-taxonomy" },` next to `{ "path": "./phrase-grouper" }`.
3. Root `vitest.config.ts` — next to the variant-aliases alias line, insert:
   ```ts
   { find: /^@mailwoman\/poi-taxonomy$/, replacement: resolve(here, "poi-taxonomy/index.ts") },
   ```
4. `.release-it.json` — in the `@release-it-plugins/workspaces` → `workspaces` array, insert `"poi-taxonomy",` after `"phrase-grouper",` (match the array's existing order convention; `variant-aliases` is already listed there).

- [ ] **Step 4: Install to register the workspace**

Run: `cd /home/lab/Projects/mailwoman-exotic-poi && yarn install`
Expected: succeeds; `yarn workspaces list` output includes `poi-taxonomy`.
(Note: `yarn install` here mutates `yarn.lock` — that's expected and committed with this task.)

- [ ] **Step 5: Commit**

```bash
cd /home/lab/Projects/mailwoman-exotic-poi
git add poi-taxonomy/package.json poi-taxonomy/tsconfig.json package.json tsconfig.json vitest.config.ts .release-it.json yarn.lock
git commit -m "feat(poi-taxonomy): scaffold the @mailwoman/poi-taxonomy workspace"
git log -1 --oneline
```

Expected: new commit hash. (The tsconfig has no source files yet; `yarn compile` may emit nothing for this workspace — that's fine until Task 5.)

---

### Task 5: Taxonomy types + seed data

**Files:**

- Create: `poi-taxonomy/types.ts`
- Create: `poi-taxonomy/data/taxonomy.json`

**Interfaces:**

- Produces: `POICategoryID` (branded string) + `toPOICategoryID`, `CategorySource` const, `CategoryRecord`, `SynonymEntry`, `POITaxonomyTable`. Task 6's loader and Plan 2's scorer consume these exact names.

- [ ] **Step 1: Write `poi-taxonomy/types.ts`**

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Types for the POI category taxonomy. Categories come from two namespaces: the Overture Places
 *   `taxonomy` snapshot (shipped-tier data; the old `categories` property is dead as of Overture's
 *   Sept 2026 release, so ONLY the new property is modeled), and the `mailwoman-infra` extension
 *   for street-furniture/infrastructure classes that exist only in ODbL sources (fire hydrants,
 *   post boxes) — recognized by the lexicon even when no build-local layer is present.
 */

declare const POICategoryIDBrand: unique symbol

/** A category id, e.g. `hospital`, `gas_station`, `fire_hydrant`. Branded — cast via {@link toPOICategoryID}. */
export type POICategoryID = string & { readonly [POICategoryIDBrand]: true }

/** Brand a raw string as a {@link POICategoryID}. Purely a compile-time assertion. */
export function toPOICategoryID(id: string): POICategoryID {
	return id as POICategoryID
}

/** Which namespace a category belongs to. */
export const CategorySource = {
	/** The Overture Places `taxonomy` snapshot (CDLA-Permissive-2.0). */
	Overture: "overture",
	/** Mailwoman's infrastructure extension — data lives only in build-local (ODbL) layers. */
	MailwomanInfra: "mailwoman-infra",
} as const
export type CategorySource = (typeof CategorySource)[keyof typeof CategorySource]

/** One category node. */
export interface CategoryRecord {
	id: POICategoryID
	/** Human-readable display label, e.g. `Gas station`. */
	label: string
	/** Ordered ancestry, top level first, ENDING with this category's own id. */
	hierarchy: POICategoryID[]
	/** Overture "basic category" display tier, when the snapshot provides one. */
	basicLabel: string | null
	source: CategorySource
}

/** One lexicon entry mapping a query phrase to a category. */
export interface SynonymEntry {
	/** The phrase as typed, lowercase, e.g. `drinking fountain`. */
	phrase: string
	categoryID: POICategoryID
	/**
	 * BCP-47 locale gate, same semantics as `@mailwoman/variant-aliases`: omitted = ungated
	 * (matches any locale at confidence 1.0); present = 1.0 on exact locale, 0.5 on language-only.
	 */
	locales?: string[]
}

/** The on-disk shape of `data/taxonomy.json`. */
export interface POITaxonomyTable {
	version: string
	/** Overture release the category snapshot was taken from; null until Plan 3 lands the full snapshot. */
	overtureRelease: string | null
	categories: CategoryRecord[]
	synonyms: SynonymEntry[]
}
```

- [ ] **Step 2: Write the seed data `poi-taxonomy/data/taxonomy.json`**

This is the hand-curated SEED (Plan 3 replaces `categories` with the full ~2,100-entry Overture snapshot and keeps the synonym table growing). It must cover every phrase used in Plan 2's fixtures and the operator's canonical examples.

```json
{
	"version": "0.1.0",
	"overtureRelease": null,
	"categories": [
		{
			"id": "hospital",
			"label": "Hospital",
			"hierarchy": ["health_and_medical", "hospital"],
			"basicLabel": "Hospital",
			"source": "overture"
		},
		{
			"id": "pharmacy",
			"label": "Pharmacy",
			"hierarchy": ["health_and_medical", "pharmacy"],
			"basicLabel": "Pharmacy",
			"source": "overture"
		},
		{
			"id": "restaurant",
			"label": "Restaurant",
			"hierarchy": ["eat_and_drink", "restaurant"],
			"basicLabel": "Restaurant",
			"source": "overture"
		},
		{
			"id": "cafe",
			"label": "Cafe",
			"hierarchy": ["eat_and_drink", "cafe"],
			"basicLabel": "Cafe",
			"source": "overture"
		},
		{
			"id": "fast_food_restaurant",
			"label": "Fast food restaurant",
			"hierarchy": ["eat_and_drink", "restaurant", "fast_food_restaurant"],
			"basicLabel": "Restaurant",
			"source": "overture"
		},
		{
			"id": "supermarket",
			"label": "Supermarket",
			"hierarchy": ["retail", "food_and_beverage_retail", "supermarket"],
			"basicLabel": "Supermarket",
			"source": "overture"
		},
		{
			"id": "gas_station",
			"label": "Gas station",
			"hierarchy": ["automotive", "gas_station"],
			"basicLabel": "Gas station",
			"source": "overture"
		},
		{
			"id": "hotel",
			"label": "Hotel",
			"hierarchy": ["accommodation", "hotel"],
			"basicLabel": "Hotel",
			"source": "overture"
		},
		{
			"id": "school",
			"label": "School",
			"hierarchy": ["education", "school"],
			"basicLabel": "School",
			"source": "overture"
		},
		{
			"id": "library",
			"label": "Library",
			"hierarchy": ["public_service_and_government", "library"],
			"basicLabel": "Library",
			"source": "overture"
		},
		{ "id": "park", "label": "Park", "hierarchy": ["active_life", "park"], "basicLabel": "Park", "source": "overture" },
		{
			"id": "trail",
			"label": "Trail",
			"hierarchy": ["active_life", "trail"],
			"basicLabel": "Trail",
			"source": "overture"
		},
		{
			"id": "atm",
			"label": "ATM",
			"hierarchy": ["financial_service", "atm"],
			"basicLabel": "ATM",
			"source": "overture"
		},
		{
			"id": "bank",
			"label": "Bank",
			"hierarchy": ["financial_service", "bank"],
			"basicLabel": "Bank",
			"source": "overture"
		},
		{
			"id": "post_office",
			"label": "Post office",
			"hierarchy": ["public_service_and_government", "post_office"],
			"basicLabel": "Post office",
			"source": "overture"
		},
		{
			"id": "police_station",
			"label": "Police station",
			"hierarchy": ["public_service_and_government", "police_station"],
			"basicLabel": "Police station",
			"source": "overture"
		},
		{
			"id": "fire_station",
			"label": "Fire station",
			"hierarchy": ["public_service_and_government", "fire_station"],
			"basicLabel": "Fire station",
			"source": "overture"
		},
		{
			"id": "fire_hydrant",
			"label": "Fire hydrant",
			"hierarchy": ["infrastructure", "fire_hydrant"],
			"basicLabel": null,
			"source": "mailwoman-infra"
		},
		{
			"id": "post_box",
			"label": "Post box",
			"hierarchy": ["infrastructure", "post_box"],
			"basicLabel": null,
			"source": "mailwoman-infra"
		},
		{
			"id": "drinking_water",
			"label": "Drinking water",
			"hierarchy": ["infrastructure", "drinking_water"],
			"basicLabel": null,
			"source": "mailwoman-infra"
		},
		{
			"id": "telecom_cabinet",
			"label": "Telecom cabinet",
			"hierarchy": ["infrastructure", "telecom_cabinet"],
			"basicLabel": null,
			"source": "mailwoman-infra"
		},
		{
			"id": "data_center",
			"label": "Data center",
			"hierarchy": ["infrastructure", "data_center"],
			"basicLabel": null,
			"source": "mailwoman-infra"
		},
		{
			"id": "power_substation",
			"label": "Power substation",
			"hierarchy": ["infrastructure", "power_substation"],
			"basicLabel": null,
			"source": "mailwoman-infra"
		}
	],
	"synonyms": [
		{ "phrase": "emergency room", "categoryID": "hospital" },
		{ "phrase": "er", "categoryID": "hospital", "locales": ["en-US"] },
		{ "phrase": "drugstore", "categoryID": "pharmacy", "locales": ["en-US"] },
		{ "phrase": "chemist", "categoryID": "pharmacy", "locales": ["en-GB", "en-AU", "en-NZ"] },
		{ "phrase": "coffee shop", "categoryID": "cafe" },
		{ "phrase": "coffee", "categoryID": "cafe" },
		{ "phrase": "café", "categoryID": "cafe" },
		{ "phrase": "fast food", "categoryID": "fast_food_restaurant" },
		{ "phrase": "grocery store", "categoryID": "supermarket", "locales": ["en-US"] },
		{ "phrase": "grocery", "categoryID": "supermarket" },
		{ "phrase": "petrol station", "categoryID": "gas_station", "locales": ["en-GB", "en-AU", "en-NZ", "en-ZA"] },
		{ "phrase": "fuel", "categoryID": "gas_station" },
		{ "phrase": "motel", "categoryID": "hotel" },
		{ "phrase": "bike trail", "categoryID": "trail" },
		{ "phrase": "biking trail", "categoryID": "trail" },
		{ "phrase": "biking trails", "categoryID": "trail" },
		{ "phrase": "cycling trail", "categoryID": "trail" },
		{ "phrase": "hiking trail", "categoryID": "trail" },
		{ "phrase": "cash machine", "categoryID": "atm", "locales": ["en-GB"] },
		{ "phrase": "fire hydrant", "categoryID": "fire_hydrant" },
		{ "phrase": "hydrant", "categoryID": "fire_hydrant" },
		{ "phrase": "mailbox", "categoryID": "post_box", "locales": ["en-US", "en-CA"] },
		{ "phrase": "post box", "categoryID": "post_box" },
		{ "phrase": "postbox", "categoryID": "post_box" },
		{ "phrase": "drinking fountain", "categoryID": "drinking_water" },
		{ "phrase": "water fountain", "categoryID": "drinking_water" },
		{ "phrase": "bubbler", "categoryID": "drinking_water", "locales": ["en-US", "en-AU"] },
		{ "phrase": "fiber hut", "categoryID": "telecom_cabinet" },
		{ "phrase": "fibre hut", "categoryID": "telecom_cabinet" },
		{ "phrase": "street cabinet", "categoryID": "telecom_cabinet" },
		{ "phrase": "datacenter", "categoryID": "data_center" },
		{ "phrase": "data center", "categoryID": "data_center" },
		{ "phrase": "data centre", "categoryID": "data_center" },
		{ "phrase": "substation", "categoryID": "power_substation" },
		{ "phrase": "electrical substation", "categoryID": "power_substation" }
	]
}
```

Caution from the spec: seed `hierarchy`/`basicLabel` values for `overture`-source rows are provisional until Plan 3 snapshots the real taxonomy — that's why `overtureRelease` is `null`. Do not "fix" ids to the old `categories` property's names.

- [ ] **Step 3: Compile check**

Run: `cd /home/lab/Projects/mailwoman-exotic-poi && yarn compile`
Expected: clean; `poi-taxonomy/out/types.js` + `.d.ts` exist.

- [ ] **Step 4: Commit**

```bash
cd /home/lab/Projects/mailwoman-exotic-poi
yarn oxfmt poi-taxonomy/types.ts poi-taxonomy/data/taxonomy.json
git add poi-taxonomy/types.ts poi-taxonomy/data/taxonomy.json
git commit -m "feat(poi-taxonomy): category/synonym types + curated seed table"
git log -1 --oneline
```

Expected: new commit hash.

---

### Task 6: Lookup API

**Files:**

- Create: `poi-taxonomy/lookup.ts`
- Create: `poi-taxonomy/index.ts`
- Test: `poi-taxonomy/lookup.test.ts`

**Interfaces:**

- Consumes: Task 5 types + data file.
- Produces: `lookupPOICategory(text: string, locale?: string): CategoryMatch[]`, `getPOICategory(id: string): CategoryRecord | undefined`, `getAllCategories(): ReadonlyArray<CategoryRecord>`, `requiresBuildLocalLayer(category: CategoryRecord): boolean`, `POI_TAXONOMY_VERSION: string`, `interface CategoryMatch { category: CategoryRecord; matchedPhrase: string; confidence: number }`. Plan 2's `scorePOIQuery` and Plan 3's builder consume these exact signatures.

- [ ] **Step 1: Write the failing test**

`poi-taxonomy/lookup.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { getAllCategories, getPOICategory, lookupPOICategory, requiresBuildLocalLayer } from "./lookup.ts"

describe("lookupPOICategory", () => {
	it("matches a category by its own id-phrase and label", () => {
		expect(lookupPOICategory("hospital")[0]?.category.id).toBe("hospital")
		expect(lookupPOICategory("Gas station")[0]?.category.id).toBe("gas_station")
	})

	it("matches synonyms case-insensitively", () => {
		const matches = lookupPOICategory("Drinking Fountain")
		expect(matches[0]?.category.id).toBe("drinking_water")
		expect(matches[0]?.matchedPhrase).toBe("drinking fountain")
	})

	it("maps infrastructure phrases and flags the build-local requirement", () => {
		const [match] = lookupPOICategory("fiber hut")
		expect(match?.category.id).toBe("telecom_cabinet")
		expect(requiresBuildLocalLayer(match!.category)).toBe(true)
		const [shipped] = lookupPOICategory("restaurant")
		expect(requiresBuildLocalLayer(shipped!.category)).toBe(false)
	})

	it("gates locale-restricted synonyms like variant-aliases does", () => {
		expect(lookupPOICategory("chemist", "en-GB")[0]?.confidence).toBe(1.0)
		expect(lookupPOICategory("chemist", "en-IE")[0]?.confidence).toBe(0.5)
		expect(lookupPOICategory("chemist", "fr-FR")).toEqual([])
		// Ungated synonyms match any locale at full confidence.
		expect(lookupPOICategory("datacenter", "fr-FR")[0]?.confidence).toBe(1.0)
	})

	it("returns [] for unknown phrases", () => {
		expect(lookupPOICategory("flux capacitor depot")).toEqual([])
	})
})

describe("taxonomy integrity", () => {
	it("every synonym points at an existing category, and hierarchies end with the category id", () => {
		for (const category of getAllCategories()) {
			expect(category.hierarchy.at(-1)).toBe(category.id)
		}
		// Walk the raw table through the public phrase surface: every phrase must resolve.
		for (const category of getAllCategories()) {
			expect(getPOICategory(category.id)).toBeDefined()
		}
	})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/lab/Projects/mailwoman-exotic-poi && yarn vitest run poi-taxonomy/lookup.test.ts`
Expected: FAIL — cannot resolve `./lookup.ts`.

- [ ] **Step 3: Write the implementation**

`poi-taxonomy/lookup.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Phrase → category lookup over `data/taxonomy.json`. Same loader + locale-gating shape as
 *   `@mailwoman/variant-aliases` (its slang table resolves INTO these category ids). Matching is
 *   exact-phrase over a lowercased index; n-gram extraction from longer queries is the kind
 *   classifier's job, not this package's.
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import type { CategoryRecord, POITaxonomyTable, SynonymEntry } from "./types.ts"

const moduleDir = import.meta.dirname

function loadTable(): POITaxonomyTable {
	const candidates = [
		resolve(moduleDir, "data/taxonomy.json"),
		resolve(moduleDir, "../data/taxonomy.json"),
		resolve(moduleDir, "../../poi-taxonomy/data/taxonomy.json"),
	]

	for (const path of candidates) {
		try {
			return JSON.parse(readFileSync(path, "utf8")) as POITaxonomyTable
		} catch {
			// try next
		}
	}
	throw new Error("poi-taxonomy: could not find data/taxonomy.json")
}

const TABLE = loadTable()

const BY_ID: ReadonlyMap<string, CategoryRecord> = new Map(TABLE.categories.map((c) => [c.id, c]))

interface PhraseEntry {
	category: CategoryRecord
	phrase: string
	locales?: string[]
}

/**
 * Lowercased phrase index. Sources, in insertion order: each category's id (underscores as
 * spaces), its label, then the synonym table. Multiple entries may share a phrase.
 */
const BY_PHRASE: ReadonlyMap<string, ReadonlyArray<PhraseEntry>> = (() => {
	const map = new Map<string, PhraseEntry[]>()

	const add = (phrase: string, entry: PhraseEntry) => {
		const key = phrase.toLowerCase()
		const existing = map.get(key) ?? []
		existing.push(entry)
		map.set(key, existing)
	}

	for (const category of TABLE.categories) {
		add(category.id.replaceAll("_", " "), { category, phrase: category.id.replaceAll("_", " ") })
		add(category.label, { category, phrase: category.label.toLowerCase() })
	}
	for (const synonym of TABLE.synonyms as SynonymEntry[]) {
		const category = BY_ID.get(synonym.categoryID)
		if (!category) {
			throw new Error(
				`poi-taxonomy: synonym ${JSON.stringify(synonym.phrase)} points at unknown category ${synonym.categoryID}`
			)
		}
		add(synonym.phrase, {
			category,
			phrase: synonym.phrase,
			...(synonym.locales ? { locales: synonym.locales } : {}),
		})
	}

	return map
})()

export interface CategoryMatch {
	category: CategoryRecord
	/** The lexicon phrase that matched (lowercased). */
	matchedPhrase: string
	/** 1.0 = ungated or exact-locale; 0.5 = language-only locale match. */
	confidence: number
}

/**
 * Exact-phrase category lookup. `locale` gates locale-restricted synonyms with the
 * variant-aliases semantics: exact locale 1.0, language-only 0.5, otherwise no match.
 * Ungated phrases always match at 1.0. Deduplicated by category (best confidence wins),
 * sorted by confidence descending.
 */
export function lookupPOICategory(text: string, locale?: string): CategoryMatch[] {
	const norm = text.trim().toLowerCase()

	if (!norm) return []

	const entries = BY_PHRASE.get(norm)

	if (!entries || entries.length === 0) return []

	const language = locale?.split(/[-_]/)[0]
	const best = new Map<string, CategoryMatch>()

	for (const entry of entries) {
		let confidence: number

		if (!entry.locales) {
			confidence = 1.0
		} else if (locale && entry.locales.includes(locale)) {
			confidence = 1.0
		} else if (language && entry.locales.some((l) => l.split(/[-_]/)[0] === language)) {
			confidence = 0.5
		} else {
			continue
		}

		const existing = best.get(entry.category.id)

		if (!existing || existing.confidence < confidence) {
			best.set(entry.category.id, { category: entry.category, matchedPhrase: entry.phrase, confidence })
		}
	}

	return [...best.values()].sort((a, b) => b.confidence - a.confidence)
}

/** Fetch a category by id. */
export function getPOICategory(id: string): CategoryRecord | undefined {
	return BY_ID.get(id)
}

/** Enumerate the full table (corpus synthesis, builders, docs). */
export function getAllCategories(): ReadonlyArray<CategoryRecord> {
	return TABLE.categories
}

/** True when the category's data exists only in ODbL sources — answering needs a build-local layer. */
export function requiresBuildLocalLayer(category: CategoryRecord): boolean {
	return category.source === "mailwoman-infra"
}

export const POI_TAXONOMY_VERSION = TABLE.version
```

`poi-taxonomy/index.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

export * from "./lookup.ts"
export * from "./types.ts"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/lab/Projects/mailwoman-exotic-poi && yarn vitest run poi-taxonomy/lookup.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Format and commit**

```bash
cd /home/lab/Projects/mailwoman-exotic-poi
yarn oxfmt poi-taxonomy/lookup.ts poi-taxonomy/index.ts poi-taxonomy/lookup.test.ts
git add poi-taxonomy/lookup.ts poi-taxonomy/index.ts poi-taxonomy/lookup.test.ts
git commit -m "feat(poi-taxonomy): phrase lookup API with locale gating + integrity checks"
git log -1 --oneline
```

Expected: new commit hash.

---

### Task 7: Whole-tree verification

**Files:** none new.

- [ ] **Step 1: Clean compile from a clean tree**

```bash
cd /home/lab/Projects/mailwoman-exotic-poi
yarn compile
```

Expected: zero tsc errors (stale-out/ hazards were rebuilt along the way; this is the final check).

- [ ] **Step 2: Run the affected test surface**

```bash
yarn vitest run core/layers/ poi-taxonomy/
```

Expected: 13 tests passing, 0 failures.

- [ ] **Step 3: Repo lint**

```bash
yarn lint
```

Expected: clean (oxlint + oxfmt --check pass). Fix anything it flags before proceeding.

- [ ] **Step 4: Verify the publish surface didn't drift**

Run: `git diff main --stat -- core/package.json` and confirm the only change is the `./layers` entry in both maps.
Expected: one hunk per map.

- [ ] **Step 5: Commit anything the linters touched, push the branch**

```bash
git status --short
git push -u origin feat/exotic-poi
```

Expected: clean status (or one lint-fix commit first), branch pushed.

---

## Execution notes for reviewers

- Task 4's `yarn install` is the only step that touches the lockfile; if it produces a larger-than-expected diff, stop and check you're on the worktree's yarn version (`yarn --version` should match `.yarnrc.yml`).
- The seed taxonomy's Overture-namespace hierarchies are provisional by design (spec §3.3): Plan 3's snapshot build is the correction mechanism. Reviewers should check synonym→id integrity (the test does) and NOT bikeshed category ancestry.
- Plan 2 (pipeline: `poi_query` kind + intent record + routing) and Plan 3 (poi.db builder + MCP server) are separate documents; nothing in this plan touches the runtime pipeline, so golden parses are byte-identical by construction.
