# AGENTS.md

Notes for AI agents (and humans) working on this repo.

## Orientation

Mailwoman is a postal-address parser shipped as one root npm package (`mailwoman`) plus six scoped workspaces (`@mailwoman/{core,classifiers,corpus,neural,neural-weights-en-us,neural-weights-fr-fr}`). The monorepo orchestration package is `@mailwoman/universe` (private, not published).

| Workspace               | npm package                       | Purpose                                                                                                                                                   |
| ----------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mailwoman/`            | `mailwoman`                       | CLI + high-level `AddressParser` (the user-facing entry)                                                                                                  |
| `core/`                 | `@mailwoman/core`                 | Tokenization, classification primitives, solver, decoder, policy registry. Ships ~9 MB of libpostal + WOF + chromium-i18n dictionaries under `core/data/` |
| `codex/`                | `@mailwoman/codex`                | Per-address-system postal reference data + branded types (USPS street suffixes, US ZIP codes). Pure, zero-runtime-dep; consumed by the parser + corpus    |
| `classifiers/`          | `@mailwoman/classifiers`          | Rule-based classifiers                                                                                                                                    |
| `corpus/`               | `@mailwoman/corpus`               | BIO-labeled training-corpus pipeline                                                                                                                      |
| `neural/`               | `@mailwoman/neural`               | SentencePiece tokenizer + ONNX runtime + decoder wiring                                                                                                   |
| `neural-weights-en-us/` | `@mailwoman/neural-weights-en-us` | Trained model bundle (en-us locale)                                                                                                                       |
| `neural-weights-fr-fr/` | `@mailwoman/neural-weights-fr-fr` | Trained model bundle (fr-fr locale)                                                                                                                       |
| `docs/`                 | N/A                               | Documentation, including the implementation plan that drove the neural classifier work. Published to https://mailwoman.sister.software                    |

Source files live at each workspace's root (no `src/` nesting). The repo root holds workspace config + `scripts/` + `docs/` only.

## Where to read next

- **[`docs/articles/concepts/what-mailwoman-is.mdx`](./docs/articles/concepts/what-mailwoman-is.mdx)** — what the system _is_ (a calibrated, retrieval-augmented sequence labeler), the grammar/atlas division of labor, and the disciplines that keep the architecture honest. Read this first if you're new to the project entirely.
- **[`docs/articles/plan/README.mdx`](./docs/articles/plan/README.mdx)** — the implementation plan that drove the neural classifier work. Phases 0–3 are substantially shipped; Phases 4–6 are the forward roadmap. Read this first if you're working on anything model-related.
- **[`docs/articles/plan/reference/`](./docs/articles/plan/reference/)** — design rationale, schema source of truth, TS contracts, operations playbook, address-data-sources catalog. `SCHEMA.mdx` is the single source of truth for the `ComponentTag` union.
- **[`docs/articles/plan/CONTRIBUTING_MODEL_WORK.mdx`](./docs/articles/plan/CONTRIBUTING_MODEL_WORK.mdx)** — the model-work runbook: which evals gate a change, the lever-shape taxonomy, how to add a shard. Read before touching the model, a shard recipe, or an eval.
- **[`docs/articles/plan/reference/coverage-overlay.mdx`](./docs/articles/plan/reference/coverage-overlay.mdx)** — the demo-map address-coverage ("fog of war") overlay runbook: rebuild/republish (the `coverage build` + `tiles publish` CLIs), the `nexus-assets` upload/credential gotchas, the HI/NH data situation, tuning knobs. Read before touching the coverage overlay, the `tile-worker`, or `coverage build`.
- **[`RELEASING.md`](./RELEASING.md)** — local and CI release flows. Read before cutting a release.
- **[`docs/articles/evals/`](./docs/articles/evals/)** — eval reports per training step. The per-model score ledger lives at `evals/scores-by-version.json` (repo root), schema in `docs/articles/plan/reference/eval-ledger.schema.json`. The authoritative per-tag parity table is the latest `parity-scorecard-*.md`.

## Release pipeline pitfalls

Local: `yarn release`. CI: GitHub Actions → `publish` workflow → manual dispatch. See `RELEASING.md` for setup + flow. The notes below cover the gotchas that have bitten this pipeline before — read before touching `scripts/copy-weights.mjs`, `scripts/publish-workspace.mjs`, or `.release-it.json`.

### The weights workspaces have moving binaries

The `neural-weights-<locale>` workspaces ship binary artifacts (`model.onnx`, `tokenizer.model`) that are **not** committed to git. Multiple pieces cooperate to get those files in place — be careful when changing any of them:

- `<workspace>/scripts/link-dev-weights.sh` — symlinks the artifacts from `/mnt/playpen/mailwoman-data/...` into the workspace so `@mailwoman/neural` can find them during local dev.
- `neural/test/weights.test.ts` — invokes `link-dev-weights.sh` to verify auto-resolve. **Running `yarn test` re-creates the symlinks** in `neural-weights-en-us/` as a side effect.
- `scripts/copy-weights.mjs` — invoked by release-it's `before:init` hook. Materializes the real binaries into each workspace. Skipped in CI when `MAILWOMAN_SKIP_WEIGHTS_COPY=1` (the default for the `publish` workflow when `release_weights=false`).
- `scripts/publish-workspace.mjs` — invoked per workspace by release-it. Calls `yarn pack -o <tmp>` (translates `workspace:*` → concrete versions) then `npm publish <tmp>` (npm CLI handles npm-side auth, including Trusted Publishing OIDC in CI).

### Pitfall: symlinks in the publish tarball

`yarn npm publish` (and `npm publish`) refuse to upload tarballs containing symlinks — the registry returns HTTP 415 (`YN0035: Symbolic link is not allowed`). Two specific traps make this easy to hit:

1. **`fs.copyFile` follows symlinks at the destination.** A naïve `fs.copyFile(SOURCE, dest)` where `dest` is a symlink writes through the symlink — the symlink stays in place. `scripts/copy-weights.mjs` mitigates this by `unlink`ing each destination first. Any new script that materializes files into these workspaces **must do the same** (or use `cp --remove-destination` / `fs.cp` with equivalent semantics).
2. **Tests re-create symlinks.** `weights.test.ts` calls `link-dev-weights.sh` on every run. Even if `copy-weights.mjs` was already run, a subsequent `yarn test` (manual or otherwise) re-symlinks `neural-weights-en-us/`.

To make publish robust regardless of repo state, `scripts/publish-workspace.mjs` walks the workspace's `package.json` `files` array right before publishing and dereferences any symlinks (`readlink` → `unlink` → `copyFile`). **Do not remove this safety net** — it closes the window between `copy-weights.mjs` (one-shot, at `before:init`) and the actual publish.

### Pitfall: provenance attestation on a private repo

`scripts/publish-workspace.mjs` only adds `--provenance` to `npm publish` when `MAILWOMAN_NPM_PROVENANCE=1` is set. npm rejects provenance signatures from private source repositories (the sigstore attestation would be unverifiable by third parties). Trusted Publishing itself works fine on private repos — it's only the attestation that needs a public source. Flip the env on once `sister-software/mailwoman` is public.

### Pitfall: `workspace:*` doesn't survive `npm publish`

`yarn 4`'s `workspace:*` protocol is yarn-specific. `npm publish` ships the literal string and consumers hit `EUNSUPPORTEDPROTOCOL`. `yarn pack` translates `workspace:*` to the concrete sibling version in the tarball. That's why `publish-workspace.mjs` does pack-then-publish instead of either tool alone.

### Recovering from a partial release

If a release fails partway through publishing:

- The git commit + tag are already created by release-it.
- `yarn npm publish --tolerate-republish` (used by `scripts/publish-workspace.mjs`) makes re-publishing already-published versions a no-op.
- Fix the underlying issue, then resume by invoking the publish script directly for each remaining workspace:

  ```bash
  for ws in <remaining workspaces>; do
    RELEASE_IT_WORKSPACES_PATH_TO_WORKSPACE=./$ws \
    RELEASE_IT_WORKSPACES_TAG=latest \
    RELEASE_IT_WORKSPACES_ACCESS=public \
    RELEASE_IT_WORKSPACES_OTP=<otp-if-needed> \
    node scripts/publish-workspace.mjs || break
  done
  ```

  npm 2FA OTPs expire in ~30s, so do this in quick succession; a single OTP usually covers all remaining workspaces.

## Workspace + test conventions

- Each workspace has its own `tsconfig.json` + (for `core/` and `neural/`) a `vitest.config.ts` that aliases sibling `@mailwoman/*` subpath imports to source. This lets `yarn test` run without a precompile step. The cross-package aliases are fiddly — see the file headers for the resolution rules.
- `core/utils/repo.ts` has a `__isCompiledTree` flag that distinguishes source mode from compiled mode for path-builder math. Don't reach across that boundary without reading the comment.
- The **bare-import + subpath-import cycle** is a fragility surface. When a test file imports `@mailwoman/core` bare AND a subpath, Vite can leave the bare re-exports unbound while the slices interleave — classifier base classes evaluate as `undefined`. (`core/resources/libpostal.ts` had a top-level `await readdir` that contributed until #481 made it a lazy `getAvailableLanguages()` getter; the cycle turned out to be **structural** — Vite's bare/subpath interleaving — not TLA-driven, so it persists after the TLA removal.) Workaround: a side-effect `import "@mailwoman/core"` at the top of the affected test file forces full init first. See `classifiers/adapter.test.ts`. Full fix = import-graph hygiene (tracked on #481).

## Database / inline SQL

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

Two threads are still open, not "raw forever": the DuckDB sites want `@oorabona/kysely-duckdb` (a separate dialect), and the bulk read/write `.prepare("SELECT …" / "INSERT …")` query sites are a later query-builder sweep.

## When in doubt

Read the workspace-local docstrings before changing infrastructure files. The headers in `scripts/*.mjs`, `.release-it.json`, and `.github/workflows/*.yml` explain why each piece exists. If a file's purpose isn't documented inline and you're about to touch it, add the docstring as part of your change — future-you (or future-claude) will thank you.
