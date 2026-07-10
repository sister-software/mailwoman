# Pastel Arc Phase 1: corpus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `corpus/scripts/` deleted; every corpus tool lives in `corpus/src/tools/` behind a `mailwoman corpus …` command; the fetch family shares one download/manifest util built on Phase 0's `sha256File`.

**Architecture:** Tool modules follow the spec's contract — `export async function run(options, report?)`, no argv, no `process.exit`, throw on failure. Commands are thin TSX using `useCommandTask` from `mailwoman/cli-kit`. The corpus workspace (the `src/`-nested exception) gains a `./tools` subpath export (dual maps). `mailwoman/corpus-tools/` absorbs into `corpus/src/tools/` so the corpus workspace owns all corpus logic.

**Tech Stack:** Phase 0 helpers (`sha256File`, `readJSONL`/`writeJSONL`), `useCommandTask`/`CheckList`, Pastel zod options, vitest.

## Global Constraints

- Tool modules: `run(options, report?: (line: string) => void)` — stderr narration goes through `report` (commands wire it to `console.error`), never direct `process.exit`.
- Dual exports maps for the new `@mailwoman/corpus/tools` subpath.
- Fetch modules keep their per-source behaviors byte-comparable: skip-if-sha-matches, manifest preservation, polite delays, failure exit semantics (module returns `{fetched, skipped, failed, failedCodes}`; the command maps `failed > 0` → exit 1).
- Deletions only after the replacement command's real invocation is verified.

---

### Task 1: shared fetch util — `corpus/src/tools/fetch/shared.ts`

`downloadToFile({url, dest, timeoutMs, retries, retryDelayMs})` (AbortSignal.timeout fetch → file, transient-status retry loop), `isTransientStatus(status)`, `BanFetchManifestEntry`-style generic `readManifestEntries<T>(path, key)` / `writeManifestEntries(path, entries, sortKey)` built on `sha256File` from `@mailwoman/core/utils`. Consolidates the 6 `downloadToFile` + 2 `isTransientStatus` + 9 manifest-write clones. Unit test with a local `node:http` server fixture (success, 500-retry, timeout).

### Task 2: exemplar — `corpus audit`

- `corpus/scripts/audit.ts` → `corpus/src/tools/audit.ts`: keep `audit(opts)` + internals; drop `parseArgv`/`runIfScript`/shebang. `audit.test.ts` moves alongside, import updated.
- `corpus/src/tools/index.ts` barrel + `./tools` subpath in both corpus exports maps.
- New `mailwoman/commands/corpus/audit.tsx`: zod options `{dir (positional via args tuple), config?, sample?}` → calls `audit()` via `useCommandTask`.
- Verify: `node mailwoman/out/cli.js corpus audit /nonexistent` prints the zero-shard report, exit 0; moved test passes.

### Task 3: fetch family (mechanical replication of the exemplar pattern — delegable)

For each of ban-full→`ban`, nad, hrsa, imls-pls, nppes, openaddresses, state-sources, state-hi-schools, tiger-full:

- `corpus/scripts/fetch-sources/fetch-<x>.ts` (and `fetch-nad.ts`) → `corpus/src/tools/fetch/<x>.ts` exporting `fetch<X>(options: {outRoot: string, …source-specific}, report): Promise<FetchSummary>` where `FetchSummary = {fetched: number, skipped: number, failed: number, failedCodes: string[]}`.
- Replace local sha256/download/manifest helpers with Task 1's shared util + core `sha256File`; replace `process.stderr.write` with `report()`; replace `process.exitCode = 1` with the returned summary; `$public.OUT_ROOT` default handling moves to the command's zod default.
- `corpus/src/tools/fetch/index.ts`: `export const FETCH_SOURCES = { ban: fetchBan, … } as const` + `export type FetchSourceID = keyof typeof FETCH_SOURCES`.
- `mailwoman/commands/corpus/fetch.tsx`: `args = zod.tuple([zod.enum(Object.keys(FETCH_SOURCES))])`, options `{outRoot: zod.string().default("data/corpus/sources")}` (+ the union of source-specific options, each optional and documented per source); exit 1 when `failed > 0`.
- `fetch-sources/README.md` content moves to a docstring in `fetch/index.ts`.

### Task 4: shard + golden

- `build-kryptonite-shard.ts` → `tools/shard-kryptonite.ts` (`run(options)` = old `main` minus parse; parquet + manifest composition unchanged); `build-transliteration-shard.ts` → `tools/shard-translit.ts` likewise (local `readJsonl`/`hashFile` replaced by core `iterateJSONL`/`sha256File`).
- Existing `commands/corpus/shard.tsx` → `commands/corpus/shard/index.tsx` with `isDefault = true` (bare `corpus shard` unchanged); new `shard/kryptonite.tsx` + `shard/translit.tsx`.
- `expand-golden.ts` → `tools/golden-expand.ts`; `promote-golden.ts` → `tools/golden-promote.ts` (its local `readJsonl`/`writeJsonl`/inline sha256 → core helpers); commands `golden/expand.tsx` + `golden/promote.tsx`.

### Task 5: corpus-tools absorption + deletions

- `mailwoman/corpus-tools/{align-shard,corpus-stats,overlay-manifest}.ts` → `corpus/src/tools/` (overlay-manifest's inline `createHash` → core `sha256Hex`); repoint `commands/corpus/{align-shard,stats,overlay-manifest}.tsx`; delete `mailwoman/corpus-tools/`.
- Delete `corpus/scripts/` entirely — `run-corpus-build.ts` is a hardcoded v0.3.0 recipe of `mailwoman corpus build --inputs` (verified: build.tsx drives `buildCorpus` with arbitrary adapter inputs).

### Task 6: phase gate

- `yarn lint`, `yarn compile`, `yarn typecheck:scripts` clean; corpus + mailwoman vitest green.
- Smokes: `corpus audit` real run; `corpus fetch --help`; `corpus fetch imls-pls --out-root <scratch>` (the smallest real source, one file) end-to-end including manifest + sha; `corpus shard kryptonite` / `golden promote` `--help` + missing-required error paths.
- `grep -rn 'corpus/scripts' --include='*.ts*' .` → zero live references (docs/history excluded).
- Merge to main (local), delete branch.
