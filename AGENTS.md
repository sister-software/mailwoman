# AGENTS.md

Mailwoman is a postal-address parser shipped as the unscoped entry package `mailwoman` (CLI + library) plus **34 scoped `@mailwoman/*` workspaces**. The repo root is the private orchestration package `@mailwoman/universe` (not published). 33 of the 35 workspaces publish to npm — `docs` and `tile-worker` stay private. The table groups them by role:

| Workspace                                                                    | npm package                        | Purpose                                                                                                                            |
| ---------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `mailwoman/`                                                                 | `mailwoman`                        | CLI + the high-level runtime pipeline (`createRuntimePipeline`) — the user-facing entry                                            |
| **Runtime pipeline (staged preprocessing → parse → resolve)**                |                                    |                                                                                                                                    |
| `normalize/`                                                                 | `@mailwoman/normalize`             | Stage 1 — deterministic preprocessing (Unicode NFC, punctuation, whitespace, abbreviation); pure, no ML                            |
| `query-shape/`                                                               | `@mailwoman/query-shape`           | Cheap structural priors — character class, segmentation, known-format detection                                                    |
| `locale-gate/`                                                               | `@mailwoman/locale-gate`           | Stage 2 — derive a `LocaleHint` from the query shape                                                                               |
| `kind-classifier/`                                                           | `@mailwoman/kind-classifier`       | Stage 2.5 — categorize by query shape (`postcode_only` / `structured_address` / `po_box` / `intersection` / …)                     |
| `phrase-grouper/`                                                            | `@mailwoman/phrase-grouper`        | Stage 2.7 — propose coherent input units (boundary discovery) with a kind hypothesis                                               |
| **Model + core**                                                             |                                    |                                                                                                                                    |
| `core/`                                                                      | `@mailwoman/core`                  | Tokenization, classification, solver/decoder, policy registry. Ships ~9 MB libpostal + WOF + chromium-i18n data under `core/data/` |
| `classifiers/`                                                               | `@mailwoman/classifiers`           | Rule-based classifiers                                                                                                             |
| `neural/`                                                                    | `@mailwoman/neural`                | SentencePiece tokenizer + ONNX inference + decoder wiring                                                                          |
| `neural-web/`                                                                | `@mailwoman/neural-web`            | Browser neural runtime (onnxruntime-web; WebGPU primary, WASM fallback)                                                            |
| `neural-weights-en-us/`                                                      | `@mailwoman/neural-weights-en-us`  | Trained model bundle (en-us) — data-only, loaded by `@mailwoman/neural`                                                            |
| `neural-weights-fr-fr/`                                                      | `@mailwoman/neural-weights-fr-fr`  | Trained model bundle (fr-fr) — data-only                                                                                           |
| `corpus/`                                                                    | `@mailwoman/corpus`                | BIO-labeled training-corpus pipeline                                                                                               |
| **Reference data**                                                           |                                    |                                                                                                                                    |
| `codex/`                                                                     | `@mailwoman/codex`                 | Per-address-system postal reference + branded types (USPS suffixes, US ZIPs). Pure, zero-runtime-dep                               |
| `variant-aliases/`                                                           | `@mailwoman/variant-aliases`       | Regional variant alias table (`servo` → fuel en-AU, `PFK` → KFC fr-CA), gated by locale                                            |
| **Resolver + geo**                                                           |                                    |                                                                                                                                    |
| `resolver/`                                                                  | `@mailwoman/resolver`              | Walk an `AddressTree`, decorate nodes with gazetteer coords + attribution; backend-agnostic, owns the span-rescore levers          |
| `resolver-wof-sqlite/`                                                       | `@mailwoman/resolver-wof-sqlite`   | WOF SQLite resolver — FTS5/candidate-table `PlaceLookup` (the geocoding backend)                                                   |
| `resolver-wof-wasm/`                                                         | `@mailwoman/resolver-wof-wasm`     | WOF WASM resolver — browser `PlaceLookup` over `@sqlite.org/sqlite-wasm`                                                           |
| `spatial/`                                                                   | `@mailwoman/spatial`               | Spatial/geo utilities — haversine, bbox, projection (the math home)                                                                |
| `cartographer/`                                                              | `@mailwoman/cartographer`          | Mapping utilities for the geo data pipeline                                                                                        |
| `tiger/`                                                                     | `@mailwoman/tiger`                 | US Census TIGER/Line processing                                                                                                    |
| **Formatter + record matcher (geocode-first entity resolution)**             |                                    |                                                                                                                                    |
| `formatter/`                                                                 | `@mailwoman/formatter`             | The inverse of the parser — render `ComponentTag` components to an address string + a canonical match key                          |
| `record/`                                                                    | `@mailwoman/record`                | Record schema + per-field normalizers for the matcher                                                                              |
| `match/`                                                                     | `@mailwoman/match`                 | The geocode-first matcher — block → score → cluster (string comparators + the Fellegi-Sunter scorer)                               |
| `registry/`                                                                  | `@mailwoman/registry`              | The record-matching app — resolve messy records to geocoded entities, export GeoJSON                                               |
| `address-id/`                                                                | `@mailwoman/address-id`            | Stable address primary key (`<state>.<H3-cell>.<hash>`) — the exact-match complement to the fuzzy matcher                          |
| **Drop-in APIs + annotations (replace Nominatim/Photon/libpostal/OpenCage)** |                                    |                                                                                                                                    |
| `annotations/`                                                               | `@mailwoman/annotations`           | The annotation contract — native `AnnotationSet` + `toOpenCage()`/`toNative()`; the seam every annotator plugs into                |
| `nominatim/`                                                                 | `@mailwoman/nominatim`             | Nominatim-compatible drop-in (`/search`, `/reverse`, `/status`) — returns the OpenCage-style `annotations` block                   |
| `photon/`                                                                    | `@mailwoman/photon`                | Photon-compatible autocomplete drop-in (`/api`, `/reverse`) — GeoJSON FeatureCollections                                           |
| `libpostal/`                                                                 | `@mailwoman/libpostal`             | libpostal-compatible drop-in (`/parse`, `/expand`)                                                                                 |
| `timezone-lookup/`                                                           | `@mailwoman/timezone-lookup`       | Server-side IANA timezone PIP lookup (node:sqlite); data built like the gazetteer                                                  |
| `un-locode-lookup/`                                                          | `@mailwoman/un-locode-lookup`      | UN/LOCODE nearest-code lookup (node:sqlite)                                                                                        |
| `nuts-lookup/`                                                               | `@mailwoman/nuts-lookup`           | EU NUTS region PIP lookup (node:sqlite)                                                                                            |
| **Private / infra**                                                          |                                    |                                                                                                                                    |
| `docs/`                                                                      | `@mailwoman/docs` (private)        | Docusaurus site → https://mailwoman.sister.software                                                                                |
| `tile-worker/`                                                               | `@mailwoman/tile-worker` (private) | Tile worker for the demo-map coverage overlay                                                                                      |

