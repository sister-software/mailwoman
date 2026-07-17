# #875 acronym-casing batch — execution-ready inventory (ships with v7.0.0)

**Status:** design/inventory only. Nothing renamed. This is the executor's checklist for
step 9 of the legacy-rules excision (`2026-07-12-legacy-rules-excision-design.md`).

**Scope of #875's remaining gaps** (per `AGENTS.md` → "Known gaps (#875)"): the `Us`→`US`
family and the `Json`→`JSON` / `Jsonl`→`JSONL` families. The v5.0.0 sweep already handled
`WOF`/`OSM`/`ID`/`URL`/`Http`/`Api`/`Uri`; a spot-check of exported identifiers in those
families found **zero** remaining stragglers, so this batch is exactly the three families
below. Acronyms capitalize as whole camelCase components: `UsX`→`USX`, `XJson`→`XJSON`,
`XJsonl`→`XJSONL`.

Counts are total in-repo references (definition + all call/import sites), excluding
`node_modules/` and `out/`.

---

## Ordering dependency (do this LAST)

The excision design doc's execution order puts this batch at **step 9**, *after* the
classifiers/substrate rehoming and deletion PRs (steps 5–8), "so the sweep hits final
paths." Concretely:

- `codex/`, `core/`, `corpus/` paths are stable — excision does not move them.
- `mailwoman/region-recognition.ts` and `mailwoman/commands/**` may be touched/moved by the
  rehoming. Run the sweep only after those land so the renamer edits final file paths, not
  paths that a later move invalidates.

Land all three family PRs **before** the `legacy-rules-final` tag / v7.0.0 CI publish, and
add the rename table to the migration guide (step 10).

---

## Family 1: `Us` → `US`

### Public — BREAKING (must land in the v7.0.0 major)

All exported from `@mailwoman/codex/us` (a published public subpath; `codex/us/index.ts`
re-exports the whole directory).

| Identifier | Rename | Definition | Refs |
| --- | --- | --- | --- |
| `isUsStateAbbreviation` (fn) | `isUSStateAbbreviation` | `codex/us/state.ts:87` | 29 |
| `UsStateAbbreviation` (type) | `USStateAbbreviation` | `codex/us/state.ts:79` | 8 |
| `UsUnitDesignator` (type) | `USUnitDesignator` | `codex/us/unit-designator.ts:66` | 17 |
| `UsPoBoxDesignator` (type) | `USPoBoxDesignator` | `codex/us/po-box.ts:31` | 1 |
| `UsStreetSuffix` (type) | `USStreetSuffix` | `codex/us/street-suffix.ts:232` | 10 |
| `UsMilitaryPostOfficeCode` (type) | `USMilitaryPostOfficeCode` | `codex/us/military-address.ts:49` | 3 |
| `UsArmedForcesRegionCode` (type) | `USArmedForcesRegionCode` | `codex/us/military-address.ts:61` | 3 |
| `UsMilitaryUnitDesignatorCode` (type) | `USMilitaryUnitDesignatorCode` | `codex/us/military-address.ts:97` | 3 |
| `UsMilitaryUnitMatch` (interface) | `USMilitaryUnitMatch` | `codex/us/military-address.ts:100` | 2 |
| `UsMilitaryCityMatch` (interface) | `USMilitaryCityMatch` | `codex/us/military-address.ts:150` | 2 |
| `UsFloorDesignator` (interface) | `USFloorDesignator` | `codex/us/floor-designator.ts:36` | 2 |
| `UsFloorDesignatorName` (type) | `USFloorDesignatorName` | `codex/us/floor-designator.ts:62` | 6 |

External callers of these live in `neural/` (`postcode-anchor.ts`, `span-proposer-lexicon.ts`)
and `address-id/index.ts` — rename them in the same PR (cross-package, same atomic sweep).

### Internal — non-breaking (rename with the batch)

| Identifier | Rename | Definition | Refs | Note |
| --- | --- | --- | --- | --- |
| `UsStateInfo` (interface) | `USStateInfo` | `corpus/src/codex/us-fips-state.ts:17` | 6 | exported, but `corpus/src/codex/` is **not** in the corpus exports map → internal |
| `UsTuple` (interface) | `USTuple` | `corpus/src/shard-recipes/po-box-cedex.ts:123` | 11 | local (non-exported) |
| `UsSource` (interface) | `USSource` | `corpus/src/shard-recipes/street-affix.ts:49` | 4 | local (non-exported) |
| `annotateUsRegions` (fn) | `annotateUSRegions` | `mailwoman/region-recognition.ts:211` | 3 | local; **may move in rehoming — sweep after** |
| `expandUsRegion` (fn) | `expandUSRegion` | `docs/src/shared/demo-helpers.ts:176` | 5 | `@mailwoman/docs` is private/unpublished; also a doc-comment ref at `docs/src/shared/httpvfs-resolver.ts:340` |

