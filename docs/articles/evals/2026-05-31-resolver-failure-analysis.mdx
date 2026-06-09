---
title: "Resolver failure analysis — OpenAddresses real-point eval (v0.7.2 neural vs v0/Pelias)"
date: 2026-05-31
status: analysis (read-only) — scopes the next resolver-depth PRs
---

# Resolver failure analysis (v0.7.2, 1500 OA real points)

Read-only triage of where the **resolver** misses, run while the v0.8.1 MLM arms trained.
Method: `scripts/eval/oa-resolver-eval.ts --limit 1500 --errors-json` (new flag, this branch)
scores the real v0.7.2 neural parser AND v0/Pelias through the same WOF resolver on real
OpenAddresses points, and dumps every row where either parser missed locality, carrying each
parser's **resolved admin name** so a miss can be bucketed as resolve-wrong vs unresolved.

## Headline

| parser      | locality-match | region-match | resolved |
| ----------- | -------------: | -----------: | -------: |
| **neural**  |      **94.9%** |        99.9% |   100.0% |
| v0 (Pelias) |          93.7% |        99.4% |    99.7% |

**Neural beats v0/Pelias on real points** (+1.2pp locality) — the north-star claim, on an
honest non-circular signal. 101 rows had a miss from one or both parsers.

## Where neural's 76 locality-misses actually go

| bucket                    |  count | what it is                                                                  |
| ------------------------- | -----: | --------------------------------------------------------------------------- |
| **(A) name-form variant** | **40** | resolver found the RIGHT place; the eval's name-matcher rejects the form    |
| (B) genuinely wrong place |     13 | resolved to a real but incorrect admin — the resolver-disambiguation target |
| (C) no locality resolved  |     23 | parser mis-segment, `<Null>` tokens, or WOF coverage gap                    |

> **If bucket (A) were credited, neural locality on these 1500 rows is ≈97.6%, not 94.9%.**
> And several of (B) are _also_ name-form (`Mt Pleasant`→`Mount Pleasant`, `Mc Laughlin`→
> `McLaughlin`, `Enosburgh`→`Enosburg Center`), so true locality accuracy is ~97–98%.

The eval has been _underselling_ the resolver. Examples from (A): `Butte`→`Butte-Silver Bow`
(consolidated city-county — WOF's canonical name), `Saint Johnsbury`→`St. Johnsbury`,
`Derby`→`Derby Center`, `Monroe Twp`→`Monroe`, `Barre City`→`Barre`.

## Recommended next PRs, ranked by ROI

1. **Eval name-match fidelity (HIGH ROI) — ✅ SHIPPED IN THIS PR.** Match OA's expected name
   against the resolved place's full WOF **`names` altname set** (normalized), not a single
   canonical string, plus a tight abbreviation layer (St→Saint, Mt→Mount, Ft→Fort, Mc-despace,
   diacritics/punct). Deliberately **no civic-suffix stripping** — `Barre City` and `Barre Town`
   are distinct VT municipalities. This is _correctness_, not gaming: WOF records these as the
   same place.

   **Result (1500 OA rows, real v0.7.2):**

   | parser      | locality BEFORE | locality AFTER |    Δ |
   | ----------- | --------------: | -------------: | ---: |
   | **neural**  |           94.9% |      **97.1%** | +2.2 |
   | v0 (Pelias) |           93.7% |          95.3% | +1.6 |

   Both parsers rise (the matcher is parser-agnostic), and neural's lead over Pelias **widens
   to +1.8pp**. 32 neural misses credited — all legitimate (`Saint↔St. Johnsbury`,
   `Mt↔Mount Pleasant`, `Butte↔Butte-Silver Bow`, `Rutland City↔Rutland`). **Guard verified:**
   all 4 `Saint Albans → St. Johnsbury` genuine errors still fail (0 wrongly credited) — the
   matcher trusts disjoint WOF ids, so real ranking bugs stay visible for PR #2.

2. **Resolver disambiguation — the `Saint Albans Town/City → St. Johnsbury` cluster (4 rows).**
   A genuine ranking bug: for "Saint Albans, VT" the resolver picks the wrong VT town. Check
   whether this is name-collision handling or the population/importance tiebreak (must stay
   ALIGNED with the population/importance ranking used elsewhere — or document why it differs
   here). This is real resolver-depth work, small but clear.

3. **Neural parser robustness (feeds the retrain/MLM track, not the resolver).** Two concrete
   patterns from (C):
   - **`<Null>` literal tokens** in OA input (`21695 <Null> 210TH STREET, Holland, IA`) →
     neural fails to parse; v0 survives. Input sanitization and/or a corpus augmentation.
   - **DC directional quadrant** (`6th Street Ne, Washington` → neural tags `Ne Smith` as
     locality) and **multi-word locality truncation** (`Belle Fourche`→`Belle`, `Fort Pierre`
     →`Fort`, SD). Corpus-augmentation candidates for the next train.

4. **WOF coverage (lowest priority, after (1)).** A handful of tiny localities resolve to
   nothing (`Pennco`, `Dakota Dunes`, `Essex Junction Village SD/VT`). Extend the custom
   `admin-global-priority.db` build rather than chasing these individually.

## Geography of failures

VT 39, IA 26, SD 14, MT 11, IL 7, DC 3, CA 1 — concentrated in rural/township-heavy states
with many small villages and Saint-/Mount-/township name variants. This is consistent with
(A) dominating: the failures cluster exactly where canonical-name forms diverge most, not
where the resolver is structurally weak.

## Where neural already wins (bucket: v0-only failures, 25 rows)

v0/Pelias returns _no locality_ for many that neural gets right: `Des Moines`, `Des Plaines`
(v0 mishandles the `Des` token), `Chicago`, `Georgia, VT` (v0 confuses the locality with the
state), `Moretown`. These are the cases the neural parser exists to win — and does.
