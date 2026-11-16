# recognize: the swap from query-shape

This record is step 3 of the order in the 2026-11-16 "Direction change" comment on issue 3064: every consumer of `@mailwoman/query-shape` moves to `@mailwoman/recognize`, and `packages/query-shape` is deleted. Parses stay identical.
The base is `origin/main` at `07a84aed1c`.
Each claim is marked **observed** (a command printed it), **inferred** or **decided**.

## Consumers (observed)

A script walked every tracked `.ts` and `.tsx` file at `07a84aed1c` with the TypeScript compiler API and listed each static import, export-from, dynamic `import()` and import type whose specifier starts with `@mailwoman/query-shape`.
It found **83 files**, 59 outside tests and 24 tests, in 13 workspaces: `mailwoman` 33, `kind-classifier` 11, `neural` 7, `core` 6, `phrase-grouper` 6, `corpus` 4, `locale-hint` 4, `postcode` 3, `recognize` 3, `normalize` 2, `react` 2, `mtf` 1 and `resolver` 1.
The `postcode` and `recognize` files are the comparison tools.
`packages/earth` and the `docs` plugins import nothing from the package. The docs alias list named it.

## Owners (decided)

| Former export                                                                                                                                | New owner                                                             | New name                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `computeQueryShape`, `QueryShape`                                                                                                            | `@mailwoman/postcode/recognize/query-shape`                           | same names, and the locale option is gone                                         |
| `NormalizedInputLite`                                                                                                                        | `@mailwoman/core/pipeline/types`                                      | same                                                                              |
| `QueryShapeFormatsView`, `QueryShapeSegmentsView`, `QueryShapeTokensView`, `KnownFormatHitView`                                              | `@mailwoman/core/pipeline/types`                                      | same; `string` replaces `ScriptCode`, `KnownFormat`                               |
| `SegmentView`, `TokenClassView`, `EMPTY_QUERY_SHAPE_VIEW`                                                                                    | `@mailwoman/core/pipeline/types`                                      | same; `TokenClassView.length` is gone                                             |
| `isPostcodeFormat`                                                                                                                           | `@mailwoman/core/pipeline/types`                                      | same name. It replaces core's private copy and postcode's `isKnownPostcodeFormat` |
| `SpanRange`                                                                                                                                  | `@mailwoman/recognize/types`                                          | `TextSpan`                                                                        |
| `CharRange`                                                                                                                                  | `@mailwoman/recognize/types`                                          | same                                                                              |
| `TextSpan` (`{ text, start, end }`)                                                                                                          | `@mailwoman/core/tokenization/Span`                                   | `TextFragment`                                                                    |
| `classifyCodepoint`, `classifyToken`, `classifyTokenScript`, `scriptForRange`                                                                | `@mailwoman/recognize/charset`                                        | same                                                                              |
| `isRegionAbbreviationToken`, `RegionAbbreviationTokenOpts`                                                                                   | `@mailwoman/recognize/region-abbreviation`                            | `RegionAbbreviationTokenOptions`                                                  |
| `classifyTokens`, `foldInputClass`                                                                                                           | the `tokenClasses` and `characterClass` fields of `computeQueryShape` | removed                                                                           |
| `segment`                                                                                                                                    | the `segments` field of `computeQueryShape`                           | removed                                                                           |
| `foldInputScripts`, `scriptForCodepoint`, `detectKnownFormats`, `detectRegionAbbreviations`, `ScriptCode`, `KnownFormat` and the other types | none. No file outside the package read them                           | removed                                                                           |
| `WhitespacePattern` and the `whitespacePattern` field, `TokenClass.length`                                                                   | none                                                                  | removed (decision 2 of issue 3064)                                                |

Why the composition lives in `@mailwoman/postcode`: `@mailwoman/postcode` depends on `@mailwoman/recognize`, so `recognize` cannot depend back on it without a cycle, and the legacy-formats family is in `postcode`. `dependency-cruiser.config.mjs` holds no rule about either package, so the manifest cycle walk and the TypeScript project references are the checks. `@mailwoman/postcode` already depends on `recognize` and `core`, so it is the one place that holds both families.

