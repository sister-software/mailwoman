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
   1b. **Do it when the next breaking release happens anyway.** Operator direction, 2026-09-01: a consumer
   should pay for renames once. That was written when a second rename — the retired four-way vocabulary word —
   looked like it had to travel in the same release. Measured, it did not: it carried **4** published subpaths
   against `sdk/`'s 83, so it was an internal refactor with a small external edge and shipped continuously
   instead (§6). `sdk/` is therefore the only passenger left, and still waits for a release it can share.
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

## 6. The other rename in flight — DONE, and it did not need the release

§0.1b planned to take this rename and the retired-vocabulary rename in one breaking release. The premise offered
for that — that the vocabulary change carried more public surface than `sdk/`'s 83 subpaths — did not survive
measurement, and the correction dissolved the coupling:

|                           | `sdk/` | the retired word |
| ------------------------- | -----: | ---------------: |
| published export subpaths | **83** |            **4** |
| files touched             |     87 | **435 of 2,508** |
| total occurrences         |      — |        **3,481** |
| distinct spellings        |      1 |          **165** |

**`sdk/` is an EXTERNAL break with a small internal footprint; the vocabulary rename was the reverse** — an
internal refactor with four subpaths attached. So it was never gated on a release, and it shipped continuously
instead: those four subpaths moved with their modules, each recorded in CHANGELOG "Unreleased".

That leaves the `sdk/` rename holding a release of its own, for 83 subpaths and no other passenger — which
strengthens §0.1 rather than weakening it. Bundle it with the next breaking change that has to happen anyway.

### 6.1 The completion criterion, and what it cost to state honestly

**Done: zero occurrences, enforced.** `repo-health`'s `bannedVocabulary` counter holds the tree there, with an
allow-list that carries a reason beside every entry. Three findings are worth keeping, because each one is a
trap for the next vocabulary removal:

1. **The instrument must read NUL-bearing files.** Five tracked sources carry raw NUL bytes (#2018), which
   `grep` treats as binary and skips SILENTLY — 3,481 occurrences with `-a` against 3,427 without. A
   `grep`-based ratchet would have certified zero with 54 still standing. The counter reads through Node
   instead, which has no such blind spot.
2. **A ratchet written in the language it polices is inside its own blast radius.** The case-preserving sweep
   renamed the counter AND rewrote the pattern it counts with, so the gate silently began measuring the
   REPLACEMENT word while still reporting a falling number. It stayed green throughout. The counter is now
   named neutrally, its term lives in one constant, and `scripts/repo-health.ts` excludes itself — otherwise
   the count can never reach zero, because the pattern has to spell what it bans.
3. **Scanning only `.ts`/`.tsx` under-reports by a lot.** The first zero left **125** occurrences standing in
   prose, config, dictionaries and eval rows — including three sentences in `AGENTS.md` telling the next agent
   that retired names were current. A vocabulary an agent reads is a vocabulary an agent writes.

What deliberately keeps it: the Vale rules that refuse it (a ban must name what it bans), `AGENTS.md` for the
same reason, and CONTENT — transliterated place names in the capitals gazetteer, real surnames and given names
in the libpostal dictionaries, and dated notes inside committed board rows. Renaming any of those would corrupt
data to satisfy a style rule.

One open item: those board-row notes are inside `SEED_CASE_KEY_ORDER`, so they are part of the pinned corpus
content hash. Editing one is a deliberate re-pin, not a sweep.

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
