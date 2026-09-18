# Reuse consolidation — design

The operator asked for a 30% reduction in TypeScript line count, achieved by making declarations reusable rather
than by deleting features, comments or whitespace, and revised the target to 15% after the first measurement. This
document records what five instruments measured, why 15% is not reachable through reuse, and the campaign that is.

## Baseline

Measured at `c4237ec06`, so the figures are reproducible rather than merely dated. The tree moves under them: by
`8cbf51d2b` the total was 538,308, a difference of 44 lines that changes no conclusion here.

| Bucket                      |   Lines | Share |
| --------------------------- | ------: | ----- |
| Tracked TS/TSX, 3,041 files | 538,264 | 100%  |
| — code                      | 317,429 | 59.0% |
| — comment                   | 141,066 | 26.2% |
| — blank                     |  79,769 | 14.8% |
| test files, of that total   | 161,304 | 30.0% |

Comments and whitespace are out of scope by the operator's own framing, so **317,429 code lines is the
denominator**. 15% of it is 47,614 lines.

## What five instruments measured

| Instrument                                   | Compares                                                     |                                        Found | Share of code |
| -------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------: | ------------: |
| `knip`                                       | unused files and exports                                     |                                            0 |            0% |
| `jscpd`, `minLines: 12`                      | token clones                                                 |                                        3,438 |         1.08% |
| declaration census, no size floor, all pairs | 48,953 functions and constants, exported and not             |                    2,974 (520 cross-package) |         0.94% |
| home-shadow probe                            | a module-private declaration against a home package's export | 659 raw, ~350 after removing name collisions |         0.11% |
| file 8-gram clustering, Jaccard ≥ 0.45       | whole files                                                  |                           22,829 upper bound |         7.19% |

The scripts are throwaway and live in the session scratchpad; their method is reproduced in the appendix so the
numbers can be re-derived.

### The threshold the file clustering rests on

| Threshold | Clusters | Upper bound | Reading                                                                      |
| --------: | -------: | ----------: | ---------------------------------------------------------------------------- |
|      0.60 |       51 |       9,857 | near-twins only                                                              |
|  **0.45** |   **77** |  **22,829** | largest cluster is 61 files, all one family — no cross-workspace chaining    |
|      0.30 |      129 |      50,129 | artifact: single-linkage chains 94 files across `astrogeology` + `mailwoman` |

The 0.30 row is the only one that reaches 15%, and it reaches it by merging unrelated files. It is not counted.

## The finding

**The repetition in this repository is architectural rather than lexical.**

The four authority-layer packages each write their own `sdk/cells.ts`, `sdk/client.ts`, `sdk/ingest/chunk.ts` —
same responsibilities, same call order, four different types, four different vocabularies, four different table
names. The files are parallel; no two declarations inside them are the same. That is why `jscpd` reports 0.66% on
files that read as twins, and why a declaration-level sweep with no size floor finds 520 cross-package lines in a
538,264-line tree.

The hypothesis that `core`, `codex` and `corpus` are sinks waiting to receive scattered code was tested directly.
The gravity table assigns each cross-package family a proposed owner:

| Proposed sink                | Families | Lines |
| ---------------------------- | -------: | ----: |
| `coastal`                    |       13 |   130 |
| `corpus` _(designated home)_ |        6 |    66 |
| `mailwoman`                  |       10 |    47 |
| `libpostal`                  |        2 |    42 |
| `core` _(designated home)_   |        6 |    22 |
| `codex` _(designated home)_  |        1 |     7 |

The three homes total 95 lines. They are not waiting to receive code — they have already received it. The strongest
package pairs are the layer packages (`coastal ~ zoning` 98L, `coastal ~ flood` 91L, `flood ~ zoning` 75L) and the
drop-in servers (`nominatim ~ photon` 69L).

Consequence for the campaign: consolidation here means writing one generic implementation that several packages
instantiate. It does not mean moving constants into `core`, because there are almost no shared constants to move.

## Scope

**In scope.** Reuse: a generic implementation replacing several parallel ones, a derived type replacing a
hand-written one, a helper moved to the package that already owns the concept.

