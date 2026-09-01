# Should `sdk/` be renamed — and should the four layer packages become one?

**Date:** 2026-09-01 · **Status:** proposal, decides nothing · **Refs:** #2050 · **Implements:** nothing.

This record answers two questions that were deliberately left out of the `sdk/` cleanup so they could be
decided on measurements rather than inside a file move: whether the remaining ten `lib/sdk/` directories
should be renamed, and whether `coastal`, `flood`, `soil` and `zoning` want to be one package instead of
four. Both measurements are in §1 and §4 with the commands that produced them. **Both came out against the
intuitive answer**, which is why they are written down rather than acted on.

---

## 0. The recommendation

1. **Do not rename `sdk/` on its own account.** The cost is 87 source files and **83 published subpaths**
   (88 before this arc removed five), and the benefit is that a directory name would agree with a sentence in
   `AGENTS.md`. The two real defects the audit found — a fossil in `spatial` and a request path reaching
   through an acquisition barrel — are already fixed, and neither was fixed by a rename (§2).
   1b. **Do it when the next breaking release happens anyway, and take every rename in that one release.**
   Operator direction, 2026-09-01. A consumer should pay for renames once. The planned removal of the word
   `shard` is the other rename in flight, and §6 sizes both so the bundle is planned on numbers — with one
   correction: on PUBLISHED SUBPATHS `shard` is **4**, not more than `sdk/`'s 83. The two breaks are large in
   different currencies, and that changes what the bundle is for.
2. **If it is renamed anyway, the word is `acquire/`**, because `soil/lib/sdk/acquire.ts` already chose it,
   and the migration must ship with the enforcement rule in the same PR (§3).
3. **Do not build `layer-kit` for de-duplication.** The four layer packages share eight filenames and
   **0.18% of their lines**. There is almost nothing to de-duplicate; a shared package would be imposing one
   abstraction over four genuinely different implementations (§4).
4. **A shared package may still be worth building for a different reason** — a single tested contract for the
   ingest stages — but that is a design argument that must be made on its own evidence, and this record does
   not make it (§4.3).

---

## 1. What is actually there

Eleven packages had `lib/sdk/`; `spatial` no longer does. The ten that remain are all dataset packages, and
no runtime package has one — so the concept is real, and the audit's premise held.

```bash
for d in packages/*/lib/sdk; do [ -d "$d" ] && echo "$d: $(ls "$d" | tr '\n' ' ')"; done
grep -rl '"#sdk/' packages --include='*.ts' | grep -v /out/ | wc -l
```

| package        | files using `#sdk/` | published `./sdk*` subpaths |
| -------------- | ------------------: | --------------------------: |
| filer          |                  20 |                          14 |
| soil           |                  11 |                          14 |
| bdc            |                  11 |                          12 |
| flood          |                   8 |                          10 |
| zoning         |                   7 |                           9 |
| osm            |                   7 |                           7 |
| coastal        |                   7 |                           9 |
| geocode-oracle |                   6 |                           8 |
| tiger          |                   5 |                           2 |
| ban            |                   5 |                           3 |
| **total**      |              **87** |                      **88** |

Every package is published at 9.2.0, so all 88 subpaths are public. A rename is 87 internal specifier edits
plus 88 breaking subpath changes.

## 2. Why the rename is not the fix

The audit that prompted this work proposed the rename as the remedy for drift. Two things argue against it.

**The remedy has already been tried, and it decayed.** The 2026-07-09 regroup moved `mailwoman/sdk/{cli,test}`
to `cli-kit/` and `test-kit/`, added the one-line `AGENTS.md` rule, and stated that "`sdk` submodule meaning
is restored: data acquisition only." By 2026-09-01 `filer/lib/sdk/` and `bdc/lib/sdk/` held domain analysis
again. A directory name cannot enforce itself, and a second rename would be the same treatment applied to the
same patient.

**Neither real defect was a naming defect.** The audit found three violations. Measured:

- `spatial/lib/sdk/` held a WKT/WKB codec and an `ogrinfo` shell-out. Real, and fixed — but it was a
  LOCATION defect. Nothing imported it wrongly; it simply sat in the wrong folder. No dependency rule could
  have caught it, and none did.
