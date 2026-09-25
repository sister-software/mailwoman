# Should `sdk/` be renamed — and should the four layer packages become one?

**Date:** 2026-09-01 · **Status:** proposal, decides nothing · **Refs:** #2050 · **Implements:** nothing.

This record answers two questions that were deliberately left out of the `sdk/` cleanup so they could be
decided on measurements rather than inside a file move. The first is whether the remaining ten `lib/sdk/`
directories should be renamed. The second is whether `coastal`, `flood`, `soil` and `zoning` should be one
package instead of four. §1 and §4 give both measurements with the commands that produced them. **Both
results contradicted the intuitive answer**, so they are recorded here rather than acted on.

---

## 0. The recommendation

1. **Do not rename `sdk/` on its own account.** The cost is 87 source files and **83 published subpaths**
   (88 before this arc removed five). The only benefit is that a directory name would agree with a sentence
   in `AGENTS.md`. The audit found two real defects: leftover code in `spatial`, and a request path that
   imported through an acquisition barrel. Both are already fixed, and neither fix was a rename (§2).
   1b. **Do it when the next breaking release happens anyway.** Operator direction, 2026-09-01: a consumer
   should pay for renames once. That direction was given when a second rename, of the retired four-way
   vocabulary word, looked like it had to ship in the same release. Measurement showed it did not. That
   rename carried **4** published subpaths against `sdk/`'s 83, so it was an internal refactor with a small
   external edge, and it shipped continuously instead (§6). `sdk/` is therefore the only rename left, and it
   still waits for a release it can share.
2. **If it is renamed anyway, the word is `acquire/`**, because `soil/lib/sdk/acquire.ts` already chose it,
   and the migration must ship with the enforcement rule in the same PR (§3).
3. **Do not build `layer-kit` for de-duplication.** The four layer packages share eight filenames and
   **0.18% of their lines**. There is almost nothing to de-duplicate, and a shared package would impose one
   abstraction over four implementations that differ substantially (§4).
4. **A shared package may still be worth building for a different reason**, namely a single tested
   interface for the ingest stages. That design argument must be made on its own evidence, and this record
   does not make it (§4.3).

---

## 1. What is there

Eleven packages had `lib/sdk/`, and `spatial` no longer does. The ten that remain are all dataset packages,
and no runtime package has one. The directory therefore does correspond to a real category, as the audit
assumed.

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

The audit that prompted this work proposed the rename as the fix for drift. Two findings argue against it.

**The same fix was tried before, and it did not last.** The 2026-07-09 regroup moved
`mailwoman/sdk/{cli,test}` to `cli-kit/` and `test-kit/`, added the one-line `AGENTS.md` rule, and stated
that "`sdk` submodule meaning is restored: data acquisition only." By 2026-09-01, `filer/lib/sdk/` and
`bdc/lib/sdk/` held domain analysis again. A directory name cannot enforce itself, and a second rename would
repeat the first attempt.

**Neither real defect was a naming defect.** The audit reported three violations, and measurement showed:

- `spatial/lib/sdk/` held a WKT/WKB codec and an `ogrinfo` shell-out. The defect was real and is fixed, but
  it was a location defect. Nothing imported the code incorrectly, and it only sat in the wrong folder. No
  dependency rule could have caught it, and none did.
- The `filer`/`bdc` "drift" was largely a measurement error. The audit's table of external importers
  (`frn` 6, `form499` 5, `common` 5) counts `#sdk/*` specifiers **inside the owning package**.
- An edge check found the one actual architectural violation, which the naming argument could not have
  detected. `mcp/lib/cli.ts` took four symbols from `@mailwoman/filer/sdk`, a barrel that `export *`s
  seventeen modules. An MCP request path therefore loaded the SEC and CORES HTTP clients and the EDGAR
  ingest to reach three functions. The fix moved those three modules to the filer package root, without a
  rename.

**`tools/` cannot serve as the destination**, although the audit assumed it could. The directory already
has at least four meanings: build tooling (`core`, `codex`, `corpus`), MCP tool definitions (`dev-mcp`), a
CLI command's library half (`filer`, `mailwoman`), and product analysis (`registry`, whose header says "THE
PRODUCT OUTPUT"). The folder-name form of the enforcement rule, "nothing outside `tools/` may import
`tools/`", was written first. It produced **38 violations, and every one was correct behavior**. 33 of
them were `mailwoman/lib/commands/*` calling their own command's library half. That experiment is why the
shipped rule is scoped by package identity instead.

