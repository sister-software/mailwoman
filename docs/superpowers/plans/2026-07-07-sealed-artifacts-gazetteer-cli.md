# Sealed Artifacts + Gazetteer CLI (PR A + PR B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mechanically enforce the read-only-artifact policy (`sealDatabase`/`openBuiltDatabase`) and fold the scattered WOF admin-gazetteer build (1 script + 4 post-build steps) into one turnkey, verified, self-documenting `mailwoman gazetteer build admin` command.

**Architecture:** A tiny sealing utility in `@mailwoman/core/utils`; the existing single-file `mailwoman/gazetteer-pipeline.ts` grows into a `gazetteer-pipeline/` module of unit-testable step functions (ingest → fold-overture → fold-geonames → freeze → enrich → fts → verify → seal); thin Pastel/Ink commands over it; a structural `verify` gate with a committed per-country node-census baseline (the #1026 lesson).

**Tech Stack:** TypeScript (Node 26 type-stripping for the module; TSX compile for Ink commands), `node:sqlite` `DatabaseSync`, Pastel file-based commands, vitest, DuckDB (`@duckdb/node-api`, lazy-optional) for the Overture S3 pull.

**Spec:** `docs/superpowers/specs/2026-07-07-scripts-cleanup-gazetteer-cli-design.md`. This plan implements PR A (Tasks 1–2) and PR B (Tasks 3–16). **PR C (the augment-script archaeology + remaining builders/diagnostics sweep) is planned separately after PR B lands** — its work is characterized _with_ Task 11's census tooling.

## Global Constraints

- Every DB artifact a builder produces is sealed `0o444` at the end; writable staging is only ever `<out>.ingest`-style temp paths. Never mutate a shipped DB in place (build → verify → swap).
- Kysely for DDL where tables are created (existing `unified-schema.ts` already complies); hot positional INSERT loops stay raw (`AGENTS.md` "Database / inline SQL").
- Acronym casing: whole camelCase components (`buildFTS`, `ingestWOF`, `foldGeoNames` — note GeoNames is CamelCase already, keep as `foldGeonames` to match the existing `foldGeonamesIntoAdmin`/`ingestGeonamesAliases` family; do NOT half-rename the family).
- No `npx tsx`; scripts run with bare `node` (type-stripping). Ink commands need `yarn compile` first; run compiled CLI as `node mailwoman/out/cli.js`.
- Lint/format: `yarn oxlint <paths>` + `yarn oxfmt <paths>` before each commit. `yarn typecheck:scripts` must stay green.
- Commits reference the tracking issue for this cleanup; end commit messages with the standard co-author trailer.
- Data root paths go through `mailwomanDataRoot()` / `dataRootPath()` — never hardcode `/mnt/playpen/...` in shipped code (plan test fixtures use temp dirs).
- All work on a branch `feat/gazetteer-cli-sealed-artifacts` off current `main`.

---

### Task 1: `sealDatabase` / `openBuiltDatabase` in `@mailwoman/core/utils` (PR A)

**Files:**

- Create: `core/utils/sealed-db.ts`
- Create: `core/utils/sealed-db.test.ts`
- Modify: `core/utils/index.ts` (add `export * from "./sealed-db.js"`)

**Interfaces:**

- Produces: `sealDatabase(path: string): void`, `openBuiltDatabase(path: string, opts?: { write?: boolean }): DatabaseSync`, `class SealedArtifactError extends Error`, `isSealed(path: string): boolean`. Later tasks import these from `@mailwoman/core/utils`.

- [ ] **Step 1: Write the failing test**

```ts
// core/utils/sealed-db.test.ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */
import { mkdtempSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { describe, expect, it } from "vitest"

import { isSealed, openBuiltDatabase, SealedArtifactError, sealDatabase } from "./sealed-db.js"

function makeDB(): string {
	const dir = mkdtempSync(join(tmpdir(), "sealed-db-"))
	const path = join(dir, "artifact.db")
	const db = new DatabaseSync(path)
	db.exec("PRAGMA journal_mode = WAL")
	db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
	db.exec("INSERT INTO t (v) VALUES ('x')")
	db.close()

	return path
}

describe("sealDatabase", () => {
	it("chmods the file 0444, switches journal_mode to delete, and removes sidecars", () => {
		const path = makeDB()
		sealDatabase(path)
		expect(statSync(path).mode & 0o777).toBe(0o444)
		expect(isSealed(path)).toBe(true)
		const db = new DatabaseSync(path, { readOnly: true })
		expect((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("delete")
		db.close()
	})
})

describe("openBuiltDatabase", () => {
	it("opens a sealed artifact read-only by default", () => {
		const path = makeDB()
		sealDatabase(path)
		const db = openBuiltDatabase(path)
		expect((db.prepare("SELECT v FROM t").get() as { v: string }).v).toBe("x")
		db.close()
	})

	it("throws SealedArtifactError (naming the rebuild command) on a write open of a sealed artifact", () => {
		const path = makeDB()
		sealDatabase(path)
		expect(() => openBuiltDatabase(path, { write: true })).toThrowError(SealedArtifactError)
		expect(() => openBuiltDatabase(path, { write: true })).toThrowError(/sealed read-only artifact/)
		expect(() => openBuiltDatabase(path, { write: true })).toThrowError(/gazetteer build/)
	})

	it("allows a write open of an UNsealed database (builder staging)", () => {
		const path = makeDB()
		const db = openBuiltDatabase(path, { write: true })
		db.exec("INSERT INTO t (v) VALUES ('y')")
		db.close()
	})
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn vitest run core/utils/sealed-db.test.ts`
Expected: FAIL — `Cannot find module './sealed-db.js'`

- [ ] **Step 3: Write the implementation**

```ts
// core/utils/sealed-db.ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The sealed-artifact invariant: every SQLite DB a build produces is a READ-ONLY asset. `sealDatabase`
 *   is the last step of every builder — checkpoint, freeze the journal, chmod 0444. `openBuiltDatabase`
 *   is how anything opens a data artifact; a write-mode open of a sealed file throws a NAMED error
 *   pointing at the rebuild command instead of a cryptic SQLITE_READONLY. Unsealing is deliberate and
 *   manual (`chmod u+w`), never programmatic — rebuild, don't mutate.
 */
import { chmodSync, existsSync, statSync, unlinkSync } from "node:fs"
import { basename } from "node:path"
import { DatabaseSync } from "node:sqlite"

/** A write-mode open was attempted on a sealed (0444) data artifact. */
export class SealedArtifactError extends Error {
	constructor(path: string) {
		super(
			`${basename(path)} is a sealed read-only artifact — rebuild it via \`mailwoman gazetteer build …\`, ` +
				`don't mutate it. (Deliberate unseal: chmod u+w — but prefer a rebuild.)`
		)
		this.name = "SealedArtifactError"
	}
}

