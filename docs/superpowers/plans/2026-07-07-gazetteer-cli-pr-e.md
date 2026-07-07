# Gazetteer CLI PR E: the last ports — drawer endgame (#1029)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline). The established
> pattern (PR B Tasks 5–8, PR D Task 1): script body → pipeline function (verbatim, seal kept),
> `parseArgs` → zod options, thin Ink command; tsc + lint per commit; per-family commits.

**Goal:** Finish #1029 — every remaining builder becomes a `gazetteer`/`corpus` command, `fst-query` becomes `inspect fst`, and `scripts/AGENTS.md` declares the drawer closed (release hooks + CI smoke + lint/codegen + `eval/` + `diagnostic/` only).

### Task 1: postcode-locality family → `gazetteer-pipeline/postcode-locality/`

- Move the four builders' bodies: `build-postcode-locality.ts` → `base.ts` (`buildPostcodeLocalityBase`), `-cjk.ts` → `jp.ts`, `-kr.ts` → `kr.ts`, `-tw.ts` → `tw.ts` — verbatim (each already seals); `parseArgs` blocks become option interfaces with the same defaults.
- Command: `mailwoman/commands/gazetteer/build/postcode-locality.tsx` — `--recipe base|jp|kr|tw` + the union of per-recipe options (documented per recipe in `--help`).
- Delete the four scripts; straggler `rg`; commit.

### Task 2: nl-pc6 + pilot-anchor → pipeline + commands

- `build-postalcode-nl-pc6.ts` → `gazetteer-pipeline/postcode/nl-pc6.ts` (`buildNLPC6Shard`); command `gazetteer build postcode-shard` gains `--recipe pc6` OR a sibling `nl-pc6.tsx` command (pick whichever keeps `postcode-shard.tsx` untouched — sibling preferred).
- `build-pilot-anchor-lookup.ts` → `gazetteer-pipeline/anchor-lookup.ts` (`buildAnchorLookup`, LIVE consumer: neural/scorer + evals); command `gazetteer build anchor-lookup`. JSON output isn't a DB — no seal, but write-once semantics noted.
- Delete both scripts; commit.

### Task 3: corpus trio → `mailwoman corpus` commands

- `build-corpus-stats.ts` → `corpus stats` command; `align-canonical-shard.ts` → `corpus align-shard`; `assemble-overlay-manifest.ts` → `corpus overlay-manifest`. Bodies move to `mailwoman/corpus-tools/` (or inline in the command file when under 100 lines and dependency-light — align/assemble qualify).
- `lint-corpus-shard.ts` consumes `corpus-stats.json` via `--stats` — unchanged (stays as lint tooling).
- Delete the three scripts; commit.

### Task 4: `fst-query.ts` → `gazetteer inspect fst`; endgame

- Move the probe into `commands/gazetteer/inspect/fst.tsx`; delete the script.
- `scripts/AGENTS.md`: declare the endgame — the drawer holds ONLY release-it hooks, CI smoke, lint/codegen tooling, `eval/`, `diagnostic/`; new builders go in `gazetteer-pipeline`/commands, PERIOD.
- Final sweep: `ls scripts/*.ts` must be exactly the allowed residents; full tsc + tests + compile + `--help` smokes; commit.

### Task 5: E2E + PR

- E2E the cheap recipes: `gazetteer build postcode-shard` sibling nl-pc6 (fast, CBS source permitting) + `inspect fst` smoke vs the shipped FST. The heavy locality recipes (jp/kr/tw) are typecheck+compile-validated; their next data refresh runs through the commands (noted in #1029).
- Close #1029 via the PR; update the spec's status line.
