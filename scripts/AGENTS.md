# Mailwoman Scripts

This is not a dumping ground for all manner of one-off scripts. If you're considering adding a new script, ask yourself: is this a one-off, or is it a reusable tool?

If you are adding a new diagnostic script, it should be written preferably in TypeScript, or Python if absolutely necessary.

## Build Scripts

Scripts for building the training corpus, model artifacts, or other reusable outputs. These are not part of the training pipeline, but they are useful for preparing data or artifacts for training. In almost all cases these are better served as Ink/Pastel commands in @./mailwoman/commands. Ideally a human operator can run these scripts to reproduce the training corpus or model artifacts without needing to understand the details of the training pipeline.

## Diagnostic Scripts

Scripts for inspecting the training data, model, or artifacts. These are not part of the training pipeline, but they are useful for debugging and understanding the model's behavior. By default these are ignored by git. It should be placed in `scripts/eval/` or `scripts/diagnostic/`.

# Addendum

- We use a version of Node.js that can strip types without any additional CLI flags. This is appropriate for everything but the Ink/Pastel commands, which are TSX and require compiling.
- Never use `require()` in a script. Use `import` instead.
- Never use .mjs file, .sh file. Use .ts or .tsx instead.
- If you're building building a database, remember that they are readonly artifacts which should not be modified after creation. If the script builds a database, take care to build it successfully, then move the previous version to a temp directory, and then move the new version into place. This ensures that the database is always in a consistent state, even if the build script fails halfway through.
- When making a database, use Kysley as the database connector. It is a thin wrapper around SQLite that provides a simple interface for creating and querying databases and is backed by the native `node:sqlite` module. It is the only supported database connector for this repo.
- Every built SQLite DB is SEALED read-only (chmod 0444) by `sealDatabase` (`@mailwoman/core/utils`). Never reopen a shipped DB read-write — rebuild it. `openBuiltDatabase` enforces this with a named error.
- The gazetteer builders live in `mailwoman/gazetteer-pipeline/` behind `mailwoman gazetteer build …` — NOT here. Do not add new DB build/mutation scripts to this directory; extend the pipeline module and its commands instead (see docs/superpowers/specs/2026-07-07-scripts-cleanup-gazetteer-cli-design.md).

## The drawer is closed (2026-07-07, spec: docs/superpowers/specs/2026-07-07-scripts-cleanup-gazetteer-cli-design.md)

`scripts/` holds ONLY: release-it hooks + publish tooling (`publish-*`, `copy-weights`, `bless-package`, `check-release-parity`, `verify-*`, `rewrite-workspace-imports`, `release-workspace-repository.test`), CI smoke (`smoke-*`), lint + codegen tooling (`lint-*`, `generate-*`, `jsonl-to-parquet`), and the gitignored `eval/` + `diagnostic/` harnesses. Data builders live in `mailwoman/gazetteer-pipeline/` behind `mailwoman gazetteer …`; corpus tools in `mailwoman/corpus-tools/` behind `mailwoman corpus …`. Do NOT add new builders or DB-touching scripts here.