/** True when the artifact exists and carries no write bits (the sealed state `sealDatabase` leaves). */
export function isSealed(path: string): boolean {
	return existsSync(path) && (statSync(path).mode & 0o222) === 0
}

/**
 * Finalize a built DB: WAL-checkpoint → `journal_mode = DELETE` → remove `-wal`/`-shm` sidecars →
 * `chmod 0o444`. Idempotent. Throws if the checkpoint cannot complete (another writer holds the DB).
 */
export function sealDatabase(path: string): void {
	// A previously sealed artifact needs the write bit back for the journal-mode switch.
	if (isSealed(path)) chmodSync(path, 0o644)
	const db = new DatabaseSync(path)
	const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number }

	if (checkpoint.busy !== 0) {
		db.close()
		throw new Error(`sealDatabase: WAL checkpoint busy on ${path} — close all writers first`)
	}
	const mode = db.prepare("PRAGMA journal_mode = DELETE").get() as { journal_mode: string }
	db.close()

	if (mode.journal_mode !== "delete") {
		throw new Error(`sealDatabase: journal_mode switch failed on ${path} (still ${mode.journal_mode})`)
	}

	for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
		if (existsSync(sidecar)) unlinkSync(sidecar)
	}
	chmodSync(path, 0o444)
}

/**
 * Open a data artifact. Read-only by default. `write: true` is for builders working on UNsealed
 * staging — against a sealed artifact it throws {@link SealedArtifactError}.
 */