## 3. If it is renamed anyway

Use `acquire/` rather than `ingest/`. `soil/lib/sdk/acquire.ts` already uses the word, and `ingest` is
already in use: seven of the ten packages have an `ingest.ts` inside `sdk/`, which would produce
`ingest/ingest.ts`.

The rename requires all three of these conditions:

1. **The enforcement rule ships in the same PR.** A rename without one repeats 2026-07-09 exactly.
2. **Clean break without shims**, which is the established approach. CHANGELOG "Unreleased" carries the
   two breaks already made this way.
3. **One package per commit**, largest last. `ban` (5 files / 3 subpaths) and `tiger` (5 / 2) go first,
   because they are small enough that a mistake is visible. `filer` (20 / 14) and `soil` (11 / 14) go last.

## 4. The `layer-kit` question

`coastal`, `flood`, `soil` and `zoning` look like four copies of one package. Eight filenames appear in all
four: `cells.ts`, `client.ts`, `download.ts`, `index.ts`, `ingest-chunk.ts`, `ingest.ts`,
`measure-resolutions.ts`, `verify.ts`.

### 4.1 The measurement

```bash
npx jscpd packages/{coastal,flood,soil,zoning}/lib/sdk --min-lines 20 --reporters console
```

> Found **1 exact clone** with **20 (0.18%) duplicated lines** in 38 files.

**That number is what remained after an extraction, so reading it as a baseline reverses its meaning.** It
was measured on a tree where wave 2 of #2041 had already extracted the common code. The four ogr harnesses
(~45 lines each), the four `read*SourceIdentity` readers, nine batched-commit loops, four ingest-chunk
runners, four two-phase build handles, four manifest blocks, four byte-identical `#readCoverage` methods,
the CKAN reader pair and the five identical client factories now live in `core/layers`, `core/api`,
`spatial` and `sqlite`. The 0.18% therefore shows that **the extraction worked**. It does not show that
these packages were never duplicated. Anyone re-running this after a future extraction should expect the
same pattern and interpret it the same way.

The instrument has two limits, and both caution against over-reading it:

- `--min-lines 20` cannot see the 5–15-line idioms that made up the actual duplication here, such as a
  batched commit loop or a manifest block. The number is a lower bound on duplication rather than a
  measure of it.
- "same filename, 2.1× size" measures volume rather than shared structure. Two files can differ in length
  and still share a control-flow skeleton. The table below is evidence against a copy, and it says nothing
  about a shared interface.

The same-named files also differ in size:

| file              | coastal | flood | soil | zoning |
| ----------------- | ------: | ----: | ---: | -----: |
| `ingest.ts`       |     561 |   261 |  271 |    402 |
| `ingest-chunk.ts` |     318 |   174 |  182 |    360 |
| `client.ts`       |     272 |   260 |  284 |    335 |
| `download.ts`     |      62 |    61 |  161 |     78 |
| `verify.ts`       |     334 |   345 |  369 |    350 |

### 4.2 What that means

**The four packages share a vocabulary rather than an implementation.** The 2.1× size difference in
`ingest.ts` between `coastal` and `flood` does not come from two copies of one function that drifted. They
are two different ingests given the same filename because they perform the same stage. Extracting
`layer-kit` would therefore remove almost no code. It would require inventing an abstraction general
enough to cover all four, and the line counts show that no such abstraction exists yet.

This is the opposite of the usual finding, and it is why the audit's instinct ("the larger prize") should
not be accepted without measurement. `@mailwoman/core/layers`, which all four already share, holds the
code they have in common, and that code is already extracted.

### 4.3 The interface question already has a home — and it is not a new package

`@mailwoman/core/layers` **is** the interface package. A fifth layer today already inherits
`runIngestChunkScript`, `buildSealedArtifact`, `polygonLayerManifest`, `designatedCoverageCells`,
`assertNoNegativeClaim` and `areaAgreementFrom` (with its witness type). The real question is what the
existing package still lacks. `layer-kit` is the wrong answer for two reasons: it would duplicate an
existing home, and it fails the de-duplication test in §4.1.

The interface pieces that remain unextracted are known and few. Three were deferred **with reasons**
during #2041, and the fourth is tracked:

| piece                                           | why it was left                               | the difference that blocks a naive merge                              |
| ----------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------- |
| the `measureCellResolutions` driver             | per-product control flow                      | coastal measures per scenario; zoning narrows                         |
| the coastal/zoning `resolveDesignations` bodies | one substantive difference rather than a copy | —                                                                     |
| the verify-driver skeleton                      | tolerance is a product constant               | agree/disagree tally is shared; soil's tolerance is 1 m against 0.5 m |
| the `schema-columns` rewire (#2046)             | adoption shifts stored column order           | four layer `schema.ts` files unrewired                                |

**"What does a fifth layer cost?" can therefore be answered by counting rather than by a survey.** List the
stages a new layer must supply, and count the ones it must re-derive rather than inherit. Today that count
is the four rows above. If that count is judged too high, the work is to extract those four into
`core/layers`, each parameterized by the difference in its row (a tolerance parameter, a per-scenario
driver hook). The work does not require a new package.

## 5. Ordered plan, if §0.1 is overruled

1. Write the enforcement rule for the new name, and show that it fails before the migration and passes
   after it. The shipped rule's `tile-worker` probe is the pattern.
2. `ban` and `tiger`, the smallest, in one commit each.
3. `geocode-oracle`, `osm`, `coastal`, `zoning`, `flood`.
4. `bdc`, `soil`, `filer`, with the largest published surfaces last.
5. One CHANGELOG "Unreleased" entry per package, listing every removed subpath.
6. `AGENTS.md`: replace the `sdk/` bullet rather than amending it again.

## 6. The other rename in flight — DONE, and it did not need the release

§0.1b planned to ship this rename and the retired-vocabulary rename in one breaking release. That plan
assumed the vocabulary change carried more public surface than `sdk/`'s 83 subpaths. Measurement showed the
opposite, so the two renames no longer needed to ship together:

|                           | `sdk/` | the retired word |
| ------------------------- | -----: | ---------------: |
| published export subpaths | **83** |            **4** |
| files touched             |     87 | **435 of 2,508** |
| total occurrences         |      — |        **3,481** |
| distinct spellings        |      1 |          **165** |

**`sdk/` is an external break with a small internal footprint, and the vocabulary rename was the
reverse**: an internal refactor with four subpaths attached. It never needed to wait for a release, and it
shipped continuously instead. Those four subpaths moved with their modules, and each move is recorded in
CHANGELOG "Unreleased".

The `sdk/` rename would now need a release of its own for 83 subpaths and nothing else, which strengthens
§0.1. Bundle it with the next breaking change that has to happen anyway.

### 6.1 The completion criterion, and what it cost to state directly

**Done: zero occurrences, enforced.** `repo-health`'s `bannedVocabulary` counter keeps the count at zero,
with an allow-list that carries a reason beside every entry. Three findings are worth keeping, because
each one could mislead the next vocabulary removal:

1. **The instrument must read NUL-containing files.** Five tracked sources carry raw NUL bytes (#2018).
   `grep` treats them as binary and skips them without warning: it finds 3,481 occurrences with `-a` and
   3,427 without. A `grep`-based ratchet would have reported zero with 54 occurrences remaining. The counter
   reads files through Node instead, which reads NUL-containing files like any other file.
2. **A ratchet written in the language it polices is inside its own scope.** The case-preserving sweep
   renamed the counter and rewrote the pattern it counts with. The check then began measuring the
   replacement word while still reporting a falling number, and it stayed green throughout. The counter is
   now named neutrally, its term lives in one constant, and `scripts/repo-health.ts` excludes itself.
   Without that exclusion the count could never reach zero, because the pattern has to spell what it bans.
3. **Scanning only `.ts`/`.tsx` under-reports substantially.** The first zero left **125** occurrences in
   prose, config, dictionaries and eval rows, including three sentences in `AGENTS.md` that told the next
   agent the retired names were current. Agents reproduce the vocabulary they read.

The word deliberately remains in three places. The Vale rules that refuse it must spell what they ban.
`AGENTS.md` keeps it for the same reason. Content also keeps it: transliterated place names in the capitals
gazetteer, real surnames and given names in the libpostal dictionaries, and dated notes inside committed
board rows. Renaming any of those would corrupt data to satisfy a style rule.

One item is open. Those board-row notes are inside `SEED_CASE_KEY_ORDER`, so they are part of the pinned
corpus content hash. Editing one requires a deliberate re-pin, so a sweep must not change them.

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
