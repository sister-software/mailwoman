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

`scripts/` holds ONLY two things:

1. **Codegen tooling** (`generate-*`) — candidates for a future `mailwoman dev` namespace. The man page's generator already made that move: `mailwoman dev generate man-page`.
   The repository health checks (the debt counters, `verify-exports`, `verify-test-contract`, `verify-version-sync`, the vocabulary census, the reach-around and runtime-flag guards, the test type-check) are not here either — they are registered checks in `packages/repo-health/lib/checks/`, run as `yarn mwops health <id>|all`.
2. **`diagnostic/`** — gitignored one-off investigations.
   - This has since been deprecated in favor of `mailwoman eval …` commands. If you're reaching for this it means you should be adding a new `mailwoman eval …` command or updating the mailwoman-dev MCP.

The release and weights family (`publish-workspace`, `copy-weights`, `bless-package`, `check-release-parity`, `verify-release-metadata`, `smoke-clean-install`, the weights recipe and overlay writer) is not here either: it lives in `@mailwoman/release-kit` as registered operations (`packages/release-kit/lib/registry.ts`), each run as `yarn mwops release <operation>`; `yarn mwops` lists them with their declared effect.

There is no `scripts/eval/` any more. Its residents were triaged one destination per file: a probe a
record cites is `packages/mailwoman/lib/dev-tools/<name>.run.ts` (run from source with
`node packages/mailwoman/lib/dev-tools/<name>.run.ts`, header naming the record); a question a
`mailwoman eval …` command already answers is that command; the Python calibration fitters live in
`corpus-python/scripts/`; the FR bare-street fixture is `packages/mailwoman/lib/eval-harness/fixtures/`;
everything cited by nothing was deleted. The `debt` check's `scriptsUnreferenced` counter (`packages/repo-health`) is the
ratchet — a script here that no workflow, hook, `package.json` or `.release-it.json` names is debt.

Everything else lives where it belongs: gazetteer builders → `mailwoman/gazetteer-pipeline/` (`mailwoman gazetteer …`); corpus tools → `mailwoman/corpus-tools/` (`mailwoman corpus …`); coarse-placer training → `core/coarse-placer/tools/`; matcher-only tools + viz → `registry/tools/`; census/TIGER tools → `tiger/tools/`; the Modal training launcher → `corpus-python/modal/train_remote.py`. There is no `scripts/lib/` — use `node:util` `parseArgs` and `@mailwoman/core/utils`. Do NOT add new builders, mutators, or shared-lib dirs here.

The weights recipe (`weights-recipe.ts`, which reads `release.config.json`'s `weights` + `softFeed` blocks and resolves them to absolute paths) and the overlay writer (`link-weights-overlay.ts`, which populates `$MAILWOMAN_DATA_ROOT/weights/<locale>/` from that recipe for the overlay rung in `@mailwoman/neural`'s `resolveWeights`) are NOT here either: both live under `packages/release-kit/lib/weights/`, beside `copy-weights.ts`, which shares the recipe with the overlay writer — the point of the recipe, which previously had a third home in ten hardcoded `DEFAULT_MODEL` constants. The typed reader of `release.config.json` itself is `@mailwoman/core/release-config`.

`weights-overlay-linker.ts` is NOT here. It moved to `@mailwoman/resolver-wof-sqlite/weights-overlay-linker` in the workspace regroup and each overlay's `scripts/link-dev-weights.ts` imports it by package subpath — this file described it as a `scripts/` resident for some time after it left, which is the quoted-literal drift the root `AGENTS.md` warns about after a move.

There is no `lib/` drawer here. A shared helper wanting to join is the signal to give it a workspace home, not to add it.

## Zero raw `process.env` / `process.argv` (enforced)

The custom `sister-software/no-process-globals` oxlint rule ERRORS on any direct
`process.env`/`process.argv` access; the blessed sites (`core/env/`, `core/scripting/utils/`)
carry explicit `oxlint-disable-next-line` comments. It runs in `yarn lint`, the pre-commit hook,
and the Test workflow. Use `$public`/`$private` for config, `node:util` `parseArgs` for arguments
(its default is already `process.argv.slice(2)` — never pass `args:` yourself),
`cliArguments()`/`childEnv()`/`scriptEntryPath()` from `@mailwoman/core/scripting/utils` (and
`runIfScript` from `@mailwoman/core/scripting`) for the edge cases, and `vi.stubEnv` in tests.