export function openBuiltDatabase(path: string, opts: { write?: boolean } = {}): DatabaseSync {
	if (opts.write) {
		if (isSealed(path)) throw new SealedArtifactError(path)

		return new DatabaseSync(path)
	}

	return new DatabaseSync(path, { readOnly: true })
}
```

- [ ] **Step 4: Export from the utils barrel**

In `core/utils/index.ts` add (alongside the existing re-exports):

```ts
export * from "./sealed-db.js"
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `yarn vitest run core/utils/sealed-db.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 6: Lint, format, commit**

```bash
yarn oxfmt core/utils/sealed-db.ts core/utils/sealed-db.test.ts core/utils/index.ts
yarn oxlint core/utils
git add core/utils/sealed-db.ts core/utils/sealed-db.test.ts core/utils/index.ts
git commit -m "feat(core): sealDatabase/openBuiltDatabase — the sealed read-only artifact invariant"
```

---

### Task 2: Retrofit sealing into the existing builders (PR A)

**Files:**

- Modify: `mailwoman/gazetteer-pipeline.ts` — `buildCandidate` seals its output
- Modify: `resolver-wof-sqlite/build-slim.ts` — the slim builder seals its output
- Modify: `scripts/build-unified-wof.ts` — seal after `VACUUM INTO` (this script is deleted in Task 15; sealing it now closes the window until then)
- Modify: `scripts/AGENTS.md` — add the invariant one-liner

**Interfaces:**

- Consumes: `sealDatabase` from `@mailwoman/core/utils` (Task 1).

- [ ] **Step 1: Seal in `buildCandidate`** — in `mailwoman/gazetteer-pipeline.ts`, import `sealDatabase` from `@mailwoman/core/utils`; at the end of `buildCandidate` (after the underlying build returns, before the `return`), add `sealDatabase(opts.out)`.
- [ ] **Step 2: Seal in `build-slim.ts`** — import `sealDatabase` from `@mailwoman/core/utils`; call it on the output path as the final step after the output DB `close()`.
- [ ] **Step 3: Seal in `build-unified-wof.ts`** — after the frozen-artifact verification block (the `frozenMode` check near the end), add `sealDatabase(outputPath)` and a `console.error("  sealed 0444")`.
- [ ] **Step 4: Policy line in `scripts/AGENTS.md`** — append to the Addendum: `- Every built SQLite DB is SEALED read-only (chmod 0444) by sealDatabase (@mailwoman/core/utils). Never reopen a shipped DB read-write — rebuild it. openBuiltDatabase enforces this with a named error.`
- [ ] **Step 5: Verify** — Run: `yarn typecheck:scripts && npx tsc -b core mailwoman resolver-wof-sqlite && yarn vitest run core/utils/sealed-db.test.ts mailwoman/geocode-core.test.ts`
      Expected: exit 0, tests pass.
- [ ] **Step 6: Commit**

```bash
yarn oxfmt mailwoman/gazetteer-pipeline.ts resolver-wof-sqlite/build-slim.ts scripts/build-unified-wof.ts
git add -u mailwoman/gazetteer-pipeline.ts resolver-wof-sqlite/build-slim.ts scripts/build-unified-wof.ts scripts/AGENTS.md
git commit -m "feat: seal every builder's output 0444 (buildCandidate, build-slim, build-unified-wof)"
```

_(PR A can be cut here if the operator wants the invariant shipped independently.)_

---

### Task 3: `gazetteer-pipeline.ts` → `gazetteer-pipeline/` module (PR B)

**Files:**

- Move: `mailwoman/gazetteer-pipeline.ts` → `mailwoman/gazetteer-pipeline/index.ts`
- Modify: every importer — `git grep -l 'gazetteer-pipeline.js' mailwoman/` (the `commands/gazetteer/*.tsx` files import `../../gazetteer-pipeline.js` → becomes `../../gazetteer-pipeline/index.js`)
- Modify: `mailwoman/package.json` — if an exports-map entry names `./out/gazetteer-pipeline.js`, update it to `./out/gazetteer-pipeline/index.js` (check first; add nothing new if absent)

**Interfaces:**

- Produces: the module directory later tasks add files into. All existing exports (`buildCandidate`, `foldGeonamesIntoAdmin`, `DEFAULT_FOLD_COUNTRIES`, `promoteCandidate`, `publishGazetteer`, `resolvePostcodeShards`, `wofDir`, …) unchanged, now via `gazetteer-pipeline/index.js`.

- [ ] **Step 1: Move** — `git mv mailwoman/gazetteer-pipeline.ts mailwoman/gazetteer-pipeline/index.ts`
- [ ] **Step 2: Fix importers** — `rg -l "gazetteer-pipeline.js" mailwoman | xargs sed -i 's#gazetteer-pipeline.js#gazetteer-pipeline/index.js#g'`; then inspect `git diff` (expect only import-path lines).
- [ ] **Step 3: Verify** — Run: `npx tsc -b mailwoman && yarn vitest run mailwoman` — exit 0, all mailwoman-workspace tests pass.
- [ ] **Step 4: Commit** — `git add -A mailwoman && git commit -m "refactor: gazetteer-pipeline.ts becomes the gazetteer-pipeline/ module root"`

---

### Task 4: `gazetteer-pipeline/defaults.ts` — the canonical recipe as code

**Files:**

- Create: `mailwoman/gazetteer-pipeline/defaults.ts`
- Create: `mailwoman/gazetteer-pipeline/defaults.test.ts`
- Modify: `mailwoman/gazetteer-pipeline/index.ts` (add `export * from "./defaults.js"`)

**Interfaces:**

- Produces: `DEFAULT_WOF_PRIORITY_COUNTRIES: readonly string[]` (11), `DEFAULT_OVERTURE_COUNTRIES: readonly string[]` (86), `DEFAULT_GEONAMES_COUNTRIES: readonly string[]` (161), `DEFAULT_OVERTURE_RELEASE = "2026-06-17.0"`, `DEFAULT_ADMIN_STAGING_SUFFIX = ".REBUILD.db"`.

- [ ] **Step 1: Write the failing test**

```ts
// mailwoman/gazetteer-pipeline/defaults.test.ts
import { expect, test } from "vitest"

import { DEFAULT_GEONAMES_COUNTRIES, DEFAULT_OVERTURE_COUNTRIES, DEFAULT_WOF_PRIORITY_COUNTRIES } from "./defaults.js"

test("the canonical coverage recipe holds its reconstructed shape (see #1015/#1021)", () => {
	expect(DEFAULT_WOF_PRIORITY_COUNTRIES).toHaveLength(11)
	expect(DEFAULT_OVERTURE_COUNTRIES).toHaveLength(86)
	expect(DEFAULT_GEONAMES_COUNTRIES).toHaveLength(161)
	// no duplicates, all ISO-2 uppercase
	for (const list of [DEFAULT_WOF_PRIORITY_COUNTRIES, DEFAULT_OVERTURE_COUNTRIES, DEFAULT_GEONAMES_COUNTRIES]) {
		expect(new Set(list).size).toBe(list.length)
		for (const cc of list) expect(cc).toMatch(/^[A-Z]{2}$/)
	}
	expect(DEFAULT_OVERTURE_COUNTRIES).toContain("BE") // the #1015 case
	expect(DEFAULT_GEONAMES_COUNTRIES).toContain("GE") // the #1023/#1026 case
})
```

- [ ] **Step 2: Run to verify it fails** — `yarn vitest run mailwoman/gazetteer-pipeline/defaults.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** — create `defaults.ts` with a header docstring ("The canonical admin-gazetteer coverage recipe — the durable replacement for reconstruct-from-artifact (#1015) and the lagging manifest; `wof-build-manifest.json` is now a build LOG, not a recipe") and the exact lists:

```ts
export const DEFAULT_WOF_PRIORITY_COUNTRIES = [
	"CN",
	"DE",
	"ES",
	"FR",
	"GB",
	"IT",
	"JP",
	"KR",
	"NL",
	"TW",
	"US",
] as const

export const DEFAULT_OVERTURE_COUNTRIES = [
	"AE",
	"AO",
	"AR",
	"AT",
	"AU",
	"BD",
	"BE",
	"BG",
	"BH",
	"BO",
	"BR",
	"BY",
	"CA",
	"CH",
	"CI",
	"CL",
	"CM",
	"CO",
	"CR",
	"CU",
	"CZ",
	"DK",
	"DO",
	"DZ",
	"EC",
	"EE",
	"EG",
	"ET",
	"FI",
	"GH",
	"GR",
	"GT",
	"HR",
	"HU",
	"ID",
	"IE",
	"IL",
	"IN",
	"IQ",
	"IR",
	"IS",
	"JO",
	"KE",
	"KH",
	"KW",
	"KZ",
	"LB",
	"LK",
	"LT",
	"LU",
	"LV",
	"MA",
	"MM",
	"MX",
	"MY",
	"NG",
	"NO",
	"NP",
	"NZ",
	"OM",
	"PA",
	"PE",
	"PH",
	"PK",
	"PL",
	"PT",
	"QA",
	"RO",
	"RS",
	"RU",
	"SA",
	"SE",
	"SG",
	"SI",
	"SK",
	"SN",
	"TH",
	"TN",
	"TR",
	"TZ",
	"UA",
	"UG",
	"UY",
	"VE",
	"VN",
	"ZA",
] as const

export const DEFAULT_GEONAMES_COUNTRIES = [
	"AD",
	"AF",
	"AG",
	"AI",
	"AL",
	"AM",
	"AS",
	"AT",
	"AW",
	"AX",
	"AZ",
	"BA",
	"BB",
	"BE",
	"BF",
	"BI",
	"BJ",
	"BL",
	"BM",
	"BN",
	"BQ",
	"BS",
	"BT",
	"BW",
	"BZ",
	"CC",
	"CD",
	"CF",
	"CG",
	"CK",
	"CV",
	"CW",
	"CX",
	"CY",
	"CZ",
	"DJ",
	"DK",
	"DM",
	"EH",
	"ER",
	"FI",
	"FJ",
	"FK",
	"FM",
	"FO",
	"GA",
	"GD",
	"GE",
	"GF",
	"GG",
	"GI",
	"GL",
	"GM",
	"GN",
	"GP",
	"GQ",
	"GS",
	"GU",
	"GW",
	"GY",
	"HK",
	"HN",
	"HR",
	"HT",
	"IM",
	"JE",
	"JM",
	"KG",
	"KI",
	"KM",
	"KN",
	"KP",
	"KY",
	"LA",
	"LC",
	"LI",
	"LR",
	"LS",
	"LT",
	"LU",
	"LV",
	"LY",
	"MC",
	"MD",
	"ME",
	"MF",
	"MG",
	"MH",
	"MK",
	"ML",
	"MN",
	"MO",
	"MP",
	"MQ",
	"MR",
	"MS",
	"MT",
	"MU",
	"MV",
	"MW",
	"MZ",
	"NA",
	"NC",
	"NE",
	"NF",
	"NI",
	"NO",
	"NR",
	"NU",
	"PF",
	"PG",
	"PL",
	"PM",
	"PN",
	"PR",
	"PS",
	"PW",
	"PY",
	"RE",
	"RW",
	"SB",
	"SC",
	"SD",
	"SH",
	"SI",
	"SJ",
	"SK",
	"SL",
	"SM",
	"SO",
	"SR",
	"SS",
	"ST",
	"SV",
	"SX",
	"SY",
	"SZ",
	"TC",
	"TD",
	"TF",
	"TG",
	"TJ",
	"TL",
	"TM",
	"TO",
	"TT",
	"TV",
	"UZ",
	"VA",
	"VC",
	"VG",
	"VI",
	"VU",
	"WF",
	"WS",
	"XK",
	"YE",
	"YT",
	"ZM",
	"ZW",
] as const

export const DEFAULT_OVERTURE_RELEASE = "2026-06-17.0"
export const DEFAULT_ADMIN_STAGING_SUFFIX = ".REBUILD.db"
```

- [ ] **Step 4: Run to verify it passes** — `yarn vitest run mailwoman/gazetteer-pipeline/defaults.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git add mailwoman/gazetteer-pipeline/ && git commit -m "feat(gazetteer): the canonical coverage recipe as code defaults (86 overture / 161 geonames / 11 wof)"`

---

### Task 5: `admin/fold-overture.ts` — move `ingestOvertureDivisions`

**Files:**

- Create: `mailwoman/gazetteer-pipeline/admin/fold-overture.ts`
- Modify: `scripts/build-unified-wof.ts` — delete the moved function + `OVERTURE_ID_BASE` + `OVERTURE_DIVISION_SUBTYPES`; import them from the module instead

**Interfaces:**

- Produces: `ingestOvertureDivisions(db: DatabaseSync, countries: readonly string[], release: string, idBase?: number): Promise<number>` and `export const OVERTURE_ID_BASE = 8_000_000_000_000` — exact behavior of the current script function (division_area bbox join + country subtype, #1021).

- [ ] **Step 1: Move** — cut the entire `ingestOvertureDivisions` function, `OVERTURE_ID_BASE`, and `OVERTURE_DIVISION_SUBTYPES` from `scripts/build-unified-wof.ts` into the new file verbatim (keep every comment). Add the imports the body needs (`DatabaseSync` type, `DuckDBInstance` via the same lazy `await import("@duckdb/node-api")` pattern used by `overture-ingest.tsx` — convert the top-level import to a lazy one inside the function so importing the pipeline module never faults without DuckDB installed).
- [ ] **Step 2: Re-point the script** — in `scripts/build-unified-wof.ts`: `import { ingestOvertureDivisions, OVERTURE_ID_BASE } from "../mailwoman/gazetteer-pipeline/admin/fold-overture.ts"` (scripts import TS directly under type-stripping; check the existing cross-workspace import style in `scripts/` — e.g. `reverse-eu-panel.ts` imports `@mailwoman/resolver-wof-sqlite` — and prefer the package-path form `mailwoman/gazetteer-pipeline/admin/fold-overture.js` if `scripts/tsconfig.json` resolves it; use whichever compiles).
- [ ] **Step 3: Verify** — `yarn typecheck:scripts && npx tsc -b mailwoman` → exit 0.
- [ ] **Step 4: Commit** — `git add -A && git commit -m "refactor(gazetteer): ingestOvertureDivisions moves into gazetteer-pipeline/admin/fold-overture"`

---

### Task 6: `admin/ingest-wof.ts` — extract the geojson ingest (Phases 1–2)

**Files:**

- Create: `mailwoman/gazetteer-pipeline/admin/ingest-wof.ts`
- Modify: `scripts/build-unified-wof.ts` — its `main()` calls the extracted function

**Interfaces:**

- Produces:

```ts
export interface IngestWOFOptions {
	dataDir: string
	/** Placetype allowlist. Default ADMIN_PLACETYPES (moved here). */
	placetypes?: ReadonlySet<string>
	concurrency?: number // default 64
	batchCommitSize?: number // default 500
	onProgress?: (processed: number, total: number) => void
}
export interface IngestWOFResult {
	filesFound: number
	placesIngested: number
	skipped: number
}
export function ingestWOF(db: DatabaseSync, opts: IngestWOFOptions): Promise<IngestWOFResult>
```

- [ ] **Step 1: Extract** — move from `scripts/build-unified-wof.ts` into `ingest-wof.ts`: `ADMIN_PLACETYPES`, `parseFeature`, the FastGlob enumeration **including the postcode-repo ignore** (`**/whosonfirst-data-postalcode-*/**` unless `placetypes` has `postalcode` — #1021 perf fix), and the Phase-2 parallel-read/single-writer loop (`asyncParallelIterator` + the prepared spr/names/concordances/population inserts). The caller creates/owns `db` (staging `.ingest`, WAL pragmas) — the function only enumerates + ingests.
- [ ] **Step 2: Re-point the script** — `main()` keeps its staging-DB creation + pragmas, then calls `await ingestWOF(db, { dataDir, placetypes: activePlacetypes, concurrency, batchCommitSize })`.
- [ ] **Step 3: Verify** — `yarn typecheck:scripts && npx tsc -b mailwoman` → exit 0.
- [ ] **Step 4: Commit** — `git add -A && git commit -m "refactor(gazetteer): WOF geojson ingest extracted to gazetteer-pipeline/admin/ingest-wof"`

---

### Task 7: `admin/fold-geonames.ts` — wrap the GeoNames folds

**Files:**

- Create: `mailwoman/gazetteer-pipeline/admin/fold-geonames.ts`
- Modify: `scripts/build-unified-wof.ts` — Phases 2c/2d call the wrapper

**Interfaces:**

- Produces:

```ts
export interface FoldGeonamesOptions {
	countries: readonly string[]
	geonamesDir?: string // default dataRootPath("geonames") — NOTE: current script hardcodes the playpen path; fix to dataRootPath here
	alternateDir?: string // default dataRootPath("geonames-alternate")
	postalCountries?: readonly string[]
	postalDir?: string // default dataRootPath("geonames-postal")
}
export interface FoldGeonamesResult {
	placesIngested: number
	postalIngested: number
}
export function foldGeonames(db: DatabaseSync, opts: FoldGeonamesOptions): FoldGeonamesResult
```

- [ ] **Step 1: Implement** — thin composition over the existing `ingestGeonamesAliases` + `ingestGeonamesPostal` (`@mailwoman/resolver-wof-sqlite`), defaults via `dataRootPath` (this removes `DEFAULT_GEONAMES_DIR`'s hardcoded `/mnt/playpen/...` — the `AGENTS.md` data-root rule).
- [ ] **Step 2: Re-point the script**, delete its three `DEFAULT_GEONAMES*` constants.
- [ ] **Step 3: Verify** — `yarn typecheck:scripts && npx tsc -b mailwoman` → exit 0.
- [ ] **Step 4: Commit** — `git commit -am "refactor(gazetteer): GeoNames folds wrapped in gazetteer-pipeline/admin/fold-geonames (data-root defaults)"`

---

### Task 8: `admin/freeze.ts` — closure, backfill, roles, indexes, VACUUM

**Files:**

- Create: `mailwoman/gazetteer-pipeline/admin/freeze.ts`
- Create: `mailwoman/gazetteer-pipeline/admin/freeze.test.ts`
- Modify: `scripts/build-unified-wof.ts` — Phase 3 calls `freezeAdmin`

**Interfaces:**

- Consumes: `backfillAncestorsFromHierarchy`/`discoverAdminDataRoots` (`@mailwoman/resolver-wof-sqlite/ancestry-backfill`), `populateAncestors`/`createUnifiedIndexes` (`unified-schema`), `buildCoincidentRoles`, `OVERTURE_ID_BASE` (Task 5).
- Produces:

```ts
export interface FreezeAdminOptions {
	/** Repos root for the wof:hierarchy −4 backfill. Omit ONLY in fixture tests. */
	dataDir?: string
	onPhase?: (phase: string, detail?: string) => void
}
export interface FreezeAdminResult {
	ancestorRows: number
	backfillPlacesFixed: number
	coincidentRoles: number
}
/** Runs IN PLACE on the staging db; caller VACUUMs INTO the final path afterwards. */
export function freezeAdmin(db: DatabaseSync, opts?: FreezeAdminOptions): Promise<FreezeAdminResult>
```

Exact internal order (each a `onPhase` callback): `wal_checkpoint(TRUNCATE)` (throw on busy) → `journal_mode=DELETE` (throw on failure) → `populateAncestors` → `CREATE INDEX IF NOT EXISTS ancestors_by_id ON ancestors(id)` (**before** the backfill — the #1015 stall fix) → `backfillAncestorsFromHierarchy(db, discoverAdminDataRoots(dataDir), { maxId: OVERTURE_ID_BASE })` when `dataDir` given → `buildCoincidentRoles` → `createUnifiedIndexes` → `ANALYZE; PRAGMA optimize` → `PRAGMA integrity_check` (throw unless `ok`).

- [ ] **Step 1: Write the failing test** — fixture: in-memory `createUnifiedSchema` DB with 3 spr rows (country←region←locality via parent_id); assert `freezeAdmin` returns `ancestorRows > 0`, the locality has 2 ancestors in `ancestors`, and `sqlite_master` contains `ancestors_by_id`:

```ts
// mailwoman/gazetteer-pipeline/admin/freeze.test.ts
import { DatabaseSync } from "node:sqlite"
import { expect, test } from "vitest"
import { createUnifiedSchema } from "@mailwoman/resolver-wof-sqlite/unified-schema"
import { freezeAdmin } from "./freeze.js"