**Out of scope.** Relocating the 36,088 lines of declared table literals or the 44,723 lines of type declarations
out of TypeScript. That reaches the 15% and is a different project; the operator chose reuse at its real size.

**Non-goals.** Deleting features. Removing docstrings. Splitting files because they are long — the mechanical
cleanup lane stays closed except where this campaign's own work touches a file.

## Lanes

Each lane carries a measured upper bound from the census and a realistic estimate. The realistic figure assumes a
generic implementation keeps each instance's irreducible vocabulary.

| Lane                               |    Upper bound | Realistic         | Confidence |
| ---------------------------------- | -------------: | ----------------- | ---------- |
| A. CLI command tree                |          5,725 | 2,000–2,500       | high       |
| B. Authority-layer kit             | 3,378 / 12,225 | 4,000–6,000       | high       |
| C. Corpus adapters and recipes     |          2,064 | 1,200–1,600       | medium     |
| E. Table schemas                   |            860 | 600–900           | medium     |
| G. Drop-in servers, env, MCP tools |            673 | 400–600           | medium     |
| H. Remainder                       |          2,791 | 800–1,200         | low        |
| Home shadows                       |            659 | ~350              | high       |
| Test families collapsing with A–C  |          6,733 | 2,500–4,000       | medium     |
| **Total**                          |                | **11,850–17,150** |            |

Lane B carries two bounds because two methods measured it. Clustering at 0.45 counts only the files that still
look alike (3,378). Pairing the four packages by matching file name instead counts all 23 families (12,225), and
the 8,847-line difference sits in same-named files that have drifted — `sdk/client.ts` measures 0.23 best-pair
similarity, `sdk/download.ts` has one identical pair and one at 0.09. The truth is between them.

### Lane A — the CLI command tree

**A1. Derive `Options` from `typeof spec`.** 143 command files hand-write an `interface Options` restating their
own `spec.options` block: **1,116 lines**, against 1,693 lines of `options` blocks across 161 specs.

The kebab-to-property derivation already exists as `optionPropertyName` in `@mailwoman/core/scripting/arguments`,
with an `OPTION_INITIALISMS` table naming the segments that capitalize a whole acronym. A mapped type mirroring
that derivation makes `Options` derived.

The runtime table and the type-level table must not drift, and matched constants would not prevent it — this
repository's own rule is to share the function rather than the constants. The action is one declaration: keep
`OPTION_INITIALISMS` as a single `as const` object, take the type side from `typeof` it and the runtime side from
`Object.entries` of it.

`packages/repo-health/lib/checks/cli-flag-properties.ts` exists because these two can drift; its docstring records
the cost, ten flags across seven commands reaching the component under a name nothing read, `eval oa-resolver
--out-json` among them. Derivation turns that class into a compile error. Whether the check retires entirely is
decided after A1 lands, by reading what it still catches — a flag whose property is declared but unread is a
different finding and may survive.

**A2. Shared option groups.** 450 of 881 option declarations restate a key another command already declares, at
~707 lines. The repetition is broad rather than deep: `out` appears 56 times in 77 lines. Consolidating trades
per-command legibility for lines, so this lane is taken only where a group is coherent (the engine options
`locale` / `weights-cache` / `db` / `resolve-db` / `candidate-db`) rather than key by key.

A2 also surfaces a naming split worth fixing while the files are open: `out` (56) beside `output` (23), and
`country` (14) beside `countries` (14). Read afterwards under #2280, only the first was a drift — see the outcome
section.

**A3. The repeated command shape.** Every harness command runs `useCommandTask`, returns `<CommandTaskResult>`
while pending, prints `prettyJSON` under `--json`, and otherwise returns `null`. A factory or a wrapper component
collapses it. Estimated 61 files × ~12 lines. TAKEN under #2280 — see the outcome section for what it cost and
which files kept the hook.

### Lane B — the authority-layer kit

`flood`, `soil`, `coastal` and `zoning` are 17,418 non-test lines across 23 file families with matching names, and
all four publish to npm. A fifth layer is already foreseeable, and the cost of adding one is the reason this lane
ranks above its line count.