The pipeline stage keeps its name, `computeQueryShape`, and so do `QueryShapeLite`, the `query-shape` timing key and the `source: "query-shape"` of the fast-path evidence. The concept is the pipeline's structural summary, and the names keep every trace key stable.

## Dependency edges (observed from the manifests)

```text
core        -> codex
registry    -> core
recognize   -> core, registry
postcode    -> codex, core, recognize
normalize   -> codex, recognize             (type TextSpan only)
kind-classifier -> codex, core, postcode
locale-hint -> core
phrase-grouper  -> codex, core, recognize; postcode (dev, one test)
mtf         -> core
neural      -> codex, core, normalize, postcode, recognize
corpus      -> codex, core, normalize, postcode, recognize
react       -> core, postcode, recognize
resolver    -> codex, core, postcode, recognize, registry
```

`core` imports no code from `recognize`, `postcode` or `normalize`, so a type that `core` needs is core's own.
A walk over the `dependencies` and `devDependencies` of every manifest found 11 cycles at `07a84aed1c` and the same 11 after the swap. None of them passes through `core`, `registry`, `recognize`, `postcode`, `normalize`, `kind-classifier`, `locale-hint`, `phrase-grouper` or `mtf`, except the existing `core` and `sqlite` pair.
`yarn compile` passes, and TypeScript project references are acyclic.

## The helpers (observed)

The callers decide each helper.

- `classifyCodepoint` (the held-out reachability tool, once per codepoint at each edge), `classifyToken` (the grammar-conflict census, once per token over parquet rows) and `classifyTokenScript` (the corpus WOF adapter, once per name part) run in loops of thousands of calls. They stay plain TypeScript in `@mailwoman/recognize/charset`.
  The functions are the legacy functions, moved. Their ties go to the script seen first. The `scripts` field doesn't reproduce that, because it ranks ties by script code.
- `scriptForRange` is plain TypeScript in the same module. It reads the `tokenClasses` field.
- `isRegionAbbreviationToken` is a regular-expression test with a letter limit, so it stays plain TypeScript in `@mailwoman/recognize/region-abbreviation`.
- `classifyTokens` plus `foldInputClass` (one call per query, in `kind-classifier`), `classifyTokens` (one call per parse, in `span-script.ts`) and `segment` (one call per geocode result) become one `computeQueryShape` call. The fields equal the legacy functions' by the frozen comparison below.

Before `packages/query-shape` was deleted, a scratch script compared the moved functions with the legacy ones: `classifyCodepoint`, `classifyToken` and `classifyTokenScript` on all 1,114,112 codepoints, then `classifyToken`, `classifyTokenScript`, `isRegionAbbreviationToken` (at the default limit and at `maxLetters: 3`) and `scriptForRange` on 200,000 random strings. That's 4,342,336 comparisons and **0 differences**.
`packages/recognize/lib/charset.test.ts` keeps the Unicode-property checks of the moved ranges and compares class and script of each codepoint with the frozen fixture.

## The frozen comparison (observed)

`packages/recognize/data/fixtures/query-shape-frozen.fixture.json` holds the output of the legacy `computeQueryShape`, taken before the package was deleted. It is 1,727,781 bytes with 1,777 cases and 168 runs of codepoints. A case records the six structural fields and `knownFormats`.

| Part                     | Cases    | How it was drawn                                                                                                        |
| ------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| golden inputs            | 78       | the Phase 0 golden fixture, whole                                                                                       |
| legacy behaviors         | 29       | the quirk lists of the two comparison tests, plus runs of 300 digits, 300 Han characters and 300 `a-` pairs             |
| generated, structure     | 500      | `generatedInputs(500, 20261116)` over the alphabet in `tools/differential.ts`                                           |
| generated, known formats | 500      | `generatedKnownFormatInputs(500, 20261116)` in `@mailwoman/postcode`                                                    |
| gauntlet                 | 670      | every second input, in sorted order, of the 1,339 distinct inputs under the two-letter country directories              |
| codepoints               | 168 runs | the class, token class, scripts, segment count and known-format count of the one-codepoint text, for U+0000 to U+10FFFF |