test("freezeAdmin builds the ancestors closure, the ancestors_by_id index, and passes integrity", async () => {
	const db = new DatabaseSync(":memory:")
	await createUnifiedSchema(db)
	const ins = db.prepare(
		"INSERT INTO spr (id, parent_id, name, placetype, country, latitude, longitude, is_current, is_deprecated, is_ceased, is_superseded, is_superseding, lastmodified) VALUES (?, ?, ?, ?, ?, 0, 0, 1, 0, 0, 0, 0, 0)"
	)
	ins.run(1, -1, "Testland", "country", "TL")
	ins.run(2, 1, "Region", "region", "TL")
	ins.run(3, 2, "Town", "locality", "TL")
	const r = await freezeAdmin(db) // no dataDir → backfill skipped (fixture has no geojson)
	expect(r.ancestorRows).toBeGreaterThan(0)
	expect(
		(db.prepare("SELECT COUNT(*) n FROM ancestors WHERE id = 3 AND ancestor_id != 3").get() as { n: number }).n
	).toBe(2)
	expect(
		db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'ancestors_by_id'").get()
	).toBeTruthy()
	db.close()
})
```

- [ ] **Step 2: Run to verify it fails** — module not found.
- [ ] **Step 3: Implement** by moving the Phase-3 block out of the script (minus `VACUUM INTO` + the frozen-artifact re-verify, which stay with the caller/orchestrator). Note: skip the `wal_checkpoint`/`journal_mode` steps when `db` is `:memory:` (PRAGMA returns `memory`) so the fixture runs.
- [ ] **Step 4: Run to verify it passes**, plus `yarn typecheck:scripts && npx tsc -b mailwoman`.
- [ ] **Step 5: Commit** — `git commit -am "refactor(gazetteer): freeze phase extracted (closure → index → −4 backfill → roles → indexes → integrity)"`

---

### Task 9: `admin/enrich.ts` — region abbrevs + `place_abbr` (the steps #1015 missed)

**Files:**

- Create: `mailwoman/gazetteer-pipeline/admin/enrich.ts`
- Create: `mailwoman/gazetteer-pipeline/admin/enrich.test.ts`
- (Deletion of `scripts/add-region-abbrevs.ts` happens in Task 15.)

**Interfaces:**

- Produces:

```ts
export interface EnrichAdminOptions {
	/** chromium-i18n ssl-address spec dir. Default: the core/data path add-region-abbrevs.ts uses today. */
	specsDir?: string
}
export interface EnrichAdminResult {
	abbrevNamesAdded: number
	abbrevCountries: number
	placeAbbrRows: number
}
export function enrichAdmin(db: DatabaseSync, opts?: EnrichAdminOptions): EnrichAdminResult
```

- [ ] **Step 1: Write the failing test** — fixture DB (unified schema) with one `region` row (`name: "Vermont"`, `country: "US"`); run `enrichAdmin` pointing `specsDir` at the real `core/data/chromium-i18n/ssl-address` (repo-relative — resolve via the same helper `add-region-abbrevs.ts` uses); assert a `names` row `(name='VT', language='abbr')` exists and `place_abbr` has 1 row mapping to Vermont's id.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — port `scripts/add-region-abbrevs.ts`'s body (DELETE-then-INSERT idempotency, `sub_keys`↔`sub_names` matching) as `addRegionAbbrevs(db, specsDir)`, then the `place_abbr` build verbatim from `resolver-wof-sqlite/build-slim.ts:210-213`:

```ts
db.exec("DROP TABLE IF EXISTS place_abbr")
db.exec("CREATE TABLE place_abbr (id INTEGER NOT NULL, abbr TEXT NOT NULL)")
db.exec("INSERT INTO place_abbr (id, abbr) SELECT id, name FROM names WHERE language = 'abbr'")
db.exec("CREATE INDEX place_abbr_by_abbr ON place_abbr (abbr COLLATE NOCASE)")
db.exec("CREATE INDEX place_abbr_by_id ON place_abbr (id)")
```

`enrichAdmin` = `addRegionAbbrevs` + `buildPlaceAbbr`, returning the counts. (place_abbr was missing from the admin runbook entirely — found the hard way in the #1015 swap.)

- [ ] **Step 4: Run to verify it passes**, `npx tsc -b mailwoman`.
- [ ] **Step 5: Commit** — `git commit -am "feat(gazetteer): enrich step — region abbrevs + place_abbr, no longer skippable"`

---

### Task 10: `gazetteer-pipeline/fts.ts` — thin FTS wrapper

**Files:**

- Create: `mailwoman/gazetteer-pipeline/fts.ts`

**Interfaces:**

- Consumes: `buildPlaceSearchFTS(db, { drop, onProgress })` from `@mailwoman/resolver-wof-sqlite/fts`.
- Produces: `buildFTS(db: DatabaseSync, opts?: { drop?: boolean; onProgress?: (phase: string, detail?: string) => void }): { ftsRows: number }` — passes through, returns the row count the underlying result reports.

- [ ] **Step 1: Implement** (no separate test — the wrapper is 10 lines over an already-tested builder; Task 16's E2E covers it).
- [ ] **Step 2: Verify** — `npx tsc -b mailwoman`.
- [ ] **Step 3: Commit** — `git commit -am "feat(gazetteer): buildFTS wrapper (place_search + place_bbox)"`

---

### Task 11: `verify.ts` + the committed census baseline — the structural gate

**Files:**

- Create: `mailwoman/gazetteer-pipeline/verify.ts`
- Create: `mailwoman/gazetteer-pipeline/verify.test.ts`
- Create: `mailwoman/gazetteer-pipeline/verify-baseline.json`

**Interfaces:**

- Produces:

```ts
export interface VerifyCheckResult {
	check: string
	ok: boolean
	detail: string
}
export interface VerifyResult {
	ok: boolean
	checks: VerifyCheckResult[]
}
export interface VerifyBaseline {
	/** ISO2 → required node placetypes. A listed country MUST have ≥1 spr row of each placetype. */
	requiredNodes: Record<string, ReadonlyArray<"country" | "region">>
	minRows: number
	minCountries: number
}
export function verifyAdmin(db: DatabaseSync, baseline: VerifyBaseline): VerifyResult
export function loadDefaultBaseline(): VerifyBaseline // reads verify-baseline.json next to the module
export const REVERSE_PANEL_CASES: ReadonlyArray<readonly [label: string, lat: number, lon: number, iso2: string]>
export function verifyReversePanel(adminDBPath: string): Promise<VerifyResult> // wraps WOFReverseGeocoder over REVERSE_PANEL_CASES
```

**Checks in `verifyAdmin`** (each one `VerifyCheckResult`):

1. `node-census` — for every `baseline.requiredNodes` entry, the required placetypes exist (`SELECT COUNT(*) FROM spr WHERE country=? AND placetype=? AND is_current!=0`). Detail lists every missing `(country, placetype)`. **This is the #1026 catch.**
2. `coverage-floor` — `COUNT(*) >= minRows` and `COUNT(DISTINCT country) >= minCountries`.
3. `region-abbrevs` — `names WHERE language='abbr'` count > 0 AND the `VT`→Vermont join resolves (`SELECT s.name FROM place_abbr a JOIN spr s ON s.id=a.id WHERE a.abbr='VT' AND s.country='US'` returns `Vermont`).
4. `place-abbr` — `place_abbr` table exists with > 0 rows.
5. `fts-bbox` — `place_search` and `place_bbox` exist and `place_bbox` count ≥ 0.9 × spr current count.
6. `bbox-extents` — for BE, AT, CH, LU (the #1015 class): at least one `region` row with `max_latitude - min_latitude > 0.05` (real extents, not label points).

**`verify-baseline.json`** — generated once (Step 5 below), committed. `requiredNodes` = every country that has a `country` node in **either** the live DB **or** the #1026 newly-flattened list (those 95 are required so the next rebuild must restore them): `AD AF AG AL AM AW AZ BA BB BF BI BJ BL BN BS BT BW BZ CD CF CG CV CW CY DJ DM ER FJ GA GD GE GM GN GQ GW GY HN HT JM KG KI KM KN KP LA LC LI LR LS LY MC MD ME MF MG MK ML MN MR MT MU MV MW MZ NA NE NI NR PG PY RW SB SC SD SL SM SO SR SS ST SV SX SY SZ TD TF TG TJ TL TM TO TT TV UZ VA VC VU WS XK YE ZM ZW` each `["country"]`, plus GE additionally `["country","region"]` (the #1023 trigger), plus the 11 WOF-priority countries `["country","region"]`. `minRows: 4_000_000`, `minCountries: 244`.

- [ ] **Step 1: Write the failing tests** — three fixture cases: (a) a fixture DB satisfying a tiny baseline passes all checks; (b) delete the country node → `node-census` fails naming the country; (c) drop `place_abbr` → that check fails. Plus: `REVERSE_PANEL_CASES` has ≥ 15 entries including Brussels/Antwerpen/Gent/Basel.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement `verify.ts`** — pure SQL checks, no network; `verifyReversePanel` ports `scripts/reverse-eu-panel.ts`'s CASES + loop over `WOFReverseGeocoder` (same 15 cases; the script is deleted in Task 15).
- [ ] **Step 4: Run to verify they pass**, `npx tsc -b mailwoman`.
- [ ] **Step 5: Generate the committed baseline** — one-off (run and then delete the snippet, or keep as `verify.ts`'s exported `writeBaseline(db, path)` helper — keep the helper, it's the deliberate-update path):

```bash
node -e '
import("./mailwoman/out/gazetteer-pipeline/verify.js").then(async (m) => {
	const { openBuiltDatabase } = await import("@mailwoman/core/utils")
	const db = openBuiltDatabase(process.env.MAILWOMAN_DATA_ROOT + "/wof/admin-global-priority.db")
	m.writeBaseline(db, "mailwoman/gazetteer-pipeline/verify-baseline.json")
})'
```

then hand-merge the #1026 list per the spec (`requiredNodes` union), and eyeball the diff.

- [ ] **Step 6: Commit** — `git add mailwoman/gazetteer-pipeline/verify* && git commit -m "feat(gazetteer): structural verify gate — node census (#1026), reverse panel (#1015), abbrev/fts checks (#440)"`

---

### Task 12: `admin/index.ts` — the `buildAdmin` orchestrator (+ build log, + seal)

**Files:**

- Create: `mailwoman/gazetteer-pipeline/admin/index.ts`
- Modify: `mailwoman/gazetteer-pipeline/index.ts` — `export * from "./admin/index.js"`, `export * from "./verify.js"`, `export * from "./fts.js"`

**Interfaces:**

- Consumes: everything from Tasks 4–11 + `sealDatabase` (Task 1).
- Produces:

```ts
export interface BuildAdminOptions {
	dataDir?: string // default join(wofDir(), "repos")
	out?: string // default join(wofDir(), "admin-global-priority" + DEFAULT_ADMIN_STAGING_SUFFIX)
	overtureCountries?: readonly string[] // default DEFAULT_OVERTURE_COUNTRIES
	geonamesCountries?: readonly string[] // default DEFAULT_GEONAMES_COUNTRIES
	overtureRelease?: string // default DEFAULT_OVERTURE_RELEASE
	skipVerify?: boolean // escape for fixture/dev runs; the command default is verify-on
	onPhase?: (phase: string, detail?: string) => void
}
export interface BuildAdminResult {
	out: string
	placesIngested: number
	overtureIngested: number
	geonamesIngested: number
	verify: VerifyResult | null
	sealed: boolean
	elapsedSeconds: number
}
export function buildAdmin(opts?: BuildAdminOptions): Promise<BuildAdminResult>
```

**Orchestration order** (each phase → `onPhase`): create staging `.ingest` DB (WAL pragmas from the script) → `createUnifiedSchema` → `ingestWOF` → `ingestOvertureDivisions` → `foldGeonames` → `freezeAdmin` → `enrichAdmin` → `VACUUM INTO out` (delete pre-existing `out` first) → close+delete `.ingest` and sidecars → open `out` writable → `buildFTS(db, { drop: false })` → close → `verifyAdmin(openBuiltDatabase(out), loadDefaultBaseline())` + `verifyReversePanel(out)` (unless `skipVerify`; **any failed check throws** — the artifact is left UNSEALED for inspection) → `sealDatabase(out)` → **append the build log**: read `scripts/wof-build-manifest.json`, push onto `notes` a line `"<ISO date>: gazetteer build admin — <rows> rows / <countries> countries, overture <n>@<release>, geonames <n>, verify PASS, sealed. md5 <first 8 of file md5>"`, write back. NOTE: enrich runs BEFORE `VACUUM INTO` (order: freeze → enrich → vacuum → fts) so abbrevs are inside the vacuumed artifact and FTS (which reads `names`) is built after — matching the RELEASING.md ordering rule (abbrevs precede FTS).

- [ ] **Step 1: Implement** `buildAdmin` per the order above (the remaining `main()` glue of `scripts/build-unified-wof.ts`, now with enrich+fts+verify+seal folded in).
- [ ] **Step 2: Reduce `scripts/build-unified-wof.ts`** to a 20-line deprecation shim: parse the old flags, print `"build-unified-wof.ts is superseded by: mailwoman gazetteer build admin"`, call `buildAdmin` with mapped options. (Deleted outright in Task 15 — the shim keeps the tree green between commits.)
- [ ] **Step 3: Verify** — `yarn typecheck:scripts && npx tsc -b mailwoman && yarn vitest run mailwoman/gazetteer-pipeline` → all green.
- [ ] **Step 4: Commit** — `git commit -am "feat(gazetteer): buildAdmin orchestrator — ingest→fold→freeze→enrich→fts→verify→seal + auto build log"`

---

### Task 13: The commands — `gazetteer build admin|candidate`, bare `build`, `verify`

**Files:**

- Create dir: `mailwoman/commands/gazetteer/build/`
- Move: `mailwoman/commands/gazetteer/build.tsx` → `mailwoman/commands/gazetteer/build/candidate.tsx` (content unchanged except the component name → `GazetteerBuildCandidate`)
- Create: `mailwoman/commands/gazetteer/build/admin.tsx`
- Create: `mailwoman/commands/gazetteer/build/index.tsx` (the full chain: admin → candidate)
- Create: `mailwoman/commands/gazetteer/verify.tsx`

**Interfaces:**

- Consumes: `buildAdmin`, `buildCandidate`, `foldGeonamesIntoAdmin`, `verifyAdmin`, `verifyReversePanel`, `loadDefaultBaseline` from `../../gazetteer-pipeline/index.js`.
- Produces: CLI surface `mailwoman gazetteer build` / `build admin` / `build candidate` / `verify [--db <path>] [--reverse-panel]`.

- [ ] **Step 1: `build/candidate.tsx`** — `git mv`, rename component, fix the relative import depth (`../../gazetteer-pipeline/index.js` → `../../../gazetteer-pipeline/index.js`).
- [ ] **Step 2: `build/admin.tsx`** — Ink command in the house pattern (zod options schema; progress via `console.error`; summary `<Text>` on stdout; `process.exit` in `useEffect`, exactly like `gazetteer/build.tsx` today). Options: `data?`, `out?`, `overtureCountries?` (csv), `geonamesCountries?` (csv), `overtureRelease?`, `skipVerify` (boolean, default false). Body: `buildAdmin({...})`, phases streamed to stderr; summary lines: output path, rows, `verify: PASS (N checks)`, `sealed 0444`, `next: mailwoman gazetteer build candidate`.
- [ ] **Step 3: `build/index.tsx`** — the turnkey chain: `buildAdmin()` → `foldGeonamesIntoAdmin` + `buildCandidate` (the exact body of today's bare `gazetteer build`, reusing its defaults) — summary names both artifacts. Zod options: union of admin's and candidate's, all optional.
- [ ] **Step 4: `verify.tsx`** — options: `db?` (default the live admin DB path), `reversePanel` (boolean, default true). Runs `verifyAdmin` + optionally `verifyReversePanel`, prints one ✓/✗ line per check, exits non-zero on any failure.
- [ ] **Step 5: Compile + smoke** — `yarn compile && node mailwoman/out/cli.js gazetteer --help` shows `build`, `verify`, …; `node mailwoman/out/cli.js gazetteer build --help` shows `admin`/`candidate` subcommands; `node mailwoman/out/cli.js gazetteer verify --db /mnt/playpen/mailwoman-data/wof/admin-global-priority.db` runs (expect: **node-census FAILS on the #1026 countries** — correct behavior, the live DB is known-regressed; every other check passes; overall exit 1).
- [ ] **Step 6: Commit** — `git add -A mailwoman/commands && git commit -m "feat(cli): gazetteer build admin|candidate + turnkey build + structural verify"`

---

### Task 14: `gazetteer inspect` + retire the `wof` namespace

**Files:**

- Create dir: `mailwoman/commands/gazetteer/inspect/`
- Move: `mailwoman/commands/wof/{tree,graph,mermaid,sync}.tsx` → `mailwoman/commands/gazetteer/inspect/` (fix relative import depths)
- Delete: `mailwoman/commands/wof/prepare/` (the stale partial builder — superseded by `build admin`)
- Replace: `mailwoman/commands/wof/` with shim files `{tree,graph,mermaid,sync,prepare}.tsx` — each renders `<Text color="yellow">`mailwoman wof X`moved: use`mailwoman gazetteer inspect X` (prepare → gazetteer build admin)`</Text>` and exits 1.