(`recognizeUsRegions`→`recognizeUSRegions` already done per #875 addendum — no straggler remains.)

---

## Family 2: `Json` → `JSON`

### Public — BREAKING

| Identifier | Rename | Definition | Refs | Surface |
| --- | --- | --- | --- | --- |
| `pyJsonDumps` (fn) | `pyJSONDumps` | `core/utils/python-json.ts:89` | 4 | `@mailwoman/core/utils` (re-exported at `core/utils/index.ts:10`) |
| `PyJsonOptions` (interface) | `PyJSONOptions` | `core/utils/python-json.ts:28` | 2 | `@mailwoman/core/utils` |

(`pyReprDict` in the same file is already correctly cased — leave it.)

### Internal — non-breaking

| Identifier | Rename | Definition | Refs | Note |
| --- | --- | --- | --- | --- |
| `pyJsonStr` (fn) | `pyJSONStr` | `mailwoman/gazetteer-pipeline/anchor-lookup.ts:225` | 4 | local |
| `pyJsonNum` (fn) | `pyJSONNum` | `mailwoman/gazetteer-pipeline/anchor-lookup.ts:252` | 2 | local |
| `pyJsonValue` (fn) | `pyJSONValue` | `mailwoman/gazetteer-pipeline/anchor-lookup.ts:259` | 4 | local |
| `fetchJson` (fn) | `fetchJSON` | `scripts/eval/fullstack-compare.ts:234` | 4 | script-local |
| `safeJsonForScript` (fn) | `safeJSONForScript` | `registry/map-html.ts:82` | 3 | local |
| `postJson` (fn) | `postJSON` | `mailwoman/test/api-engine.test.ts:65` | test-local |
| `extractJson` (fn) | `extractJSON` | `mailwoman/test/pipeline-debug-cli.test.ts:26` | test-local |

### Local variables (convention applies, but low-value / optional)

These are plain locals, not API. Rename for consistency if the executor wants, but they are
**not** breaking and several mirror the filename `package.json` (renaming reads oddly):
`packageJson` (16), `pkgJsonPath` (2), `outJson` (28), `provJson` (7), `provenanceJson` (7),
`errorsJson` (5), `metaJson` (2), `countriesJson` (2), `pipJson` (3). **Recommendation:**
leave `packageJson`/`pkgJsonPath` (filename mirror); the rest are optional cosmetic.

---

## Family 3: `Jsonl` → `JSONL`

### Public — BREAKING

| Identifier | Rename | Definition | Refs | Surface |
| --- | --- | --- | --- | --- |
| `JsonlToParquetOptions` (interface) | `JSONLToParquetOptions` | `corpus/src/tools/jsonl-to-parquet.ts:86` | 2 | `@mailwoman/corpus/tools` (re-exported at `corpus/src/tools/index.ts:20`) |
| `JsonlToParquetSummary` (interface) | `JSONLToParquetSummary` | `corpus/src/tools/jsonl-to-parquet.ts:96` | 2 | `@mailwoman/corpus/tools` |

### Internal — non-breaking

| Identifier | Rename | Definition | Refs | Note |
| --- | --- | --- | --- | --- |
| `streamJsonl` (async generator) | `streamJSONL` | `corpus/src/build.ts:336` | 5 | local (non-exported) |
| `DevJsonlToParquet` (Pastel command) | `DevJSONLToParquet` | `mailwoman/commands/dev/jsonl-to-parquet.tsx:28` | 2 | default export of a command; the identifier is safe to rename — it is **not** a flag prop (see hazards). May move in rehoming — sweep after |
| `emitCorpusJsonl` (local const) | `emitCorpusJSONL` | `mailwoman/commands/gazetteer/overture-ingest.tsx:169` | 2 | local closure |
| `GeoJsonFeatureCollection` (type) | `GeoJSONFeatureCollection` | test-only: `registry/map-html.test.ts:10,12,16` | 3 | see hazard note below |

### Local variables (optional / internal)

`outJsonl` (5), `corpusJsonl` (2), `evalJsonl` (2), `firstJsonl` (2), `secondJsonl` (2),
`labeledJsonlPath` (2), and the local `const readJsonl` at `corpus/src/build.test.ts:103`.

---

## Hazard flags — do NOT rename these

The batch-B scar (`project-casing-sweep-db-column-hazard`) came from renaming a token inside
a SQL column string, which broke a shipped DB. The renamer must target **camelCase TS
identifiers only** and skip every item below.

1. **`JsonObject` — external (`type-fest`).** Imported at `core/objects.ts:9`
   (`import type { JsonObject } from "type-fest"`), used at lines 184–204. Match the library's
   casing — **keep `JsonObject`.** (5 refs; the "generic Json" straggler the task asked about —
   it is external, not ours.)
2. **`outGeojson` / `OUT_GEOJSON` / `--out-geojson`** in
   `registry/tools/cross-dataset-correlation.ts` (191) and the viz tools. It is a Pastel
   kebab-derived flag prop (`--out-geojson` → `outGeojson`) *and* it is `Geojson`, not `Json`.
   **Skip** — per the AGENTS rule for kebab-flag-derived props.
3. **`"us"` string literals** — `systems.has("us")`, locale/system codes `"us"`, DB region
   values. These are lowercase wire/enum contracts, not `Us` identifiers. **Skip.**
4. **File extensions & filename literals** — `.json` / `.jsonl` paths, the string `"json"` /
   `"jsonl"`, and `package.json`. Not identifiers. **Skip.**
5. **SQL column strings / snake_case keys** — anything like `us_state`, `*_json` inside a
   `.prepare(...)` / schema-builder string or a wire key. The rename never touches string
   contents. **Skip.**
6. **Already-correct, leave alone:** `JSON.stringify` / `JSON.parse`, and `@mailwoman/spatial`'s
   `toGeoJSON`, `reconciliationGeoJSON`, `GeoFeatureCollection`, plus `pyReprDict`. These
   already follow the convention.

### Two discrepancies the executor should know

- **The excision doc names a `writeJsonl` straggler in `corpus/src/build.test.ts`; it does not
  exist.** The actual identifier there is a local `const readJsonl` (`build.test.ts:103`). No
  `writeJsonl` exists anywhere in the repo. Treat "the `writeJsonl` straggler" as `readJsonl`.
- **`GeoJsonFeatureCollection` is imported in `registry/map-html.test.ts:10` from `./types.ts`,
  but `registry/types.ts` does not export it** (its exports are `SourceRecord`,
  `ResolvedEntity`, `ReconciliationBucket`, `EntityGeoData`). The import looks stale/unresolved.
  Verify whether the test compiles at all before renaming — this may be dead code to fix or
  delete rather than rename.

---

## Recommended PR slicing

**AGENTS.md is explicit:** "a partial `Json` sweep half-renames callers vs def." So the
non-negotiable rule is **each family is atomic** — the definition and *every* import/caller
(across package boundaries) move in one PR, CI green.

Recommended: **three atomic per-family PRs**, all merged before the v7.0.0 tag:

- **PR A — `Us`→`US`:** the whole Family 1 in one sweep (codex public + `neural`/`address-id`
  callers + corpus/mailwoman/docs internals). The codex-public and internal renames are
  intertwined by imports, so splitting public-vs-internal would break CI mid-stack — keep them
  together.
- **PR B — `Json`→`JSON`:** Family 2 (`pyJsonDumps`/`PyJsonOptions` public + internals + chosen
  locals).
- **PR C — `Jsonl`→`JSONL`:** Family 3 (`JsonlToParquet*` public + `streamJsonl` /
  `DevJsonlToParquet` / `emitCorpusJsonl` + the `GeoJsonFeatureCollection` test fix).

The three families are mutually independent (no shared identifiers), so three PRs is safe and
far more reviewable than one mega-diff. A single combined PR is also acceptable if the operator
prefers one atomic commit — the hard requirement is per-family atomicity, not the PR count.
Either way, **do not** land a partial family.

## Totals

- **Family 1 (`Us`→`US`):** 17 identifiers — 12 public/BREAKING (codex/us), 5 internal.
- **Family 2 (`Json`→`JSON`):** 9 named identifiers — 2 public/BREAKING (core/utils), 7 internal
  — plus ~9 optional cosmetic locals.
- **Family 3 (`Jsonl`→`JSONL`):** 6 named identifiers — 2 public/BREAKING (corpus/tools), 4
  internal — plus ~7 optional cosmetic locals.
- **Public / BREAKING total: 16 identifiers** across `@mailwoman/codex/us` (12),
  `@mailwoman/core/utils` (2), `@mailwoman/corpus/tools` (2). These are the reason the batch is
  major-gated.
- **Do-not-touch:** `JsonObject` (type-fest), `outGeojson` (kebab flag), `"us"`/`.json`/`.jsonl`
  literals, SQL/snake_case keys, already-correct `GeoJSON`/`JSON.*`.