What generalizes: `sdk/cells.ts`, `sdk/download.ts`, `sdk/measure-resolutions.ts`, `sdk/ingest/chunk.ts`,
`scripts/ingest-chunk.ts`, `sdk/verify/*`, the `layer_manifest` and `layer_coverage` half of each `schema.ts`,
`test-kit.ts`, plus the four `packages/mailwoman/lib/observations/*-route.ts` and the three
`packages/mailwoman/lib/commands/gazetteer/build/*.tsx`.

What must not: each layer's vocabulary, its reading kinds, its scenario scoping, and its coverage semantics. These
differ by design and the differences are required — `flood` represents Zone 1 by absence, `coastal` and
`zoning` license no negative claim at all, and `soil` answers a distribution rather than a winner class. A generic
implementation parameterizes over them; it never averages them.

**Where the kit lives** is the one open question. `@mailwoman/core/layers` already holds the manifest and schema
contract at 895 lines and every layer depends on `core` already, but an ingest pipeline in `core` adds weight to
the package everything depends on. A new `@mailwoman/layer-kit` workspace is cleaner and costs the seven-register
registration that `AGENTS.md` documents. Decide before writing code.

**Acceptance is already written.** Each layer carries a `test/unit/build.test.ts` driving the full build to a
sealed database from hand-built fixture geometry, with no network and no GDAL. Those four suites plus the four
`packages/mailwoman/test/unit/observations/*-route.test.ts` must pass unchanged. A test that needs editing to
accommodate the kit is a behavior change, and it stops the lane until explained.

### Lanes C, E, G, H

- **C.** Nine `packages/corpus/lib/us/adapters/**` cluster at 1,140 lines upper bound, the two
  `adapters/wof/**` at 194, and four national recipes (`no`, `nl`, `cz`, `si`) at 322. A CSV-adapter factory.
- **E.** Six `resolver-wof-sqlite` schema modules plus `nominatim`/`photon` schemas share a shape; the Kysely
  schema-builder idiom is already the house pattern, so this is a factory over it.
- **G.** `libpostal` / `nominatim` / `photon` app and schema modules, the five `lib/env.ts` files, the five
  `dev-mcp` tool definitions.
- **H.** The remaining 21 clusters, taken opportunistically and not planned.

### Home shadows

Real, small, and a correctness improvement rather than a trade:

| Declaration               | Lines | Where                                                            | Home               |
| ------------------------- | ----: | ---------------------------------------------------------------- | ------------------ |
| `runPipeline`             |   116 | `mailwoman/lib/commands/parse.tsx:441`                           | `core` exports it  |
| `resolveCells`            |    80 | `flood/lib/sdk/build-flood.ts:429` against `soil`                | neither            |
| `gradeRow` ×4             |   108 | three `eval-harness` runners and `dev-mcp`                       | neither            |
| `assertAreaAgreement` ×2  |    51 | `soil/lib/sdk/build-soil.ts:421`, `zoning/…/build-zoning.ts:589` | `core` exports it  |
| `FR_VOIE_TYPES`           |    50 | `resolver/lib/street/tier.ts:275`                                | `codex` exports it |
| `resolvePackagedDataPath` |    16 | `poi-taxonomy/lib/packaged-data.ts:28`                           | `core` exports it  |

`pointInRing` in `nuts-lookup` and `timezone-lookup` (32 lines) appears on the probe's list and **stays**. Both
packages document the copy in place: reaching `@mailwoman/spatial` would pull `@mailwoman/core`'s ~11 MB of
shipped data behind a ray cast. Price the dependency before moving a helper.

## Outcome: the file-clustering number measures parallelism rather than duplication

Lane A1 landed and lane B was opened against the four authority-layer packages. Reading them revealed a systematic
bias in the 22,829 figure, and it changes the campaign's answer.

**Every high-similarity family in lane B is already consolidated.** The shared implementation exists and each
layer's file is a manifest plus a call:

| Family                        | Similarity | Where the shared implementation already lives                                                                                                                     |
| ----------------------------- | ---------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/scripts/ingest-chunk.ts` |       0.72 | `runIngestChunkScript` + `INGEST_CHUNK_FLAGS`, `@mailwoman/core/scripting/ingest-chunk-script`                                                                    |
| `lib/sdk/download.ts`         |       1.00 | `downloadZippedGeodatabase`, `@mailwoman/core/utils`                                                                                                              |
| `lib/schema.ts`               |       0.78 | `addBoundingBoxColumns` / `addCellIndexColumns` / `addRingGeometryColumns`, `@mailwoman/sqlite/schema-columns`; `LayerContractDatabase`, `@mailwoman/core/layers` |
| `observations/*-route.ts`     |          — | `#observations/layer-record`                                                                                                                                      |
| `corpus/lib/us/adapters/**`   |          — | `#adapters/utils`, `@mailwoman/codex/address-format`, `#us/fips-state`, `CSVSpliterator`                                                                          |

**Two files that correctly call the same shared helper with different arguments are structurally similar.** An
8-gram node-kind hash cannot tell them from two files that duplicate the logic, so the clustering instrument counts
the residue of a finished consolidation as if it were available work. What remains in each member is the product's
own vocabulary — flood's flags and feature source, soil's, coastal's, zoning's — and that is irreducible.

The declaration census does not carry the bias, because a call is not a declaration. Its 2,974 lines is the
figure to trust, and the two instruments disagree for a reason rather than by error: one measures duplication, the
other measures parallelism, and parallelism is the correct state for four products built on one kit.

### A category no instrument measured

Lane A1 was not in any of the five censuses. 143 `interface Options` blocks restated their own `spec.options`:
invisible to `jscpd` (different tokens), to `knip` (all used), to the declaration census (it compares functions
and constants rather than a type against a constant) and to file clustering (the pair sits inside one file). It delivered
1,182 net lines, more than every cross-package family in the tree combined.

A sixth probe went looking for the rest of that category — a string-literal union restating an `as const` object's
values, an interface restating its keys, a zod schema restating an interface — and found **223 lines**, of which
most are not duplicates on inspection. `NominatimResult` and `NominatimResultSchema` share every field name and
are deliberately different: the interface types `annotations` as `OpenCageAnnotations` where the wire schema has
`z.looseObject({})`, so `z.infer` would widen it. The wire contract and the engine contract are two things.

### What the tree holds

| Source                                  |      Lines | State                                        |
| --------------------------------------- | ---------: | -------------------------------------------- |
| Derived command options (lane A1)       |      1,182 | delivered                                    |
| French voie types taken from the codex  |         26 | delivered, and closed a 16-token recall gap  |
| Types restating values                  |        223 | mostly deliberate on inspection              |
| Duplicated declarations, cross-package  |        520 | small families, no single one above 27 lines |
| Duplicated declarations, within-package |      2,454 | almost entirely test fixtures                |
| **Realistic ceiling for reuse**         | **~4,400** | **1.4% of 317,429 code lines**               |

The reason is not that the tree was never tidied. It is that the tidying already happened and the enforcement to
keep it done is in place: `HELPER_HOMES` and `mailwoman/prefer-home`, `private-name-shadows-export`,
`no-cross-package-reexport`, the `jscpd` threshold, `knip`, and the monotonic debt counters. Five instruments
agreeing near zero is that enforcement reporting success.

## Order

1. **A1** — done. 143 files, −1,182 net lines, two inert flags fixed.

   Per commit, so the branch's own arithmetic is auditable: A1 −1,182, the voie consolidation −26, and the
   `locale-tables` check +400 — which is new capability rather than consolidation. The branch nets −808.

2. **Home shadows** — the French voie set is done. The rest are layer-package shadows
   (`assertAreaAgreement`, `resolveCells`, `readIdentity`, `aggregateChunks`, `runBatchedIngest`,
   `sampleAgreementPoints`) and belong to lane B.
3. **B** — **closed as already done.** See the outcome section above.
4. **C**, **E**, **G** — closed for the same reason, verified by sampling.
5. **A2**, **H** — not taken. A2 is 450 option declarations restating a key another command declares, at ~707
   lines, but the repetition is broad rather than deep (`out` appears 56 times in 77 lines) and consolidating
   trades per-command legibility for lines.
6. **A3** — **taken** under #2280 (`f2ebed800`). `harnessCommand` in `packages/mailwoman/lib/cli/kit/`; twenty-two
   of the twenty-six `commands/eval/` files use it, at 404 insertions against 480 deletions across 24 files. Four
   keep the hook for a reason the factory does not cover: `pins` and `premise-linkage` pass extra props to
   `CommandTaskResult`, `score-trends` renders its own done frame, `gauntlet/build` has a custom shape.

A2 is the only reuse work left with more than a few hundred lines in it, and it trades legibility for count. It is
a decision rather than a backlog item.

**The 15% target is dropped**, and the arithmetic above is the reason rather than a judgment: the reuse ceiling
across the tree is ~4,400 lines, 1.4% of the 317,429-line denominator, of which #2270 delivered 1,208. Reaching
47,614 lines means relocating the 36,088 lines of declared table literals out of TypeScript — a real project, and
one chosen for conformance with the rule that reference data is provenance-tracked immutable SQLite, never for a
line count.

Of A2's two naming findings, one was a drift and one was not. `out` (56 commands) beside `output` (22) was the same
option spelled two ways, and is now `out` everywhere, with `deprecatedName` on the option spec keeping the retired
flag working behind a notice (#2280, `ebd389ba7`). `country` (13) beside `countries` (14) is not a drift: all 27
sites were read, every `country` carries one ISO code and every `countries` a comma-separated list, and two files
declare both because they name different sources at different arities (`corpus/fetch.tsx`: the OpenAddresses
country against the GeoNames postal countries; `gazetteer/build/poi/index.tsx`: the OSM country against the
Overture countries). Renaming either would merge two sources into one flag.

## Verification

Every lane, in order, and a lane is not finished until all of these pass:

1. `yarn compile`, then `tsc -b`.
2. `yarn test` for every workspace the lane touched.
3. Root `yarn lint`, which chains the health checks — `oxlint`, `oxfmt`, the prose rules, `knip`, `jscpd`,
   `depcruise`, and the debt counters.
4. For lane B only: the four layer `build.test.ts` suites and the four observation-route suites, unedited.
5. `gh run list` after any push.

The debt counters move as a side effect of this work. Ratchet them silently in the same commit, per the standing
rule; do not open a separate pull request for a baseline.

## Risks

- **A generic implementation can average away a deliberate difference.** The four layers disagree about what
  absence means, and that disagreement is the product. The parameterization must make each layer state its own
  answer; a default that silently applies one layer's semantics to another is the failure mode to watch.
- **`yarn pack` freezes `workspace:*` at pack time.** A new `@mailwoman/layer-kit` joins seven registers, and a
  workspace missing from the release list freezes silently at consumer expense. Run the release-list arithmetic
  from `AGENTS.md` if lane B adds a workspace.
- **A move leaves quoted path literals stale that the compiler never reads.** Sweep for quoted literals whose
  first segment is a workspace name after any file moves rather than only for imports.

## Appendix: how the numbers were derived

- **Declaration census.** Parse every tracked `.ts`/`.tsx` with the TypeScript compiler API. Record every
  `FunctionDeclaration`, `MethodDeclaration`, and `VariableDeclaration` with an initializer, exported or not, with
  no size floor. Group by four keys, strongest claim first so nothing counts twice: identical normalized
  declaration text (≥40 chars); identical normalized body (≥60 chars); identical constant initializer (≥20 chars,
  excluding `[]`, `{}`, `new Map()` and other empty values); identical AST-kind sequence (≥60 nodes). Same-name
  matches are reported as leads and never counted — 184 declarations are named `state` and 425 are named `rows`.
- **File clustering.** Pre-order AST node-kind sequence per file, 8-grams, Jaccard similarity, single-linkage
  union-find at 0.45. Files under 40 lines excluded. Size banding skips pairs whose shingle counts differ by more
  than 2.5×, which cannot reach the threshold.
- **Reduction formula.** Keep the largest member whole, charge one line per remaining member for the import (three
  for a file-level family), return the rest. It is an upper bound rather than a promise.
