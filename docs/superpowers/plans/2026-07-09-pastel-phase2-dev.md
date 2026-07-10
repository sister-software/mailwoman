# Pastel Arc Phase 2: `mailwoman dev` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The codegen/lint scripts leave `scripts/` for owning-workspace tool modules behind a new `mailwoman dev` command group; the two dead scripts die.

**Architecture:** Same pattern as Phase 1 (exemplars: `corpus/src/tools/audit.ts` + `mailwoman/commands/corpus/audit.tsx`). New subpath exports: `@mailwoman/codex/tools`, `@mailwoman/core/tools` (dual maps). `mailwoman/dev-tools/` is an internal directory (commands import it relatively; no subpath).

## Mapping

| Command                           | Source script                                                | Tool module                                                      | Exported fn                 |
| --------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------- | --------------------------- |
| `dev generate country-reference`  | `scripts/generate-country-reference.ts`                      | `codex/tools/generate-country-reference.ts`                      | `generateCountryReference`  |
| `dev generate official-languages` | `scripts/generate-official-languages.ts`                     | `codex/tools/generate-official-languages.ts`                     | `generateOfficialLanguages` |
| `dev generate language-types`     | `scripts/generate-language-types.ts`                         | `core/tools/generate-language-types.ts`                          | `generateLanguageTypes`     |
| `dev generate trace-fixture`      | `scripts/generate-trace-fixture.ts`                          | `mailwoman/dev-tools/generate-trace-fixture.ts`                  | `generateTraceFixture`      |
| `dev lint mdx-angles`             | `scripts/lint-mdx-angles.ts`                                 | `mailwoman/dev-tools/lint-mdx-angles.ts`                         | `lintMDXAngles`             |
| `dev lint corpus-shard`           | `scripts/lint-corpus-shard.ts` (+ `scripts/lint-rules.json`) | `corpus/src/tools/lint-shard.ts` (+ `lint-rules.json` beside it) | `lintCorpusShard`           |
| `dev lint shard-vocab`            | `scripts/lint-shard-vocab.ts`                                | `corpus/src/tools/lint-shard-vocab.ts`                           | `lintShardVocab`            |
| `dev jsonl-to-parquet`            | `scripts/jsonl-to-parquet.ts`                                | `corpus/src/tools/jsonl-to-parquet.ts`                           | `jsonlToParquet`            |

Lint tools return a findings summary (`{errors: number, warnings: number, findings: …}`); commands exit 1 when `errors > 0` — preserve each script's current exit semantics exactly.

**Deletions:** `scripts/generate.ts` (dead WOF port, unref), `docs/scripts/build-demo-assets.ts` (self-deprecated; check docs/package.json scripts for a reference first).

**Gate:** codegen parity — run each `dev generate …` command and `git diff --stat` the regenerated outputs: identical or byte-empty diffs on same inputs (country-reference + official-languages fetch upstream sources — run only if offline caches allow; otherwise `--help` + a dry/limited invocation and note it). Lint commands run against a known-clean fixture (exit 0) and `yarn compile`/`yarn lint`/tests green. `scripts/` top level afterwards = release tooling + configs only.