- [ ] **Step 1: Move + fix imports** (`git mv`, adjust `../../sdk/cli.js` → `../../../sdk/cli.js` etc.).
- [ ] **Step 2: Write the shims** (5 near-identical ~15-line files; template once, adjust the names).
- [ ] **Step 3: Compile + smoke** — `yarn compile`; `node mailwoman/out/cli.js gazetteer inspect tree --help` works; `node mailwoman/out/cli.js wof tree` prints the redirect and exits 1.
- [ ] **Step 4: Commit** — `git commit -am "refactor(cli): wof namespace retired — inspect commands under gazetteer, prepare superseded by build admin"`

---

### Task 15: Deletions + docs (RELEASING.md, manifest role)

**Files:**

- Delete: `scripts/build-unified-wof.ts`, `scripts/add-region-abbrevs.ts`, `scripts/add-ancestors.ts`, `scripts/backfill-ancestors-from-hierarchy.ts`, `scripts/reverse-eu-panel.ts`
- Modify: `RELEASING.md` — the "Rebuilding + swapping the canonical admin gazetteer" section
- Modify: `scripts/wof-build-manifest.json` — `_comment` updated to declare it a build LOG (recipe = `gazetteer-pipeline/defaults.ts`)
- Modify: `scripts/AGENTS.md` — note the gazetteer builders now live in `mailwoman/gazetteer-pipeline/`

