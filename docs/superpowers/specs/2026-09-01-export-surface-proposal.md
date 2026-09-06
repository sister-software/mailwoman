# The export surface: 727 subpaths, and what they were actually buying

**Date:** 2026-09-01 · **Status:** DONE, with two recommendations measured and rejected · **Refs:** #2050

Every number here was re-derived on `main` at `dcfd5f106`; §6 has the commands. Four of the operator's
figures were confirmed exactly and four surrounding claims needed correcting — §5 lists both, because a record
that only reports agreement is not worth re-reading.

---

## Outcome (2026-09-01, later the same day)

**727 → 641 subpaths**, across #2058, #2061, #2062 and #2063, all merged. The folds and the collapse landed
together, as §4.1 asked, because the directory structure IS the new export list.

| workspace             |                                            subpaths |
| --------------------- | --------------------------------------------------: |
| `dev-mcp`             | 51 → 4 (wildcard; private, so no consumer to break) |
| `resolver-wof-sqlite` |                                             61 → 45 |
| `mailwoman`           |                                             55 → 45 |
| `neural`              |                                             40 → 31 |
| `resolver`            |                                             15 → 11 |

**Both of the remaining recommendations in §0 were measured, and BOTH were wrong.** That is the useful part
of this record now.

### §0.2 — `sideEffects: false` is correct, but not for the reason given

Landed on the **43 of 59** published packages that earn it, by walking each module's top-level statement
list (an expression statement, a bare `import "x"` or a top-level await RUNS; a declaration does not). The
16 that cannot claim it are almost all entries — `lib/cli.ts`, `scripts/*.ts` — not library modules.

The rationale here said it would let a barrel tree-shake, demoting the browser-safe-leaf discipline to
defence in depth. **It does not.** Measured after landing it: repointing one demo import from
`street/normalize` back to the `street` barrel still produces 27
`'x' is not exported from 'node:fs/promises'` errors. The leaf rule is still load-bearing, and
`webpack-policy.test.ts` now refuses a barrel import by name in ~30 ms — because the only other thing that
catches it is a five-minute `docusaurus build`.

_(A first pass at the audit reported 13 clean packages. It used a regex, and `^` under the `m` flag matches
an indented statement inside a function exactly as happily as a top-level one. It also flagged `neural`,
which already declared the field — that contradiction is what exposed it.)_

### §0.4 — the docs alias map must NOT be derived from `exports`

This looked obviously right and is the opposite of right. **The alias list's job is to DIFFER from the
exports map.** `@mailwoman/resolver-wof-sqlite` now advertises both `./fst` and `./fst/deserialize-web`;
Node callers should take the barrel and the browser must take the leaf, because the barrel re-exports
`fst/freshness`, which reaches `@mailwoman/core/fs`. A derivation reads both entries and has no way to
express the preference — it is an editorial judgement about the BROWSER, and the exports map is not written
from the browser's point of view.

What the hand-list needed was not derivation but a refusal: `requireAlias` now throws on an entry that
resolves to nothing, which caught three real breaks during the fold (`resolver-wof-sqlite/geo` and
`core/kysley/dialect`, both long dead, and `resolver/resolve` the moment it became a directory).

### Still open

- An **array-valued** `sideEffects` naming the entry files would let the other 16 packages shake their
  library halves. Worth doing; not done.
- `core` (80) and `codex` (54) are now the two largest surfaces and neither was folded — no prefix families
  at their roots, so the reduction there is a different exercise.

---

## 0. The shape

1. **Directory-level entries, not file-level.** Each prefix fold becomes one export: `./geocode` →
   `lib/geocode/index.ts`, `./eval-harness` → its barrel. Internal reach stays free through `#*`, which is the
   map that was doing the real work all along.
2. **Keep the deliberate isolation leaves, and MARK them** — each needs its reason in its own docstring, which
   today only one of three has (§2). Add `"sideEffects": false` to every published package so barrel imports
   tree-shake and the leaf list stops growing for bundle reasons; today exactly **one** package declares it.
3. **Wildcards only where the surface is not public.** Five of the 64 workspaces are private.
4. **Derive the mirrors.** The docs alias map hand-copies subpaths, and that list is **already stale** (§2.2).

---

## 1. The census

**727 export subpaths** across the 64 workspaces, excluding `./package.json`. **654 of them are in published
packages**; 73 sit in the five private ones.

| package               | subpaths | wildcard | visibility  |
| --------------------- | -------: | -------: | ----------- |
| `core`                |       80 |        4 | published   |
| `resolver-wof-sqlite` |       61 |        0 | published   |
| `mailwoman`           |       55 |        4 | published   |
| `codex`               |       54 |        0 | published   |
| `dev-mcp`             |       51 |        0 | **private** |
| `neural`              |       40 |        0 | published   |
| `react`               |       31 |        0 | published   |
| `corpus`              |       29 |        5 | published   |

The cause is structural rather than anybody's oversight: **a per-FILE subpath has been standing in for a
public-API decision.** Every shared module lands with a manifest entry, so the map grows one line per refactor
whether or not anyone outside the package should reach that file.

## 2. What the subpaths are actually buying

Measured, the answer is **bundle isolation, not API design**. Three leaves exist because a barrel import
dragged a Node-only dependency into a browser graph:

| subpath                           | what it keeps out                      |
| --------------------------------- | -------------------------------------- |
| `@mailwoman/sqlite/introspection` | `node:sqlite`, out of the browser demo |
| `@mailwoman/core/trust-policies`  | a jsdom window constructed at import   |
| `@mailwoman/neural/viterbi`       | onnxruntime, out of the docs bundle    |

So "no subpaths" is wrong and "727 of them" is also wrong. A barrel-only world breaks all three unless barrels
are side-effect-free **and** every Node-only dependency sits behind its own entry.

### 2.1 The reasons are not written down

**Two of those three modules do not state why they are a separate entry.**
`sqlite/lib/introspection.ts` says only "`@file` Questions asked of `sqlite_master`";
`neural/lib/viterbi.ts` describes the CRF decoder. Only `core/lib/trust-policies.ts` mentions jsdom.

That is how a deliberate leaf gets tidied away: a future agent collapsing the surface reads three modules,
finds one reason, and folds the other two into a barrel — reintroducing exactly the bundle break the split was
made to prevent. **Writing the reason into each docstring is a prerequisite of the collapse, not a follow-up.**

### 2.2 The hand-copied mirror is already stale

`docs/plugins/demo-assets/workspace-aliases.ts` hand-lists subpaths in `FILE_SUBPATHS` and `CODEX_SUBPATHS`.
`FILE_SUBPATHS` aliases `@mailwoman/resolver-wof-sqlite/geo` — and that subpath **no longer exists**
(`./geo` was removed from the exports map when the geometry helpers moved to `@mailwoman/spatial`, and
`lib/geo.ts` is gone with it).

It has not been noticed because it fails softly: `resolvePackageFile` returns `null` for a missing target and
`existingCompiledFile` logs "alias skipped". A derived map cannot go stale this way, which is the argument for
§0.4 stated as a defect rather than as a preference.

## 3. Where the count would land

`mailwoman`'s 55 collapse toward the count of its top-level directories; `core`'s 80 toward `./fs`, `./utils`,
`./strings`, `./layers`, `./api`, `./decoder` and the rest. The exact figure is not predictable before the
folds are drawn, which is the reason for the sequencing in §4: **the directory structure IS the new export
list**, so drawing it twice would be doing the work twice.

`dev-mcp` is the single largest cheap win — **51 subpaths, private**, so a `./*` wildcard there breaks no
consumer because nothing outside this monorepo installs it. `docs` (12, already 4 wildcards),
`geocode-oracle` (9) and `neural-weights-base-latn` (1) are the rest of the private set; `tile-worker` is
private but exports nothing at all, so it is not in scope.

## 4. Sequencing

1. **Fold the collapse into the hierarchy arc's second half**, not before it.
2. **Take the subpath removals in the same breaking release as the `sdk/` rename** — one CHANGELOG entry per
   package listing every removed path, rather than two rounds of consumer churn. See
   `2026-09-01-sdk-rename-and-layer-kit-proposal.md` §6, which sizes what is left to bundle.
3. **`sideEffects: false` and the leaf docstrings land FIRST**, before any collapse. Both are prerequisites:
   without the flag a barrel import stops tree-shaking, and without the docstrings the leaves get collapsed by
   someone who cannot see why they exist.
4. **Derive the docs alias map before the folds move anything**, so the folds do not have to be mirrored by
   hand into a list that is already wrong.

## 5. Corrections to the figures this record was given

Confirmed exactly: **727** total; `core` 80, `resolver-wof-sqlite` 61, `mailwoman` 55, `codex` 54,
`dev-mcp` 51, `neural` 40.

| claim                               | measured                    | note                                                  |
| ----------------------------------- | --------------------------- | ----------------------------------------------------- |
| "the 53 published packages"         | **59 published, 5 private** | of the 64 workspaces                                  |
| "today's arc added roughly a dozen" | **−2**                      | today's two PRs took 729 → 727                        |
| —                                   | **+9**                      | #2041 took 720 → 729; the "dozen" belongs to that arc |
| "add `sideEffects`"                 | **1 of 59 declares it**     | only `packages/neural`, `false`                       |
| "each has a stated reason"          | **1 of 3 does**             | §2.1                                                  |

The `lib/` move (#2051) was deliberately subpath-neutral — it changed only the dev-only `node` condition — so
neither of today's PRs is a source of growth. The growth is real; it just belongs to the dedup arc.

## 6. Reproducing every number here

```bash
cd /home/lab/Projects/mailwoman
node -e 'const p=require("./package.json");let t=0,pub=0,se=[];for(const w of p.workspaces){const m=require("./"+w+"/package.json");const n=Object.keys(m.exports||{}).filter(k=>k!=="./package.json").length;t+=n;if(m.private!==true)pub+=n;if(m.sideEffects!==undefined)se.push(w)}console.log({total:t,published:pub,sideEffects:se})'

# is the hand-listed docs alias still real?
node -e 'console.log("./geo exported:", "./geo" in require("./packages/resolver-wof-sqlite/package.json").exports)'
ls packages/resolver-wof-sqlite/lib/geo.ts

# per-commit growth
git show f656fac0b^1:packages/core/package.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(Object.keys(JSON.parse(s).exports).length))'
```