Source files live at each workspace's root (no `src/` nesting). The repo root holds workspace config + `scripts/` + `docs/` only.

## Where to read next

- **[`docs/articles/concepts/what-mailwoman-is.mdx`](./docs/articles/concepts/what-mailwoman-is.mdx)** — what the system _is_ (a calibrated, retrieval-augmented sequence labeler), the grammar/atlas division of labor, and the disciplines that keep the architecture honest. Read this first if you're new to the project entirely.
- **[`docs/articles/plan/SCOPE.mdx`](./docs/articles/plan/SCOPE.mdx)** — the current scope declaration (#886): locale tiers, the two workstreams, the standing invariants, the runtime-flag register, where the live roadmap lives. Read this first for orientation. The old implementation plan (`plan/README.mdx`) and the phase directory are historical design records — rationale, not current state.
- **[`docs/articles/plan/reference/`](./docs/articles/plan/reference/)** — design rationale, schema source of truth, TS contracts, operations playbook, address-data-sources catalog. `SCHEMA.mdx` is the single source of truth for the `ComponentTag` union.
- **[`docs/articles/plan/CONTRIBUTING_MODEL_WORK.mdx`](./docs/articles/plan/CONTRIBUTING_MODEL_WORK.mdx)** — the model-work runbook: which evals gate a change, the lever-shape taxonomy, how to add a shard. Read before touching the model, a shard recipe, or an eval.
- **[`docs/articles/plan/reference/coverage-overlay.mdx`](./docs/articles/plan/reference/coverage-overlay.mdx)** — the demo-map address-coverage ("fog of war") overlay runbook: rebuild/republish (the `coverage build` + `tiles publish` CLIs), the `nexus-assets` upload/credential gotchas, the HI/NH data situation, tuning knobs. Read before touching the coverage overlay, the `tile-worker`, or `coverage build`.
- **[`RELEASING.md`](./RELEASING.md)** — local and CI release flows. Read before cutting a release.
- **[`docs/articles/evals/`](./docs/articles/evals/)** — eval reports per training step. The per-model score ledger lives at `evals/scores-by-version.json` (repo root), schema in `docs/articles/plan/reference/eval-ledger.schema.json`. **Ledger status:** revived at the 2026-07-02 re-anchor (#885) — the v5.0.0 row is from the full re-score, and appending is now automated (`scripts/eval/ledger-append.ts`; `promotion-gate.ts` prints the pre-filled command on every PASS). Rows for 4.5.0–4.16.2 were never populated (the freeze the re-anchor ended); their headlines live in [`docs/articles/releases.mdx`](./docs/articles/releases.mdx) + each version's `model-card.json`. The authoritative human-readable per-tag table is the latest `parity-scorecard-*.md`.

## Release pipeline pitfalls

Local: `yarn release`. CI: GitHub Actions → `publish` workflow → manual dispatch. See `RELEASING.md` for setup + flow. The notes below cover the gotchas that have bitten this pipeline before — read before touching `scripts/copy-weights.ts`, `scripts/publish-workspace.ts`, or `.release-it.json`.

### The weights workspaces have moving binaries

The `neural-weights-<locale>` workspaces ship binary artifacts (`model.onnx`, `tokenizer.model`) that are **not** committed to git. Multiple pieces cooperate to get those files in place — be careful when changing any of them:

- `<workspace>/scripts/link-dev-weights.ts` — symlinks the artifacts from `$MAILWOMAN_DATA_ROOT/...` into the workspace so `@mailwoman/neural` can find them during local dev.
- `neural/test/weights.test.ts` — invokes `link-dev-weights.ts` to verify auto-resolve. **Running `yarn test` re-creates the symlinks** in `neural-weights-en-us/` as a side effect.
- `scripts/copy-weights.ts` — invoked by release-it's `before:init` hook. Materializes the real binaries into each workspace. Skipped in CI when `MAILWOMAN_SKIP_WEIGHTS_COPY=1` (the default for the `publish` workflow when `release_weights=false`).
- `scripts/publish-workspace.ts` — invoked per workspace by release-it. Calls `yarn pack -o <tmp>` (translates `workspace:*` → concrete versions) then `npm publish <tmp>` (npm CLI handles npm-side auth, including Trusted Publishing OIDC in CI).

### Pitfall: symlinks in the publish tarball

`yarn npm publish` (and `npm publish`) refuse to upload tarballs containing symlinks — the registry returns HTTP 415 (`YN0035: Symbolic link is not allowed`). Two specific traps make this easy to hit:

1. **`fs.copyFile` follows symlinks at the destination.** A naïve `fs.copyFile(SOURCE, dest)` where `dest` is a symlink writes through the symlink — the symlink stays in place. `scripts/copy-weights.ts` mitigates this by `unlink`ing each destination first. Any new script that materializes files into these workspaces **must do the same** (or use `cp --remove-destination` / `fs.cp` with equivalent semantics).
2. **Tests re-create symlinks.** `weights.test.ts` calls `link-dev-weights.ts` on every run. Even if `copy-weights.ts` was already run, a subsequent `yarn test` (manual or otherwise) re-symlinks `neural-weights-en-us/`.

To make publish robust regardless of repo state, `scripts/publish-workspace.ts` walks the workspace's `package.json` `files` array right before publishing and dereferences any symlinks (`readlink` → `unlink` → `copyFile`). **Do not remove this safety net** — it closes the window between `copy-weights.ts` (one-shot, at `before:init`) and the actual publish.

### Pitfall: provenance attestation on a private repo

`scripts/publish-workspace.ts` only adds `--provenance` to `npm publish` when `MAILWOMAN_NPM_PROVENANCE=1` is set. npm rejects provenance signatures from private source repositories (the sigstore attestation would be unverifiable by third parties). Trusted Publishing itself works fine on private repos — it's only the attestation that needs a public source. Flip the env on once `sister-software/mailwoman` is public.

### Pitfall: `workspace:*` doesn't survive `npm publish`

`yarn 4`'s `workspace:*` protocol is yarn-specific. `npm publish` ships the literal string and consumers hit `EUNSUPPORTEDPROTOCOL`. `yarn pack` translates `workspace:*` to the concrete sibling version in the tarball. That's why `publish-workspace.ts` does pack-then-publish instead of either tool alone.

### Pitfall: `exports` carries a dev-only `node → .ts` condition — `publishConfig.exports` is what ships

Since the first-class-TS migration, every workspace's `exports` entries put a `node` condition first, pointing at the source `.ts` (plain `node` runs source in the repo, no build step), with `default`/`types` pointing at `out/`. Published tarballs ship only `out/**` — the source path would dangle — so each publishable workspace also carries `publishConfig.exports`, the same map with `node` stripped (`types` first, then `default`). `yarn pack` substitutes it into the tarball's package.json; verified against real tarballs. **When adding or changing an exports entry, update both maps** — a subpath present only in the dev map works locally and 404s for consumers.

### Recovering from a partial release

If a release fails partway through publishing:

- The git commit + tag are already created by release-it.
- `yarn npm publish --tolerate-republish` (used by `scripts/publish-workspace.ts`) makes re-publishing already-published versions a no-op.
- Fix the underlying issue, then resume by invoking the publish script directly for each remaining workspace:

  ```bash
  for ws in <remaining workspaces>; do
    RELEASE_IT_WORKSPACES_PATH_TO_WORKSPACE=./$ws \
    RELEASE_IT_WORKSPACES_TAG=latest \
    RELEASE_IT_WORKSPACES_ACCESS=public \
    RELEASE_IT_WORKSPACES_OTP=<otp-if-needed> \
    node scripts/publish-workspace.ts || break
  done
  ```

  npm 2FA OTPs expire in ~30s, so do this in quick succession; a single OTP usually covers all remaining workspaces.

## Workspace + test conventions

- **Source runs directly under `node`** (type stripping, no flags): relative imports use explicit `.ts` extensions, and each workspace tsconfig sets `rewriteRelativeImportExtensions: true` so `tsc` emits `.js` specifiers into `out/`. `erasableSyntaxOnly: true` is enforced everywhere — no `enum` (use `const X = {…} as const` + `type X = (typeof X)[keyof typeof X]`), no constructor parameter properties, no runtime namespaces. tsc rewrites dynamic `import()` string literals too, comments (`/* webpackIgnore: true */`) included.
- Each workspace has its own `tsconfig.json` + (for `core/` and `neural/`) a `vitest.config.ts` that aliases sibling `@mailwoman/*` subpath imports to source. This lets `yarn test` run without a precompile step. The cross-package aliases are fiddly — see the file headers for the resolution rules.
- `core/utils/repo.ts` has a `__isCompiledTree` flag that distinguishes source mode from compiled mode for path-builder math. Don't reach across that boundary without reading the comment.
- **`sdk/` submodules mean data acquisition** (fetch/extract/shard-provider — see `ban/sdk`, `osm/sdk`, `tiger/sdk`). CLI helpers live in `mailwoman/cli-kit/` (`useCommandTask`, `CheckList`, the command component types), the parser test harness in `mailwoman/test-kit/` — do not grow a new `sdk/cli`. The old `./sdk/cli` + `./sdk/test` subpaths are deprecated shims until the next major.
- **Data-root paths go through `@mailwoman/core/utils`** — `dataRootPath("wof", "x.db")` / `mailwomanDataRoot()` (`core/utils/data-root.ts`, a path-ts `resolvePathBuilder` over `$MAILWOMAN_DATA_ROOT`). The lab `/mnt/playpen/mailwoman-data` default lives in **exactly one place** (`data-root.ts`); never re-hardcode it in shipped code or scripts. In docs/comments/help-text reference `$MAILWOMAN_DATA_ROOT`, not the literal. The helper resolves cleanly from `scripts/` too (it's just another `@mailwoman/core/*` subpath import).
- The **bare-import + subpath-import cycle** is a fragility surface. When a test file imports `@mailwoman/core` bare AND a subpath, Vite can leave the bare re-exports unbound while the slices interleave — classifier base classes evaluate as `undefined`. (`core/resources/libpostal.ts` had a top-level `await readdir` that contributed until #481 made it a lazy `getAvailableLanguages()` getter; the cycle turned out to be **structural** — Vite's bare/subpath interleaving — not TLA-driven, so it persists after the TLA removal.) Workaround: a side-effect `import "@mailwoman/core"` at the top of the affected test file forces full init first. See `classifiers/adapter.test.ts`. Full fix = import-graph hygiene (tracked on #481).

## Database / inline SQL

If you're building building a database, remember that they are readonly artifacts which should not be modified after creation. If the script builds a database, take care to build it successfully, then move the previous version to a temp directory, and then move the new version into place. This ensures that the database is always in a consistent state, even if the build script fails halfway through.

When making a database, use Kysley as the database connector. It is a thin wrapper around SQLite that provides a simple interface for creating and querying databases and is backed by the native `node:sqlite` module. It is the only supported database connector for this repo.
If you're building building a database, remember that they are readonly artifacts which should not be modified after creation. If the script builds a database, take care to build it successfully, then move the previous version to a temp directory, and then move the new version into place. This ensures that the database is always in a consistent state, even if the build script fails halfway through.

Table DDL goes through Kysely's schema-builder, not raw `db.exec("CREATE TABLE …")`. The idiom, established across #745–#749:

- A schema module owns both the typed `Database` interface AND a co-located `createXTable(db)` function built with `db.schema.createTable(...)`. The interface is the read/write contract; the builder creates the table; a column added to one is a compile error against the other. See `resolver-wof-sqlite/{candidate,address-point,postal-city-candidate,postal-city-alias}-schema.ts`, `resolver-wof-sqlite/unified-schema.ts`, and `tiger/sdk/schema.ts`.
- `DatabaseClient` (`@mailwoman/core/kysley/client`) extends `Kysely` over `node:sqlite`. A build script constructs the raw `DatabaseSync` for its **hot positional INSERTs** (the bulk-load fast path) and wraps that _same_ handle in a `DatabaseClient` for the DDL — one connection, shared; `kdb.destroy()` owns the close. The schema-builder is async, so the DDL functions and their callers are `async`.
- `WITHOUT ROWID` has no first-class builder — use the ``.modifyEnd(sql`without rowid`)`` raw modifier. It's a win only for small-row, PK-probed tables (the candidate gazetteer, `pl_block`); never for a table carrying a large blob like geometry, where clustering the row into the B-tree _hurts_.

### What deliberately stays raw — don't "finish the job" on these

Some inline SQL is raw on purpose. If you migrate one of these thinking it was missed, you'll regress it. Each has a reason:

- **FTS5 virtual tables + `MATCH`** (`fts.ts`, `lookup.ts`, `sharding.ts`) — Kysely can't express `CREATE VIRTUAL TABLE … USING fts5` or the `MATCH` operator.
- **ogr2ogr / GDAL-dialect SQL** (`tiger/sdk/fetch.ts`) — runs inside ogr2ogr against shapefiles, not the app DB.
- **Hot bulk writes** — the positional prepared-statement INSERT loops, their `BEGIN`/`COMMIT`, and the candidate clustering `INSERT … SELECT … ORDER BY`. Plus `PRAGMA`, `VACUUM`, `ANALYZE`, `ATTACH` — none are Kysely-modelled, and the inserts are the throughput path.
- **Runtime-dynamic schemas** (`corpus/scripts/ingest-csv.ts`) — columns + types are inferred from the CSV at runtime; a builder loop wraps the same dynamic strings with ceremony and no added type safety.
- **Introspect-and-replay** (`resolver-wof-sqlite/build-slim.ts`) — it execs the _source_ DB's own `CREATE TABLE` strings read from `sqlite_master`; a static builder can't express a copied schema.
- **Async-into-sync walls** — `PlacetypeDataSource.ts` runs its DDL in a synchronous class constructor; `zcta-centroids.ts` and `coincident-roles.ts` are sync, heavily-tested helpers (the latter behind a sync CLI). Kysely's builder is async, so migrating cascades `async` through a sync call graph and rewrites the tests, all for one small table — not worth it.
- **Sync-by-interface resolver readers** — the resolution ladder is synchronous by design: `AddressPointLookup.find()`, `InterpolationLookup.find()`, `PostcodeResolver.lookup()`, and `ConventionSource.get()` (`core/resolver/types.ts`) return values synchronously, and `PostcodeResolver` is called from `@mailwoman/neural`. So the readers implementing them — `address-point.ts`, `interpolation.ts`, `postcode-point-lookup.ts`, `sqlite-convention-source.ts`, `ancestry.ts`, and the hot per-keystroke `candidate-lookup` probe — stay on raw `.prepare()`. Converting one to async Kysely doesn't cascade a few call sites; it forces the shared interface async, rippling through every implementer and across the package boundary — a structural architecture change, not a query swap. (#752's `postal-city-alias` reader was the one exception: not interface-bound, and its sole caller was already inside the async `findPlace`.)

On the query side, the migratable remainder is the cold, already-`async` `SELECT`/`INSERT` sites in the build / eval / corpus scripts — typing there is a free win with no hot-path or interface concern. The DuckDB builders need no `@oorabona/kysely-duckdb` dialect: their SQL is `read_parquet`/`ST_Read` (raw); only the SQLite output tables migrate, and those reuse the shared schema builders (see `build-postal-city-alias.ts`).

## When in doubt

Read the workspace-local docstrings before changing infrastructure files. The headers in `scripts/*.mjs`, `.release-it.json`, and `.github/workflows/*.yml` explain why each piece exists. If a file's purpose isn't documented inline and you're about to touch it, add the docstring as part of your change — future-you (or future-claude) will thank you.

## Addendum

- We use a version of Node.js that can strip types without any additional CLI flags. This is appropriate for everything but the Ink/Pastel commands, which are TSX and require compiling.

### Acronym casing in identifiers

Acronyms are capitalized as whole camelCase components: `createWOFResolver`, `parseJSON`, `readID`, `fetchOSM`, `WOFSqlitePlaceLookup`, `modelURL`. Not `createWofResolver` / `parseJson` / `readId`. This applies to TS/TSX identifiers (functions, classes, types, interfaces, object properties) and the code examples in living reference docs. It does **not** touch:

- **`snake_case`** — DB columns and wire keys (`parent_id`, `place_id`, `name_key`) stay as-is; they're string contracts, and the convention is camelCase-only by construction.
- **External library names** — match the dependency's own casing (`HttpStatusCode` from axios, `createQueryId`/`createWithSql` from kysely, `sqlite-wasm`).
- **Pastel/Ink CLI flag props** — the framework binds a kebab flag to a lowercase-acronym prop (`--resolve-db` → `resolveDb`), so those specific schema keys must match its derivation. Result-read fields and domain properties (`result.placeID`) still follow the convention.
- **Dated historical records** — `docs/articles/evals/`, `reviews/`, postmortems, and phase docs are point-in-time; don't rewrite their acronyms.

There's no lint rule for this (oxlint can't express it); it's reviewer discipline. When adding an acronym, cap the whole component.

**Known gaps (#875):** the v5.0.0 sweep enumerated a fixed acronym list that omitted `Us` and generic `Json`/`Jsonl`. `recognizeUsRegions` → `recognizeUSRegions` is done (internal). Still pending: `isUsStateAbbreviation` + codex `us/*` (public `@mailwoman/codex` → breaking), and the whole `Json`/`Jsonl` family (`writeJsonl`, `readJsonl`, `fetchJson`, `GeoJsonFeatureCollection`, `pyJsonDumps`, … — ~28 identifiers across packages, some public). These are a version-gated batch, not a piecemeal fix — bundle with the next major, don't half-apply (a partial `Json` sweep half-renames callers vs their def).
