# Mailwoman Scripts

This is not a dumping ground for all manner of one-off scripts. If you're considering adding a new script, ask yourself: is this a one-off, or is it a reusable tool?

If you are adding a new diagnostic script, it should be written preferably in TypeScript, or Python if absolutely necessary. If you do need somewhere to put a one-off script, add it to @./scratchpad/ which is ignored by git automatically.
Consider adding a new command to @./mailwoman/commands or an eval harness command to @./mailwoman/eval-harness/ instead of adding a new script. Also consider adding an MCP tool if the script is a reusable.

BE VIGILANT ABOUT CODE DUPLICATION.

## Build Scripts

Scripts for building the training corpus, model artifacts, or other reusable outputs. These are not part of the training pipeline, but they are useful for preparing data or artifacts for training. In almost all cases these are better served as commands in @./mailwoman/commands. Ideally a human operator can run these commands to reproduce the training corpus or model artifacts without needing to understand the details of the training pipeline.

## Diagnostic Scripts

Scripts for inspecting the training data, model, or artifacts. These are not part of the training pipeline, but they are useful for debugging and understanding the model's behavior. By default these are ignored by git. It should be placed in `scripts/eval/` or `scripts/diagnostic/`.

# Addendum

- We use a version of Node.js that can strip types without any additional CLI flags. TSX command components still require compiling.
- Never use `require()` in a script. Use `import` instead.
- Never use .mjs file, .sh file. Use .ts or .tsx instead.
- If you're building building a database, remember that they are readonly artifacts which should not be modified after creation. If the script builds a database, take care to build it successfully, then move the previous version to a temp directory, and then move the new version into place. This ensures that the database is always in a consistent state, even if the build script fails halfway through.
- When making a database, use Kysley as the database connector. It is a thin wrapper around SQLite that provides a simple interface for creating and querying databases and is backed by the native `node:sqlite` module. It is the only supported database connector for this repo.
- Every built SQLite DB is SEALED read-only (chmod 0444) by `sealDatabase` (`@mailwoman/core/utils`). Never reopen a shipped DB read-write — rebuild it. `openBuiltDatabase` enforces this with a named error.
- The gazetteer builders live in `mailwoman/gazetteer-pipeline/` behind `mailwoman gazetteer build …` — NOT here. Do not add new DB build/mutation scripts to this directory; extend the pipeline module and its commands instead (see docs/superpowers/specs/2026-07-07-scripts-cleanup-gazetteer-cli-design.md).

## The drawer is closed (2026-07-07; specs: 2026-07-07-scripts-cleanup-gazetteer-cli-design.md + 2026-07-07-scripts-drawer-to-zero.md in docs/superpowers/specs/)

`scripts/` holds ONLY four things:

1. **Release tooling** (`publish-workspace`, `copy-weights`, `bless-package`, `check-release-parity`, `verify-*`, `rewrite-workspace-imports`, `release-workspace-repository.test`) + **CI smoke** (`smoke-*`) — the release pipeline's residents.
2. **Codegen + lint tooling** (`generate-*`, `lint-*`, `jsonl-to-parquet`) — candidates for a future `mailwoman dev` namespace.
3. **`eval/`** — CI and release probes plus Python calibration scripts and helpers in `eval/lib/`.
   Command implementations live in `mailwoman/eval-harness/` behind `mailwoman eval …`.
   `eval/oa-resolver-eval.ts` forwards existing direct invocations to that implementation.
4. **`diagnostic/`** — gitignored one-off investigations.
   - This has since been deprecated in favor of `eval/` and `mailwoman eval …` commands. If you're reaching for this it means you should be adding a new `mailwoman eval …` command or updating the mailwoman-dev MCP.

Everything else lives where it belongs: gazetteer builders → `mailwoman/gazetteer-pipeline/` (`mailwoman gazetteer …`); corpus tools → `mailwoman/corpus-tools/` (`mailwoman corpus …`); coarse-placer training → `core/coarse-placer/tools/`; matcher-only tools + viz → `registry/tools/`; census/TIGER tools → `tiger/tools/`; the Modal training launcher → `corpus-python/modal/train_remote.py`. There is no `scripts/lib/` — use `node:util` `parseArgs` and `@mailwoman/core/utils`. Do NOT add new builders, mutators, or shared-lib dirs here.

Two flat files are shared on purpose, and one of them used to be a third:

- `weights-recipe.ts` reads `release.config.json`'s `weights` + `softFeed` blocks and resolves them to absolute paths. Shared by `copy-weights.ts` (release) and `link-weights-overlay.ts` (dev), which is the point: the recipe previously had a third home in ten hardcoded `DEFAULT_MODEL` constants, and the 9.0.0 reduce moved only one of the three. It lives here rather than in a workspace because `release.config.json` is repo-only and a package cannot reach outside its `rootDir` to read it (`TS6059`).
- `link-weights-overlay.ts` populates `$MAILWOMAN_DATA_ROOT/weights/<locale>/` from that recipe, for the overlay rung in `@mailwoman/neural`'s `resolveWeights`.

`weights-overlay-linker.ts` is NOT here. It moved to `@mailwoman/resolver-wof-sqlite/weights-overlay-linker` in the workspace regroup and each overlay's `scripts/link-dev-weights.ts` imports it by package subpath — this file described it as a `scripts/` resident for some time after it left, which is the quoted-literal drift the root `AGENTS.md` warns about after a move.

These are shared halves of existing residents, not a `lib/` drawer. A third wanting to join is the signal to reconsider the drawer, not to add a fourth.

## Zero raw `process.env` / `process.argv` (enforced)

The custom `sister-software/no-process-globals` oxlint rule ERRORS on any direct
`process.env`/`process.argv` access; the blessed sites (`core/env/`, `core/scripting/utils/`)
carry explicit `oxlint-disable-next-line` comments. It runs in `yarn lint`, the pre-commit hook,
and the Test workflow. Use `$public`/`$private` for config, `node:util` `parseArgs` for arguments
(its default is already `process.argv.slice(2)` — never pass `args:` yourself),
`cliArguments()`/`childEnv()`/`scriptEntryPath()` from `@mailwoman/core/scripting/utils` (and
`runIfScript` from `@mailwoman/core/scripting`) for the edge cases, and `vi.stubEnv` in tests.
