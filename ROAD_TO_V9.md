# ROAD_TO_V9 — the floor for the next model promotion and the next mailwoman major

Opened 2026-08-06 from the Run B / country-sweep / #1514 cycle. This document is the **floor**: the
set of things that must be true before (a) model v4.2.0 is promoted to the shipped lineage and (b)
the v9.0.0 release is cut. Items are tiered — A gates the model, B gates the release, C rides along
if ready and does not block. Each item carries its acceptance bar and the issue that tracks it.
The standing invariants (the D-rule above all: no default-on mechanism ships with a known regression
vs the shipped model on any tier-1 locale) apply to every item and are not restated per line.

Two decisions in this document are operator-ratified as of 2026-08-06 and recorded here so they do
not get re-litigated: **ranking is referential, not encyclopedic** (§2), and **v4.2.0 promotes with
conditions** rather than waiting on a retrain (§1).

## Status — 2026-08-07

**v9.0.0 SHIPPED** (`e0c4a308e`, 2026-08-06), carrying the anchor-cure base. **Tiers A and B are
essentially closed.** Every §1 promotion condition landed (A1 in #1521; A2–A6 in #1527; the four
defects behind them — #1509/#1510/#1511/#1512 — closed). §2's two-score split landed (#1538). §3's
board was built and met its bar (#1524). §4's intent vocabulary landed ahead of its C tier (#1536).
§6's instrument work landed (#1525 for I2–I4, #1554 for I1). §7 landed as one bundle (#1522).

**Read issue state with care in this repo.** Several issues listed in the sections below are still
OPEN on GitHub while the work that answers them has merged — #1491, #1493, #1495, #1505 were all
executed in #1522, and #1507 in #1525. The PR bodies reference the issues without closing them. Trust
the merged PR, not the issue state; this document was itself briefly wrong on that basis.

So this is now the **post-v9 ledger**. Sections are marked ✅ (landed), ◐ (partly landed), or ○ (open).

What actually remains, in rough leverage order:

1. **§2-R3 / #1497 — the FST swap decision, reframed by its own board.** #1524's finding is the
   important one: `applyBias` collapses to max() per tag and only four placetypes reach BIO mapping,
   so _which_ Saint-Denis outranks which is invisible to the decoder — it is a RESOLVER concern. The
   decode-time importance swap is therefore marginal by construction, and the two-score split's real
   home is candidate ranking. Also unresolved from that run: `parseForGeocode` constructs no FST at
   all (`geocode-core.ts:552-586`), so the default oa-resolver run and every gauntlet mode are
   FST-blind — and one row (`sweep-vn-cs-12-ly-thai-to`) flips between arms with byte-identical FST
   subpaths, meaning an FST swap can move a parse through a channel that is not the bias magnitude.
   That residual is unattributed.
2. **§6-I5 / #1492** — promoted-artifact swaps still race CI on the shared data root. The only §6
   item with no landed answer.
3. **§5 coverage + territory repair (#1503, #1519)** — see the section for what each covers now.

---

## §1 — ✅ CLOSED — Tier A: promote model v4.2.0 (the anchor-cure base)

Promoted and shipped in v9.0.0. A2–A6 landed together in #1527 ("the card is the contract, and the
channel survives lowercase"); the four defects they were written against — #1509, #1510, #1511,
#1512 — are all closed. A1's diagnosis merged as #1515, and #1526 recorded the truncation pair's
honest status (they track under #1519, they do not gate). The table below is kept as the record of
what the promotion actually required.

The evidence record is `docs/records/evals/2026-08-05-v420-base-anchor-v2-run-b.md` (#1508) and the
regression diagnosis (#1515). Cure proven: gb-golden 318/318 with the anchor channel fed; Fisher
mass on the GB slot 11.28% with CA/JP exact-zero controls; GB dependent_locality 0 → 205/207 under
the base package; US/FR parity up; int8 ↔ fp32 byte-identical.

Conditions, all satisfiable without GPU time:

| #   | Condition                                                                                                                                                                     | Bar                                                                                                         | Tracks                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------- |
| A1  | Re-grade the four territory rows (`pr-op3-venezuela-san-juan`, `vg-op3-road-town`, `vi-op3-chocolate-hole-cruz-bay`, `pr-op3-playa-sardinas-culebra`) to `improvement_target` | gauntlet gated legs green under v4.2.0 with the re-grade applied; the rows stay tracked, never deleted      | #1515's finding; rows' own notes |
| A2  | The weights assembly ships the card contract this model requires: `"requires": { "anchor": { "required": true, "span_mode": "shaped" } }`                                     | `createScorer` fails closed without it; a packaged-weights smoke proves the shaped keyer fires on gb-golden | recipe header's SHIP OBLIGATION  |
| A3  | Serving lexicons match training: the card names its lexicon versions and `resolveWeights` resolves from the card (v7 locality-surface, not the hard-coded v6 filename)        | a train/serve lexicon mismatch is a load-time error, not a silent downgrade                                 | #1510                            |
| A4  | The en-gb overlay ships the evidence-bundle lexicons its card claims, plus the new Code-Point `postcode-gb.bin` (1,749,839 keys, builder on #1508's branch)                   | overlay smoke: both evidence channels feed on GB input; the bin fires 106/120 on gb-golden                  | #1511                            |
| A5  | `gazetteer postcode-binary` refuses to write an empty (or below-floor) bin, and derives GB outwards by shape, not space-split                                                 | the #1509 reproduction exits nonzero with a named reason                                                    | #1509                            |
| A6  | Shaped span-mode is guarded against the lowercase register: the scorer refuses `span_mode: "shaped"` when case normalization is off, or the keyer case-folds                  | lowercase leg of gb-golden scores identically to as-written                                                 | #1512                            |

Recorded, **not** gating — the named lever for the next training run, whenever one happens:
`synth-gb` dose 6.0 → 3.0 and `countryFraction > 0` on that shard (800k country-less rows taught a
positional habit; see #1515). Do not retrain for this alone.

## §2 — ◐ Tier A/B: ranking is referential — the two-score split

R1 **landed** (#1538 — referential ranks, encyclopedic rides) and Saint-Denis is re-pinned (#1540).
R3's precondition is **met, not pending**: the §3 board separates the arms (#1524). What that board
found reframes R3 rather than unblocking it — the decode-time swap is marginal because within-name
ranking never reaches the decoder — so the open question is now the resolver-side ranking, plus the
two loose ends named in the status block. The ratified policy below stands unchanged.

Ratified policy: **"importance of a knowledge-base article ≠ probability this is the place the user
means." The geocoder ranks by referential likelihood.** Encyclopedic importance is carried as data,
never as the ranking key.

- **R1 (B):** the gazetteer and FST entry carry two fields: `referential` (population-anchored — the
  backbone) and `encyclopedic` (the Wikipedia join, fan-out-guarded per #1499). The decoder's bias
  reads `referential`. Saint-Denis is the canonical test: the hamlet (pop 202) must lose to the
  suburb (pop 96,128) with no hand rule involved.
- **R2 (C):** the blend weights, if any beyond population, are **fitted, not hand-set** — the
  Fellegi-Sunter construction from `match/` over (name-match, population-log, placetype-prior,
  admin-context, wiki-signal), evaluated on the §3 board. Rules-shaped scoring functions are the
  thing this project deleted in v7; we do not reintroduce one by the side door.
- **R3 (A for any FST swap):** no importance/FST change ships until the §3 board separates the
  arms. Today three arms (no FST / population FST / real-importance FST) score byte-identically on
  the OA board — an unmeasurable change is an unshippable change. Tracks #1497.
- One hard rule survives from the ranking discussion, as abstention doctrine rather than scoring: a
  bare query never resolves to an obscure feature type without declared ambiguity (§4).

## §3 — ✅ BUILT: the hard-slice board (the shared unblocking artifact)

Executed in #1524: 87 curated rows — bare namesakes (including the sweep's family C), comma-free
fragments, homonym confounds, wiki-vs-population conflict pairs with Saint-Denis explicit, and
country-distinctive structures. **Bar met**: the none/pop/importance arms score differently (1/3/4
differing rows), deterministically across runs (0/261 cells) and independent of arm order. Board,
loader, zod schema, nine tests, the three-arm runner and the bias probes are all committed.

It also paid for itself in findings rather than just discrimination — Saint-Denis measured at 4.8×
inverted (hamlet pop 418 at encyclopedic 0.5683 vs suburb pop 96,128 at 0.1173), direct receipts for
§2's ratified policy; and the reason the OA board could never separate the arms turned out to be that
`parseForGeocode` builds no FST at all. See the status block above for what that implies for §2-R3.

One board, three consumers: the FST/importance gate (#1497), the intent work (§4), and the
suggestion layer's bars (#1489). Contents: bare city names (namesake-prone: the sweep's 45
family-C rows are seed material), comma-free fragments, homonym confounds
(Paris/Springfield/Washington classes), and the sweep's country-distinctive structures (42.9% hit
rate — the highest-yield class, measured against the draft's expectations in #1513).

Bar for the board itself: the three FST arms produce **different** scores on it (discrimination),
and it carries per-row declared tolerances with the meaning-of-zero discipline (a no-coordinate row
is absence, not zero). The 306-case corpus + `cases/generalization/` passes are the raw material;
the board is a curated slice, not another sweep.

## §4 — ✅ LANDED (ahead of tier): query intent, pre-decoder

Shipped as #1536 — four kinds, an advisory marker, and a top slot that never moves, implemented as
kind-classifier vocabulary exactly as specified below rather than a new stage. The extension list
below records what was built; `poi_category` remains gated on the poi.db ancestry/gers_id debt.

Intent lives where it always has: **before the decoder**, as vocabulary of the existing
kind-classifier — not a new stage. Extensions, in priority order:

1. `poi_category` — "tacos", "grocery store": the poi-taxonomy synonym table + poi.db are the
   lexicon and the answer set. Blocked only by the poi.db ancestry/gers_id debt already on the
   spatial-layers ledger.
2. `bare_toponym` — feeds §2's ranking and the declared-ambiguity path.
3. `route_pair` — "Paris London": two coherent toponyms, no address grammar between them. The
   correct v9 behavior is _classification + declared fork_, not a router.
4. `near_me` — preposition + no anchor → requires a focus point. Default: caller's focus if
   supplied (Photon already accepts one), else locale-country coarse bias; a focus-biased answer
   **says so** in its attribution.

Guessing doctrine (applies at every tier now): rank by referential likelihood; when the dominance
margin is thin (the measured 0.5 log10 line from the ablation-ladder work), return the winner with
declared ambiguity — the suggestion layer's nudge shape — and never resolve a bare query to an
obscure feature type silently.

## §5 — ◐ Tier B/C: coverage floor from the sweep

- **B:** the 45 namesake rows and 27 no-coordinate rows from #1513 stay tracked; the release notes
  state coverage honestly (the "what mailwoman does not cover" register).
- **C:** territory repair — PR/VI containment holes (#1503, open) and a PR address shard (TIGER
  covers Puerto Rico; the corpus never ingested it). This is the data cure for the §1-A1 rows.
  Dual-role places (#402) closed separately.
- **C:** the truncation family (#1519, 15 rows) — **partly cured**: #1552 landed the trailing
  abbreviation period fix (`Neusser Str.` no longer loses its period). The multi-word cases
  (`Amphitheatre Parkway` → `Amphitheatre`, `Port of Spain` → `Spain`) are untouched and #1519 stays
  open as their board.

## §6 — ○ Tier B: instrument integrity

**Every item here is still open** (#1516, #1507, #1492, plus I3 which has no issue yet). None of it
blocked v9, and all of it is still a way the instruments can lie silently. I1 is the one with a
known false verdict already on the record — it scored Run B's _gained_ GB capability as a loss.

A release is gated by instruments; these are the known ways the instruments lie, and the floor is
that none of them can lie silently at release time:

| Item | Defect                                                                                                                              | Bar                                                                                                          | Tracks                                               |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| I1   | Invariance runner measures the raw classifier, en-US for every row — scored Run B's gained GB capability as a loss                  | invariance runs the pipeline path with per-row locale, and the verdict shape gains a gained-capability class | #1516                                                |
| I2   | `expectPlaceID` / `expectPlaceName` stored but never checked                                                                        | wire into `checkCase` or delete the fields                                                                   | #1507                                                |
| I3   | `regression.db` can be silently rebuilt from a stale compiled tree ("built" from the deleted array — 2026-08-06)                    | the builder stamps the corpus hash into the DB; the runner refuses on mismatch with the live loader's hash   | circle-back note; same pattern as #1488's FST stamps |
| I4   | Missing `postcode-us.bin` silently costs 3–4 baseline gauntlet cases; the anchor-OFF log warning fires even when the bin is present | grading environments assert bin presence; the warning names its actual condition                             | #1516 (second half)                                  |
| I5   | Promoted-artifact swaps race CI on the shared data root                                                                             | CI takes a private symlink-overlay data root                                                                 | #1492                                                |

## §7 — ✅ Tier B: release mechanics

v9.0.0 cut successfully and the listed cleanups landed as one bundle in #1522: the
`overlay-manifest --version` collision (#1491, renamed to `--corpus-version`, with an AST-based
guard test proven non-vacuous by reintroducing the collision), the candidate delivery-city alias gap
(#1495), FST retirement (#1493), and the workspace table (#1505). Those issue numbers are still open
on GitHub — see the status block. `gazetteer publish` (#1494) remains C-tier and unbuilt. #1535 and
#1534 landed alongside the release.

- The release rebuilds the shipped pair indexes at PIX schema 3 via `copy-weights` (readers refuse
  v1/v2 — this is the planned atomic cutover, verify it in the release smoke).
- `gazetteer publish` (#1494) is the coherent-bundle answer; for v9 the floor is the manual chain
  executed with the #1488 freshness stamps green — the tool itself is C-tier.
- Fold discipline post-#1514: `--fold` stays default-OFF; the release runbook's candidate step runs
  fold-free against the already-folded admin artifact.
- Fix the `corpus overlay-manifest` `--version` flag collision before anyone needs the tool during
  a release week (#1491), sweep AGENTS.md's workspace table (#1505), and close the candidate
  delivery-city gap (#1495) with the next candidate rebuild.
- FST artifacts with no builder (#1493): decide retire-vs-rebuild for `fst-global-priority.bin` and
  the CJK three before the release publishes stale binaries to HF again.

## §8 — Explicitly NOT the v9 floor

Named so their absence from the gate list reads as a decision, not an omission: the JP serving arc
(the 0.9928 char model has no serving path yet — its own arc), the suggestion-layer implementation
(bars preregistered in #1489; the ablation map and §3 board feed it), the FST importance **swap
itself** (gated behind §2 + §3, no urgency — the population proxy loses us nothing today), the
deletion-ablation extensions (#1503), the postcode-structure arc's remaining slices (#1481 —
continues on its own preregistered bars), and the **coverage-vs-settlement-prior metric** (the
Geovation map-holes idea, 2026-08-05: join the fog-of-war overlay's observed density against a
WorldPop/GRID3 habitability prior — predicted-minus-observed is the coverage gap as a real number.
Post-v9 eval artifact; check WorldPop/GRID3 before building anything; absence-of-evidence register
rules apply).

---

## §9 — Handoff state, 2026-08-07

### In flight, UNCOMMITTED on `fix/1519-trailing-dot`

A house-tooling cleanup: **every `unzip` subprocess in corpus + scripts is gone**, replaced by
streaming zip readers. Compiles clean, `yarn lint:oxlint` clean, 1199 tests pass across `corpus/` +
`core/`.

What moved:

- **`core/fs/zip.ts`** gains `readZipEntry` / `listZipEntries` / `extractZipEntry` on `yauzl-promise`
  (already a direct dependency of `bdc` and `mailwoman`, already used by `codepoint/extract.ts`).
  The existing adm-zip `extractZip` / `extractSingleFileZip` stay — they are correct for a buffer a
  client already downloaded (`bdc/sdk/download.ts`), and wrong for anything on disk, because adm-zip
  is `fs.readFileSync(input)` (`adm-zip.js:72`) plus the decompressed member.
- **Measured, on the real `europe.zip`:** ZIP64 EOCD present, 454 entries listed in 19 ms, largest
  member `fr/countrywide.csv` 2.33 GiB unpacked streamed in 8.6 s at **peak RSS 103 MiB**. adm-zip
  would need ~5 GB resident for the same read.
- **`scripts/eval/build-oa-coord-golden.ts`** — 190 lines of hand-rolled central-directory walk
  deleted. Output verified **byte-identical** (`f29ef5b037ac3bc976413187f97dc9ac`, 150 IT rows).
- **`corpus/src/shard-recipes/scaffold.ts`** — `readCSVRecords` now takes a stream and returns
  spliterator's `AsyncSequence` rather than wrapping it in an `async function*` (the wrapper is a
  documented 2.3× regression and it hid `take`/`drop` from every caller). `readZippedCSVRecords`
  composes it over a zip member and warns-and-yields-nothing for a source the checkout hasn't cached,
  which is what the `unzip -p` subprocesses did by accident.
- **Nine recipe call sites migrated** across german / unit / intersection / country-balanced /
  street-affix / fr-order / po-box-cedex / locale, plus `nppes.ts` and `imls-pls.ts`.
- **`country-balanced` output verified byte-identical** (`12331a769d1e12af8bdf30b8c2b04395`, 400
  rows) — this is the only recipe whose sources this lab has cached, and it covers the riskiest
  change (dropping the `head -n` line cap, which is now redundant because the `limit` break closes
  the reader).

### What a fresh agent must check before trusting the recipe migration

1. **`readFrTuples` (po-box-cedex) and `readCaLocalities`** translate `awk` pre-filters into
   spliterator ops. The FR one reproduces `awk 'NR==1 || NR%211==3'` — a PHYSICAL-line stride that
   selects which rows land in the shard, so `skipEmpty: false` and quote handling OFF are both
   load-bearing. **Neither is verified**: `fr__countrywide.zip` and the GeoNames CA dump are not
   cached on this host. Fetch them (`results.openaddresses.io/latest/run/fr/countrywide.zip`,
   anonymous) and diff a shard before/after.
2. **`street-affix`, `german`, `unit`, `intersection`, `po-box-cedex` US** could not be run here
   either — their `us__*` / `de__*` sources are absent. Those are pure buffered→streamed swaps with
   no windowing, so identity follows from same-bytes-same-parser, but it is argued rather than
   measured. The seven `us__*` sources total ~117 MB.

### Remaining `unzip` population — NOT touched

Four calls survive, all in TIGER/situs, and they are different operations rather than oversights:
`mailwoman/commands/situs/interpolation.tsx:342` (glob multi-extract `*.shp *.dbf *.prj *.shx`),
`tiger/sdk/redistricting.ts:151` and `tiger/sdk/fetch.ts:273` (whole-archive extract), and
`tiger/sdk/download.ts:55` (`unzip -tq` — a CRC **integrity test**, not an extraction). The first
three want an `extractZipEntries(archive, dest, filter?)` addition to `core/fs/zip.ts`; the fourth
wants yauzl's `validateCrc32`.

### The rest of the open list

Beyond this file's sections, the standing items are the gazetteer rebuild (`admin-global-priority.db`
→ `candidate.db`, which several merged changes sit inert behind), PIX1 whole-edge (preregistered at
`docs/superpowers/plans/2026-08-04-pix1-whole-edge-preregistration.md`, gated on that rebuild), the
three named parse defects (Springfield IL / London ON / `brooklyn, new york, ny` — diagnosed as
training-shaped, not decode-shaped), and postcode-country coherence by geometry, which may now
overlap the PFX1 work that landed in #1551.