**Steps:**

- [ ] **Step 1: Check for stragglers** — `rg -l 'build-unified-wof|add-region-abbrevs|add-ancestors|backfill-ancestors-from-hierarchy|reverse-eu-panel' --glob '!*/out/*' --glob '!docs/superpowers/**' .` → every hit is either a doc updated in this task or a historical eval record (leave those; they're dated point-in-time).
- [ ] **Step 2: Delete the five scripts** (`git rm`).
- [ ] **Step 3: Rewrite the RELEASING.md section** — Steps 1–3b collapse to:

```markdown
### Step 1 — build + verify (one command)

    node mailwoman/out/cli.js gazetteer build admin

Builds to the staging path, runs every post-build step (abbrevs, place_abbr, FTS), then the structural
verify gate (per-country node census, reverse EU panel, coverage floor) and SEALS the artifact 0444.
A failed gate leaves the artifact unsealed for inspection and exits non-zero — do not swap it.
Coverage recipe: `mailwoman/gazetteer-pipeline/defaults.ts` (code, reviewed like code).
`scripts/wof-build-manifest.json` is the auto-appended build LOG.

### Step 2 — swap + restart (unchanged)
```

keeping the existing Step-4 swap/restart text (mv → bak, promote, restart services) and Step 5 (demo propagation).

- [ ] **Step 4: Verify** — `yarn typecheck:scripts && npx tsc -b && yarn vitest run mailwoman core/utils` → green; `rg build-unified-wof scripts/` → no hits.
- [ ] **Step 5: Commit** — `git commit -am "chore: delete the superseded admin-build scripts; RELEASING.md points at gazetteer build admin"`

---

### Task 16: End-to-end validation — staging build + census vs live

**Files:** none (runbook execution; findings recorded in the PR description)

- [ ] **Step 1: Full staging build** — `node mailwoman/out/cli.js gazetteer build admin --out /mnt/playpen/mailwoman-data/wof/admin-global-priority.E2E-PRB.db` (~8 min). Expected: every phase streams; **verify may FAIL `node-census`** if the Overture/GeoNames country-node interplay (#1026's suspected mechanism) reproduces — that is a CORRECT gate result, not a task failure.
- [ ] **Step 2: If node-census fails** — capture the missing list into #1026 (comment with the exact `(country, placetype)` set). The fix belongs to #1026/PR C (fold-order archaeology), NOT this PR — the gate exists precisely to block the swap.
- [ ] **Step 3: If verify passes** — diff old-vs-new per-country/per-placetype census (`SELECT country, placetype, COUNT(*) FROM spr WHERE is_current!=0 GROUP BY 1,2` on both, joined) — attach the diff summary to the PR; the E2E artifact is a swap candidate for #1026 itself (operator decides; swap follows the RELEASING.md runbook).
- [ ] **Step 4: Confirm the seal** — `ls -l` shows `-r--r--r--`; `node -e` RW-open via `openBuiltDatabase` throws `SealedArtifactError`.
- [ ] **Step 5: Clean up** — remove the E2E artifact unless it's being promoted; push the branch; open the PR (B) referencing the spec, with the E2E findings.

---

## Self-review notes

- Spec §1 → Tasks 1–2; §2 → Tasks 4, 12–14; §3 → Tasks 3, 5–10, 12; §4 → Task 11; §5's PR-B deletions → Task 15; §6 PR A/B → this plan, PR C → explicitly deferred (needs Task 11's census tooling). Covered.
- The `verify` gate intentionally fails against the current live DB (#1026 known regression) — Tasks 13/16 call this out so an executor doesn't "fix" the gate to pass.
- Type names consistent: `VerifyResult`/`VerifyBaseline` (11) consumed in 12–13; `buildAdmin` (12) consumed in 13; `sealDatabase` (1) consumed in 2, 12.