No row comes from the data root: the gauntlet inputs are committed, and the other parts are generated.
`tools/differential.test.ts` in `recognize` and `tools/differential.test.ts` in `postcode` compare against it, and both integration tests run all 1,114,112 codepoints.
The two real-row tools, `differential.run.ts` in each package, are deleted with the package they compared against. The reports of their last runs against `query-shape` stay: `packages/recognize/data/reports/structure-differential.json` (121,878 rows, 0 differing, committed at `ca38a89e93`) and `packages/postcode/data/reports/known-formats-differential.json` (committed at `9036fcb3e2`).
The Phase 0 tools `golden.run.ts` and `bench.run.ts` under `packages/mailwoman/tools/dev-tools/query-shape/` are deleted, because the frozen fixture replaces the first and the two benchmarks below replace the second.

## The benchmark (observed)

The last same-process run against the legacy package, on `07a84aed1c` with Node v26.2.0 on an AMD Ryzen 9 8945HS, 20,000 warm-up and 200,000 timed calls per input.
No CI run was in progress (`gh run list` showed the last five runs completed). The load average read `0.75, 1.94, 4.24` before the first run and `1.09, 1.62, 3.76` before the second.

`packages/postcode/tools/bench.run.ts`, the composition that replaces `computeQueryShape` (`structure`, `postcode_legacy`, `primitives`, `coordinates`):

| Input                                                   | UTF-16 units | Known formats | `computeQueryShape` (µs/call) | recognize without postal (µs/call) |
| ------------------------------------------------------- | ------------ | ------------- | ----------------------------- | ---------------------------------- |
| `68161`                                                 | 5            | 3             | 1.98                          | 1.76                               |
| `SW1A 1AA`                                              | 8            | 1             | 5.52                          | 2.48                               |
| `350 5th Ave, New York, NY 10118`                       | 31           | 3             | 15.66                         | 6.19                               |
| `〒100-0001 東京都千代田区千代田1-1`                    | 23           | 1             | 10.68                         | 3.13                               |
| `金龍酒家, 12 Gerrard Street, London WC2H 7JS`          | 40           | 1             | 14.90                         | 7.98                               |
| `1600 Pennsylvania Avenue NW, Washington,…` (300 units) | 300          | 12            | 115.42                        | 25.04                              |
| `1111…` (300 units)                                     | 300          | 0             | 86.06                         | 20.54                              |
| `漢漢漢…` (300 units)                                   | 300          | 0             | 70.02                         | 17.93                              |

`packages/recognize/tools/bench.run.ts`, the `structure` family on its own against `computeQueryShape`:

| Input                                                   | `computeQueryShape` (µs/call) | recognize (µs/call) |
| ------------------------------------------------------- | ----------------------------- | ------------------- |
| `68161`                                                 | 1.89                          | 1.02                |
| `SW1A 1AA`                                              | 5.25                          | 1.31                |
| `350 5th Ave, New York, NY 10118`                       | 15.88                         | 5.65                |
| `〒100-0001 東京都千代田区千代田1-1`                    | 11.12                         | 4.05                |
| `金龍酒家, 12 Gerrard Street, London WC2H 7JS`          | 18.18                         | 6.03                |
| `1600 Pennsylvania Avenue NW, Washington,…` (300 units) | 113.76                        | 25.02               |
| `1111…` (300 units)                                     | 86.16                         | 20.43               |
| `漢漢漢…` (300 units)                                   | 70.15                         | 17.45               |

The pipeline composes `structure` and `postcode_legacy` only. The composition measured above also holds `primitives` and `coordinates`, which the pipeline doesn't compose, so the pipeline's call does less work than the measured one and is inferred to be faster than the legacy call on all eight inputs. The benchmark tools drop the legacy column.

## Parses are identical (observed)

Two worktrees ran the same scratch script. It builds the pipeline the CLI's default `parse` path builds (`NeuralAddressClassifier.loadRoutedFromWeights({ locale: "en-US" })`, `createRuntimePipeline` with `fst: "auto"`, `streetEvidence: "auto"` and `poiQueryKind: "extract"`) and parses each input with locale `en-US`.
One worktree is `origin/main` at `07a84aed1c`, and the other is this branch. Both load the same weights from the same checkout layout and the data root `/mnt/mw`.
Per input the script writes the normalized input, the query shape, the locale hint, the kind, the POI intent, the path, the faults and the whole tree with its tags, spans, values, confidences and scripts. It leaves out the timing.
From the query shape it drops the two fields the swap removes, `whitespacePattern` and `TokenClass.length`, and the comparison sorts the shape's keys, because `knownFormats` now comes last.