- `filer`/`bdc` "drift" was largely a mis-measurement. The audit's table of external importers
  (`frn` 6, `form499` 5, `common` 5) counts `#sdk/*` specifiers **inside the owning package**.
- The one genuine architectural violation was invisible to the naming argument and was found by an edge
  check: `mcp/lib/cli.ts` took four symbols from `@mailwoman/filer/sdk`, a barrel that `export *`s
  seventeen modules, so an MCP request path carried the SEC and CORES HTTP clients and the EDGAR ingest to
  reach three functions. Fixed by moving those three modules to the filer package root — not by a rename.

**`tools/` is not available as the destination**, which the audit assumed it was. It carries at least four
senses: build tooling (`core`, `codex`, `corpus`), MCP tool DEFINITIONS (`dev-mcp`), a CLI command's library
half (`filer`, `mailwoman`), and product analysis (`registry`, whose header says "THE PRODUCT OUTPUT"). The
folder-name form of the enforcement rule — "nothing outside `tools/` may import `tools/`" — was written first
and produced **38 violations, every one of them correct behaviour**; 33 were `mailwoman/lib/commands/*`
calling their own command's library half. That experiment is why the shipped rule is scoped by package
identity instead.

## 3. If it is renamed anyway

`acquire/`, not `ingest/`. `soil/lib/sdk/acquire.ts` already picked the word, and `ingest` is taken: seven of
the ten packages have an `ingest.ts` INSIDE `sdk/`, so `ingest/ingest.ts` would be the result.

Conditions, all three or none:

1. **The enforcement rule ships in the same PR.** A rename without one repeats 2026-07-09 exactly.
2. **Clean break, no shims** — the established posture (CHANGELOG "Unreleased" carries the two breaks already
   taken this way).
3. **One package per commit**, largest last: `ban` (5 files / 3 subpaths) and `tiger` (5 / 2) first, because
   they are small enough that a mistake is visible; `filer` (20 / 14) and `soil` (11 / 14) last.

## 4. The `layer-kit` question

`coastal`, `flood`, `soil` and `zoning` look like four copies of one package. Eight filenames appear in all
four: `cells.ts`, `client.ts`, `download.ts`, `index.ts`, `ingest-chunk.ts`, `ingest.ts`,
`measure-resolutions.ts`, `verify.ts`.

### 4.1 The measurement

```bash
npx jscpd packages/{coastal,flood,soil,zoning}/lib/sdk --min-lines 20 --reporters console
```

> Found **1 exact clone** with **20 (0.18%) duplicated lines** in 38 files.

**That number is a RESIDUAL, and reading it as a baseline inverts what it means.** It was measured on a tree
where wave 2 of #2041 had already extracted the common code: the four ogr harnesses (~45 lines each), the four
`read*SourceIdentity` readers, nine batched-commit loops, four ingest-chunk runners, four two-phase build
handles, four manifest blocks, four byte-identical `#readCoverage` methods, the CKAN reader pair and the five
identical client factories now live in `core/layers`, `core/api`, `spatial` and `sqlite`. So 0.18% is evidence
that **the extraction worked**, not that these packages were never duplicated. Anyone re-running this after a
future extraction should expect the same shape and draw the same care.

Two limits on the instrument, both of which cut against over-reading it:

- `--min-lines 20` cannot see the 5–15-line idioms that were the actual duplication class here — a batched
  commit loop, a manifest block. The number is a floor on duplication, not a measure of it.
- "same filename, 2.1× size" measures VOLUME, not shared structure. Two files can differ in length and still
  share a control-flow skeleton; the table below is evidence against a copy, not evidence against a contract.

And the same-named files are not the same size:

| file              | coastal | flood | soil | zoning |
| ----------------- | ------: | ----: | ---: | -----: |
| `ingest.ts`       |     561 |   261 |  271 |    402 |
| `ingest-chunk.ts` |     318 |   174 |  182 |    360 |
| `client.ts`       |     272 |   260 |  284 |    335 |
| `download.ts`     |      62 |    61 |  161 |     78 |
| `verify.ts`       |     334 |   345 |  369 |    350 |

