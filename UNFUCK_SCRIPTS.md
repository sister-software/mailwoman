# UNFUCK_SCRIPTS.md — Triaging the scripts drawer to zero

**Date:** 2026-07-07 · **Status:** COMPLETE + **MECHANICALLY ENFORCED** (PRs #1032 → #1033 → #1034 → #1035)
**The end state:** ZERO raw `process.env`/`process.argv` outside two blessed homes — `core/env/`
(the `$public`/`$private` implementation) and `core/utils/scripting.ts` (`cliArguments`, `childEnv`,
`scriptEntryPath`, `runIfScript`). `scripts/lint-raw-env-argv.ts` runs in `yarn lint` AND the Test
workflow and fails on any new occurrence, INCLUDING gitignored diagnostics (the recurring audit
blind spot — rg honors .gitignore unless told otherwise). Tests stub env via `vi.stubEnv`; child
processes get environments via `childEnv()`; parseArgs reads argv itself (never pass `args:`).
**Driver:** Operator directive: "the scripts directory keeps turning into a kitchen junk drawer … I don't want the scripts directory to exist anymore eventually."
**Prior art:** `docs/superpowers/specs/2026-07-07-scripts-cleanup-gazetteer-cli-design.md`

---

## Current state (post-migration, commit 46565e4d)

```
scripts/ — 27 top-level files + 2 subdirectories
├── eval/              ~166 tracked files   — eval harness + gates + probes
├── diagnostic/        ~55 files (9 tracked) — one-off investigations
├── *.ts               ~16 files             — release tooling + codegen/lint
├── *.md, *.json       ~5 files              — config, docs, metadata
└── data/              ~1 JSON               — county-population-ranked.json
```

**What's GONE (migrated to packages):**

- `scripts/lib/` → `@mailwoman/core/utils` (cli-args deleted, python-json/random/zip-csv moved)
- `scripts/coarse-placer/` → `@mailwoman/core/coarse-placer/`
- `scripts/record-matcher/` → `registry/tools/`
- `scripts/census/` → `tiger/tools/`
- `scripts/modal/` → `corpus-python/modal/`

**What REMAINS (legitimate residents per the AGENTS.md policy):**

- `eval/` + `diagnostic/` — the eval harness
- Release tooling: `copy-weights`, `publish-workspace`, `publish-release-to-hf`, `bless-package`, `check-release-parity`, `rewrite-workspace-imports`, `release-workspace-repository.test`, `verify-shard-acks`, `verify-export-quant-versions`, `smoke-clean-install`, `smoke-resolve`
- Codegen/lint: `generate-*`, `lint-*`, `jsonl-to-parquet`
- Config: `tsconfig.json`, `AGENTS.md`, `CLAUDE.md`, `v062-model-card-template.json`, `wof-build-manifest.json`, `lint-rules.json`

---

## ▸ Audit: `process.argv` and `process.env` standardization (UNFINISHED)

The file moves are done. The argument-parsing and env-var cleanup is NOT. Below is every concrete reference that needs attention.

### Part A: `scripts/` — `cli-args` imports (44 files, the Phase 1 laggards)

These all import `arg`/`numArg`/`flag` from the now-deleted `scripts/lib/cli-args.ts`. Each needs conversion to `node:util` `parseArgs`.

```
scripts/diagnostic/export-fr-bare-tuples.ts
scripts/diagnostic/normalize-ab.ts
scripts/diagnostic/osm-recovery-ab.ts
scripts/diagnostic/osm-street-recovery-validate.ts
scripts/eval/anchor-ablation-probe.ts
scripts/eval/au-order-probe.ts
scripts/eval/competitive-benchmark.ts
scripts/eval/confidence-discrimination.ts
scripts/eval/coverage-capital-panel.ts
scripts/eval/demo-cascade-smoke.ts
scripts/eval/digit-count-probe.ts
scripts/eval/eu-parse-blocker.ts
scripts/eval/eu-qualified-name-recall.ts
scripts/eval/failure-dump.ts
scripts/eval/fr-admin-split-gate.ts
scripts/eval/fr-admin-split-selfvalidation.ts
scripts/eval/frontier-existence.ts
scripts/eval/frontier-gap.ts
scripts/eval/gauntlet/holdout.ts
scripts/eval/gauntlet/metamorphic.ts
scripts/eval/gauntlet/regression.ts
scripts/eval/gauntlet/run.ts
scripts/eval/gen-capability-manifest.ts
scripts/eval/locality-emit-diff.ts
scripts/eval/mask-regression-gate.ts
scripts/eval/nominatim-dropin-parity.ts
scripts/eval/oracle-locality-injection.ts
scripts/eval/overture-es-postcode-centroids.ts
scripts/eval/per-type-report.ts
scripts/eval/probe-affix-decode.ts
scripts/eval/probe-deterministic-cedex.ts
scripts/eval/probe-deterministic-country.ts
scripts/eval/probe-deterministic-pobox.ts
scripts/eval/promote-canary.ts
scripts/eval/render-de-native-order.ts
scripts/eval/repair-net-coord-probe.ts
scripts/eval/repair-net-probe.ts
scripts/eval/rescore-ceiling-probe.ts
scripts/eval/score-affix.ts
scripts/eval/score-country-homograph.ts
scripts/eval/score-punctuation-stress.ts
scripts/eval/span-rescore-e2e.ts
scripts/eval/span-rescore-validate.ts
scripts/eval/three-gap-matrix.ts
```

**Conversion pattern:**

```typescript
// BEFORE
import { arg, numArg, flag } from "../lib/cli-args.ts"
const model = arg("model", "default.onnx")

// AFTER
import { parseArgs } from "node:util"
const { values } = parseArgs({
	options: { model: { type: "string", default: "default.onnx" } },
})
const model = values.model!
```

### Part B: `scripts/` — raw `process.argv` with no parser at all (63 files)

These access `process.argv` directly — no `parseArgs`, no `cli-args`. Many use positional args (`process.argv[2]`, `process.argv.slice(2)`) or hand-rolled `--flag` scans. Each needs `parseArgs`.

```
scripts/check-release-parity.ts
scripts/diagnostic/d-confound-check.ts
scripts/diagnostic/export-boundary-family-tuples.ts
scripts/diagnostic/export-si-village-tuples.ts
scripts/diagnostic/fill-oa-city-spatial.ts
scripts/diagnostic/offender-taxonomy.ts
scripts/eval/anchor-resolver-delta.ts
scripts/eval/boundary-stress-baseline.ts
scripts/eval/coarse-placer-country-disambig.ts
scripts/eval/coarse-placer-inmap-misroute.ts
scripts/eval/collect-span-confidences.ts
scripts/eval/conformal-calibrate.ts
scripts/eval/de-duplicate-locality-diag.ts
scripts/eval/demo-preset-compare.ts
scripts/eval/de-order-eval.ts
scripts/eval/de-pip-eval.ts
scripts/eval/eval-de-coverage.ts
scripts/eval/eval-matrix.ts
scripts/eval/exonym-coverage-split.ts
scripts/eval/geocode-case-diag.ts
scripts/eval/hn-regression-diff.ts
scripts/eval/honest-eval.ts
scripts/eval/joint-vs-argmax.ts
scripts/eval/leakage-split-f1.ts
scripts/eval/measure-locale-gate.ts
scripts/eval/nonus-coord-panel.ts
scripts/eval/oa-oracle-locality.ts
scripts/eval/oa-resolver-eval.ts
scripts/eval/parse-libpostal-tests.ts
scripts/eval/parser-coverage-audit.ts
scripts/eval/pertag-raw-vs-reconcile.ts
scripts/eval/perturb-golden.ts
scripts/eval/pip-containment.ts
scripts/eval/postal-city-alias-eval.ts
scripts/eval/postcode-conflict-eval.ts
scripts/eval/promotion-gate.ts
scripts/eval/read-relabel-checkpoint.ts
scripts/eval/reconcile-precondition-audit.ts
scripts/eval/reconcile-precondition-regate.ts
scripts/eval/reconcile-regate.ts
scripts/eval/resolver-eval.ts
scripts/eval/run-conformal-multistate.ts
scripts/eval/situs-byterange-probe.ts
scripts/eval/split-golden-dev-test.ts
scripts/eval/summarize-arenas.ts
scripts/eval/unknown-span-report.ts
scripts/eval/v07-calibration-gate.ts
scripts/generate-official-languages.ts
scripts/generate.ts
scripts/lint-mdx-angles.ts
scripts/smoke-resolve.ts
```

**Note:** `promotion-gate.ts` and `smoke-resolve.ts` are particularly important — they're release gates, not one-off probes. They MUST use `parseArgs`.

### Part C: `scripts/` — direct `process.env` without `$public`/`$private` (12 files)

```
scripts/diagnostic/probe-435.ts
scripts/diagnostic/diag-nyc-reconcile.ts
scripts/eval/external-arenas.ts              ← uses process.env["MODEL"], process.env["TOKENIZER"], process.env["OUT_DIR"]
scripts/eval/oracle-locality-injection.ts     ← uses process.env["MAILWOMAN_CANDIDATE_DB"]
scripts/publish-release-to-hf.ts              ← release-critical! needs $public
scripts/publish-demo-assets-to-r2.py          ← Python, but should at minimum use env vars consistently
scripts/copy-weights.ts                       ← release-critical! already well-documented env contract
scripts/verify-export-quant-versions.ts       ← already imports $public but also uses process.env
scripts/check-release-parity.ts
scripts/smoke-resolve.ts
scripts/smoke-clean-install.ts
scripts/rewrite-workspace-imports.ts
```

The release-tooling ones (`publish-release-to-hf`, `copy-weights`, `verify-export-quant-versions`) are the highest priority — they're part of the release pipeline and should use the typed env accessors.

### Part D: Non-scripts — `process.argv` raw access (migrated files that kept old patterns)

These files were moved OUT of scripts/ but weren't cleaned up. They still use `process.argv.indexOf('--name')` (the exact pattern `cli-args.ts` was invented to abstract) or positional args.

```
registry/tools/dedup-ceiling.ts               ← process.argv.indexOf('--name')
registry/tools/gold-set-sample.ts             ← process.argv.indexOf('--name')
registry/tools/matcher-scale.ts               ← process.argv.indexOf('--name')
registry/tools/viz/cross-dataset-map.ts       ← process.argv.indexOf('--name')
registry/tools/viz/geocode-first-surface.ts   ← process.argv.indexOf('--name')
registry/tools/viz/render-map.ts              ← process.argv[2], process.argv[3]
registry/tools/viz/render.ts                  ← process.argv destructuring
registry/tools/viz/source-provenance-map.ts   ← process.argv.indexOf('--name')
registry/tools/viz/yardstick-figure.ts        ← process.argv.indexOf('--name')
tiger/tools/race-dots.ts                      ← process.argv.indexOf('--name')
tiger/tools/race-dots-map.ts                  ← process.argv.indexOf('--name')
tiger/tools/serve-range.ts                    ← process.argv[2], process.argv[3]
```

These should all use `parseArgs` from `node:util`.

### Part E: Non-scripts — `cli.ts` entry points with raw `process.argv[2]`

These are package-level CLIs that already use `parseArgs` for some commands but fall back to raw `process.argv[2]` for subcommand dispatch:

```
photon/cli.ts:175        const command = process.argv[2]
libpostal/cli.ts:70      const command = process.argv[2]
nominatim/cli.ts:311     const command = process.argv[2]
```

These should use `parseArgs` with `allowPositionals: true` and read the subcommand from `positionals[0]`.

### Part F: Non-scripts — `*-lookup` and `resolver-wof-sqlite` CLIs with raw argv

These use raw `process.argv[2]` for build subcommand dispatch and `process.argv.slice(2)` for args:

```
nuts-lookup/cli.ts          ← process.argv[2] === "build", process.argv.slice(3), process.argv.slice(2)
un-locode-lookup/cli.ts     ← same pattern
timezone-lookup/cli.ts      ← same pattern
resolver-wof-sqlite/build-slim-cli.ts          ← process.argv.slice(2)
resolver-wof-sqlite/build-fts-cli.ts           ← process.argv.slice(2)
resolver-wof-sqlite/build-candidate-cli.ts     ← process.argv.slice(2)
resolver-wof-sqlite/build-coincident-roles-cli.ts ← process.argv.slice(2)
```

Same fix: `parseArgs` with `allowPositionals`.

### Part G: Non-scripts — direct `process.env` (non-test, non-spawn)

```
.pi/extensions/mailwoman-tools.ts              ← MAILWOMAN_SKIP_WEIGHTS_COPY, MAILWOMAN_SKIP_WEIGHTS
docs/scripts/build-demo-assets.ts              ← PLAYPEN_WOF_ADMIN_DB
docs/playwright.config.ts                      ← CI, MAILWOMAN_DEMO_URL
corpus/scripts/fetch-nad.ts                    ← dynamic process.env[name]
```

These are lower priority — pi extension, docs build, corpus fetch. But they should use `$public` where the env var is declared in the schema.

---

## Priority order (what to fix first)

| Priority | Scope                                          | Files | Rationale                                                                 |
| -------- | ---------------------------------------------- | ----- | ------------------------------------------------------------------------- |
| **P0**   | `scripts/eval/promotion-gate.ts` raw argv      | 1     | Release gate — must use `parseArgs`                                       |
| **P0**   | `scripts/eval/gauntlet/*` cli-args imports     | 4     | Release gate — the gauntlet                                               |
| **P1**   | `scripts/` release tooling env vars            | ~6    | `publish-*`, `copy-weights`, `verify-*`, `smoke-*`                        |
| **P1**   | `scripts/` top-level raw argv                  | ~7    | `check-release-parity`, `smoke-resolve`, `generate.ts`, `lint-mdx-angles` |
| **P2**   | Non-scripts `cli.ts` entry points              | 3     | `photon`, `libpostal`, `nominatim`                                        |
| **P2**   | Non-scripts `*-lookup` + `resolver-wof-sqlite` | 7     | `nuts-lookup`, `un-locode-lookup`, `timezone-lookup`, 4 build CLI         |
| **P3**   | `registry/tools/` and `tiger/tools/` raw argv  | 12    | Migrated files that kept old patterns                                     |
| **P4**   | `scripts/eval/` cli-args imports (remaining)   | ~40   | Probes — one-offs; lower risk                                             |
| **P4**   | `scripts/eval/` raw argv (remaining)           | ~55   | Probes — one-offs; lower risk                                             |
| **P5**   | Non-scripts env access                         | ~5    | pi extension, docs, corpus — not release-critical                         |

---

## Success metrics (updated)

- [x] `scripts/lib/` empty and deleted
- [x] Zero imports of `scripts/lib/cli-args` anywhere — the "44 remain" count was a false positive (the codemod's banner comment matches the loose pattern); the TRUE remainder was 4 gitignored diagnostic files (`rg` respects .gitignore — the codemod's file list missed them), now converted
- [x] Zero `process.argv.indexOf('--name')`/`includes('--name')` patterns — 57 files converted (codemod v2: local-helper defs removed, call sites → `parseArgs` strict:false + typed view, merged into existing blocks where present)
- [x] `process.argv[2]` subcommand dispatch converted — photon/libpostal/nominatim → `parseArgs` positionals. The nuts/un-locode/timezone CLIs already used `parseArgs` + a DOCUMENTED hand-parse (negative coordinates break `parseArgs` positionals) — correct as-is, not converted. The 4 resolver-wof-sqlite build CLIs keep their structured, tested local parsers (documented `--in ""` semantics; not the scan anti-pattern)
- [x] Zero `.mjs` files — converted in PR #1032
- [x] `scripts/coarse-placer/` → empty
- [x] `scripts/record-matcher/` → empty
- [x] `scripts/census/` → empty
- [x] `scripts/modal/` → empty
- [x] `scripts/eval/` and `scripts/diagnostic/` remain
- [x] Release tooling on `parseArgs` + typed env — promotion-gate converted STRICT (unknown/missing → exit 2 parity smoked); check-release-parity, smoke-resolve (+ its hardcoded playpen path → `dataRootPath`), generate.ts, generate-official-languages, lint-mdx-angles converted; copy-weights/publish-\* were already typed (the one `process.env` is child-process passthrough — correct). Part C's rewrite-workspace-imports/smoke-clean-install claims were stale (no env access); external-arenas' MODEL/TOKENIZER are probe-local vars not in the schema (left); oracle-locality-injection → `$public`
- [x] `yarn typecheck:scripts` passes
- [x] `scripts/` contains ≤ 20 top-level files