| Input set                                                                             | Inputs compared | Identical | Inputs that differ |
| ------------------------------------------------------------------------------------- | --------------- | --------- | ------------------ |
| every distinct `input` under `gauntlet/cases/<cc>/` (1,352 case rows, 1,339 distinct) | 1,339           | 1,339     | 0                  |
| every row of `heldout-dev-v0.8.18.v2.rows.jsonl`, field `raw` (86,221 distinct)       | 86,845          | 86,845    | 0                  |
| total                                                                                 | 88,184          | 88,184    | 0                  |

No input differs. The comparison reads the pipeline's result and not the CLI's text output, so the CLI's JSON projection is covered only through the result it prints.

## Runtimes (observed)

`@mailwoman/recognize` instantiates its WebAssembly engine on the first call. Each place the pipeline runs resolves the engine as follows.

| Runtime                                                                                                | How the engine loads                                                                                    | Held by                                                                                                        |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Node: the CLI, the corpus recipes, the evaluation harness                                              | the default entry compiles its embedded bytes synchronously                                             | the fast suite (`differential.test.ts`, `query-shape.test.ts`) and both parse comparisons                      |
| Chromium page, main thread (`mailwoman/browser-runtime/classify.ts`, `usePOISearch.ts`, the earth app) | the default entry, as in Node                                                                           | `packages/postcode/lib/recognize/query-shape.browser.test.ts` (new) and the existing recognize first-call test |
| Workers (`@mailwoman/engine-worker`)                                                                   | the `workerd` export condition resolves to `out/workerd.js`, which imports `recognize.wasm` as a module | `packages/postcode/lib/recognize/query-shape.workers.test.ts` (new) and the existing recognize first-call test |

`yarn workspace @mailwoman/postcode test:workers` and `test:browser` pass, and so do the two recognize configurations. The new steps are in `.github/workflows/test.yml`, and `vitest.config.ts` excludes the two new file kinds from the root sweep.

`wrangler deploy --dry-run` bundles the engine Worker with the new graph. Its upload is 16,786.36 KiB (gzip 4,231.46 KiB) at `07a84aed1c` and 17,515.51 KiB (gzip 4,418.42 KiB) on this branch, and `--outdir` lists `recognize.wasm` (479,693 bytes) as its own module.
The gazetteer Worker (981.80 KiB) and the API Worker (71.56 KiB) are the same size before and after, because neither reaches the pipeline.

## Bundle sizes (observed)

The earth app, `vite build`, summed over `dist`:

| Part                        | `07a84aed1c`                 | This branch                  | Change                       |
| --------------------------- | ---------------------------- | ---------------------------- | ---------------------------- |
| JavaScript, 46 and 47 files | 6,232,224 B (gzip 1,715,790) | 7,456,185 B (gzip 1,926,020) | +1,223,961 B (gzip +210,230) |
| `.wasm`, 5 files            | 16,285,977 B                 | 16,285,977 B                 | 0                            |

The docs site, `yarn workspace @mailwoman/docs build`, summed over `docs/build`: JavaScript 8,173,562 bytes (gzip 2,369,604) at `07a84aed1c` and 8,173,559 bytes (gzip 2,369,601) on this branch, a change of 3 bytes. The `.wasm`, `.css`, `.mjs` and `.html` totals are equal or within 150 bytes of gzip.
No JavaScript file under `docs/build/assets` holds the engine's `rcg_structure` export, so the site's build doesn't bundle the recognizer.
That's inferred to mean the live demo loads the pipeline at run time from the runtime assets and not from this build. The alias list in `docs/plugins/runtime-assets/workspace/aliases.ts` lost its `query-shape` entry, and `recognize` needs none, because it resolves through its own `exports` map.

The default entry of `recognize` embeds the engine binary and the artifacts as hexadecimal text, so the added JavaScript is the engine (479,693 bytes) and the `structure` and `postcode_legacy` artifacts at twice their size. The `.wasm` assets don't change. That's inferred from the sizes. A later change can serve the binary as an asset in a browser.