### 4.2 What that means

**The four packages share a VOCABULARY, not an implementation.** `ingest.ts` differing by 2.1× between
`coastal` and `flood` is not two copies of one function that drifted; it is two different ingests that were
given the same filename because they occupy the same stage. Extracting `layer-kit` would therefore remove
almost no code. It would instead require inventing an abstraction general enough to cover all four, and the
line counts say that abstraction does not exist yet.

This is the inverse of the usual finding, and it is the reason the audit's instinct ("the larger prize") should
not be taken on sight. `@mailwoman/core/layers`, which all four already share, is what the genuinely common
part looks like — and it is already extracted.

### 4.3 The contract question already has a home — and it is not a new package

`@mailwoman/core/layers` **is** the contract package. A fifth layer today already inherits
`runIngestChunkScript`, `buildSealedArtifact`, `polygonLayerManifest`, `designatedCoverageCells`,
`assertNoNegativeClaim` and `areaAgreementFrom` (with its witness type). So the question is not "should one
exist" but "what is still missing from the one that does" — which makes `layer-kit` the wrong shape twice
over: it would duplicate an existing home as well as failing the de-duplication test in §4.1.

The unextracted contract pieces are known and few. Three were deferred **with reasons** during #2041, and the
fourth is tracked:

| piece                                           | why it was left                        | the difference that blocks a naive merge                              |
| ----------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------- |
| the `measureCellResolutions` driver             | per-product control flow               | coastal measures per scenario; zoning narrows                         |
| the coastal/zoning `resolveDesignations` bodies | one substantive difference, not a copy | —                                                                     |
| the verify-driver skeleton                      | tolerance is a product constant        | agree/disagree tally is shared; soil's tolerance is 1 m against 0.5 m |
| the `schema-columns` rewire (#2046)             | adoption shifts stored column order    | four layer `schema.ts` files unrewired                                |

**"What does a fifth layer cost?" is therefore a countable question, not a survey**: build the list of stages
a new layer must supply, and count how many of them it must RE-DERIVE rather than inherit — today that is the
four rows above and nothing else. If that count is judged too high, the work is to extract those four into
`core/layers`, each behind the difference named in its row (a tolerance parameter, a per-scenario driver
hook). It is not to create a package.

## 5. Ordered plan, if §0.1 is overruled

1. Write the enforcement rule for the new name and prove it FAILS before and passes after (the shipped rule's
   `tile-worker` probe is the pattern).
2. `ban`, `tiger` — smallest, one commit each.
3. `geocode-oracle`, `osm`, `coastal`, `zoning`, `flood`.
4. `bdc`, `soil`, `filer` — largest published surfaces last.
5. One CHANGELOG "Unreleased" entry per package, listing every removed subpath.
6. `AGENTS.md`: replace the `sdk/` bullet rather than amending it again.

## 6. Sizing the bundled release: `sdk/` and `shard` are big in different currencies

§0.1b takes both renames in one breaking release. The premise offered for that — that removing `shard` is
"more public surface than `sdk/`'s 88" — does not survive measurement, and the correction changes what the
bundle is for.

|                           | `sdk/` |          `shard` |
| ------------------------- | -----: | ---------------: |
| published export subpaths | **83** |            **4** |
| files touched             |     87 | **435 of 2,508** |
| total occurrences         |      — |        **3,402** |
| distinct spellings        |      1 |          **165** |

The four `shard` subpaths are `core`'s `./resources/whosonfirst/sharded-repo`, `corpus`'s `./shard-recipes/*`,
`mailwoman`'s `./geocode-shards` and `resolver-wof-sqlite`'s `./sharding`.

**`sdk/` is an EXTERNAL break with a small internal footprint; `shard` is an INTERNAL refactor with a small
external one.** Two consequences:

1. The bundling argument holds, but it is buying one release for **87 subpaths**, not for two comparably-sized
   breaks — and the honest CHANGELOG line is "83 `sdk` paths and 4 `shard` paths".
2. The `shard` work is **not gated on a release**. Almost all of it is identifier churn no consumer observes;
   only those four subpaths need to wait. If the vocabulary work is otherwise ready it can land continuously,
   holding back only those four entries.

On the replacement word: there is none, by design. `shard` is being removed **because it stood for four
things**, so a single synonym would re-create the defect under a new spelling. The replacements are
per-concept nouns — corpus recipes, per-country postcode databases, WOF extracts, and the providers' region
databases — and the 165 distinct spellings are the map of which sites take which noun.

One path correction for anyone working from the earlier note: `packages/corpus/src/shard-recipes/` is now
`packages/corpus/lib/shard-recipes/` (#2050).

### 6.1 The completion criterion: `shard` reaches zero

**The work is done when the word appears zero times in tracked source.** Operator direction, 2026-09-01. A
countable finish line rather than a judgement, and the repo has done this once before: #2029 drove
`synchronousFilesystemCalls` to a baseline of **0** in `scripts/repo-health-baseline.json`, and the counter is
what kept it there.

The denominator matters, because "zero in the codebase" is not literally reachable and a criterion that cannot
be met gets quietly dropped:

- **Counted:** tracked `.ts`/`.tsx`, all spellings, case-insensitive. **Today: 3,481 occurrences across 2,508
  files, 165 distinct spellings.**
- **Not counted:** `docs/records/` and `CHANGELOG.md`. Those describe a state the repository was in, and
  rewriting them to remove the word would falsify a record — the same rule that kept the frozen
  pre-registrations out of the #2050 path sweep.
- **Decide when it is first non-trivial:** corpus data files and shard artifacts on disk carry the word in
  filenames and stored manifests. Renaming an artifact is a rebuild, not a refactor.

The enforcement shape is the one that already works: a `shardVocabulary` counter in `scripts/repo-health.ts`
with its baseline ratcheted downward per PR, so the count can only fall. Land the counter FIRST, at today's
**3,481**, so every subsequent PR is measured against it.

**THE INSTRUMENT MUST READ NUL-BEARING FILES, or it will report zero while occurrences remain.** Five tracked
sources carry raw NUL bytes (#2018), so `grep` classifies them as binary and skips them silently — no error,
no count. Measured on the same tree:

| command                |     count | why it differs                                 |
| ---------------------- | --------: | ---------------------------------------------- |
| `grep -aoiE` (correct) | **3,481** | reads every file                               |
| `grep -oiE` (no `-a`)  |     3,427 | **54 occurrences hidden** in 5 files           |
| `grep -aoE '[Ss]hard'` |     3,402 | case-sensitive; misses `SHARD`-style spellings |

The 54 hidden occurrences sit in `dev-mcp/lib/lookup-sources.ts` (35), `mailwoman`'s `nz-localities.ts` (13)
and `lieudit-pairs.ts` (4), `gauntlet/ablation.ts` (1) and `neural/lib/postcode-prefix-index.ts` (1). This is
a second, sharper consequence of #2018 than the one it records: NUL bytes do not merely make a file invisible
to `grep` — they would let a ratchet counter certify a finish line it never reached.

```bash
git ls-files '*.ts' '*.tsx' | grep -v /out/ \
  | xargs grep -aoiE '\b[a-z_]*shard[a-z_]*\b' | wc -l    # 3481 on 2026-09-01
```

## 7. Reproducing every number here

```bash
cd /home/lab/Projects/mailwoman
for d in packages/*/lib/sdk; do [ -d "$d" ] && echo "$d: $(ls "$d" | tr '\n' ' ')"; done
grep -rl '"#sdk/' packages --include='*.ts' | grep -v /out/ | cut -d/ -f2 | sort | uniq -c | sort -rn
for p in ban bdc coastal filer flood geocode-oracle osm soil tiger zoning; do
  node -e 'const q=require("./packages/'"$p"'/package.json");console.log("'"$p"'", Object.keys(q.exports||{}).filter(k=>k.startsWith("./sdk")).length)'
done
npx jscpd packages/{coastal,flood,soil,zoning}/lib/sdk --min-lines 20 --reporters console
yarn health:architecture   # the shipped no-serve-package-to-build-tooling rule
```
