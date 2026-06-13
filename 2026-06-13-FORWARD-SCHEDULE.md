# Forward schedule — the parser→geocoder pivot (sketched 2026-06-13, mid-shift)

_Drafted while v1.5.1-fr-order trains. The premise: DeepSeek's supplemental session drained the
low-hanging Phase-0 hygiene (issues #481/#379/#523/#552 + prettier). What's left is the substantive
arc — and it's where the scoreboard changes from "does the parser match v0" to "does the geocoder
return the right coordinate." This doc grounds the next few nights in the #488 daily queue, pointed
at the north star: a production geocoder that beats Pelias Parser's rules with no Elasticsearch._

## Where the line is

The #488 epic splits cleanly at the Phase-2/Phase-3 boundary:

- **Phase 2 — parity completion** is the table we've lived in all arc. fr.house_number is its *last
  empty cell*: v4.5.0 retired the span bridge (proving po_box and friends are learned intrinsically),
  and fr.house_number was the one tag the bridge had been propping. v1.5.1 settles it — pass → the
  parity table is full; documented-floor → we ship the honest intrinsic number and move on. Either
  way, **after tonight the parity scoreboard is closed.**
- **Phase 3 — geocoder table stakes** is coordinate truth: house-number interpolation, reverse
  geocoding, autocomplete, the postal-city alias surface. This is where "parser" becomes "geocoder."

The strategic point for the operator's $10/night question: **parity work is mostly behind us; the
remaining spend should buy coordinate truth, not more per-tag parser polish.** Order-robustness (the
v1.5.x thread) was the last parser capability worth a training run for a while.

## Topmost-unblocked, in leverage order

Grabbing the #488 rule (topmost unchecked, unblocked), with what the supplemental session cleared:

### Tier 1 — unblocked NOW, no GPU, highest leverage

1. **#483 — house-number interpolation from TIGER ranges** (gated on #476, which is DONE: VT
   prototype hit coord p50/p90 → 0/0 km @ 93.1% hits). This is *the* Phase-3 opener: turn TIGER's
   per-segment address ranges into an interpolated point for any house number, lifting us from
   admin-centroid coordinates (tens of km) to sub-km street-level truth. Pure data+code, CPU-bound,
   no training. **Recommended next centerpiece.**
2. **#484 — reverse geocoding (PIP over wof-polygons)** — the symmetric tree API: coordinate → admin
   hierarchy. We already ship `wof-polygons.db` (DP-simplified boundaries) for the demo outline; this
   reuses it. Bounded, testable, no GPU.
3. **The arena-gate infra fix** (found + fixed THIS shift — see "Gate integrity" below): a
   pre-registered floor (`arena.perturb` 71.0) was un-evaluable on every v0.5.0 gate run because the
   compiled-tree libpostal path doesn't resolve, so it hard-failed as `NOT FOUND` — masking the real
   number (measured this shift: **78%, a clean pass**). Cheap, high-trust-value, makes the verdict honest.

### Tier 2 — unblocked, feeds a *future* training run (build now, train later — no GPU tonight)

4. **#330 — FR venue/region shard** (+ #444 street-collapse + accent fragmentation) — the FR parity
   gap beyond house_number. Builds the same way the order shard did; rides into the next training run.
5. **#435 — European street/number composition quirks** (number-after-street) — *this is the
   generalization of the v1.5.x order work.* If v1.5.1 validates the both-order recipe, #435 extends
   it to IT/ES/NL. Build the shards now; they cost nothing until trained.
6. **#487 — intersection reintroduction** (gate pre-registered in-issue).

### Tier 3 — the parity capstone (orchestrator-judgment, multi-night)

7. **#478 — arbitration layer** ("pipeline ≥ v0 by construction") — the single highest-leverage
   Phase-2 item, now that its #481 reconcile-half dependency is largely cleared. Wires the policy
   registry + reconcile + abstention. Too big for a clean Sonnet contract; this is a future
   centerpiece, not a fan-out task.

## How tonight's remaining hours go (post-v1.5.1-gate)

The budget rule is set: **no second training run tonight.** So the remaining runway is CPU/local work:

1. **v1.5.1 re-gate** when `ap-1PoHJlr1GfFwoeoJgzO0up` stops (~07:00 UTC) — the decision point.
   - Pass (fr.house_number ≥95, floors hold) → v4.6.0 candidate → stage the four-store ship, flag operator.
   - Miss → document 87.4% (v1.5.0) / new number as the honest intrinsic floor; the lever for a
     *future* run is shard mass (50K→100K), not weight. File the convergence-curve issue. Do NOT
     re-train tonight.
2. **Land the arena-gate fix** (Tier-1 #3) — make `arena.perturb` enforce again. Verified, committed.
3. **Open #483** (Tier-1 #1) as the next centerpiece — scope it, write the TIGER-range interpolation
   plan, maybe land the first slice. This is the cleanest "real geocoder" forward step and needs no GPU.

## Gate integrity finding (this shift)

`arena.perturb` (floor 71.0, inherited verbatim from v4.4.0) reported **NOT FOUND** on the v1.5.0
gate. Root cause: the arena harness runs the **compiled** v0 (Pelias) parser, whose libpostal
dictionary path resolves to `core/out/data/libpostal/dictionaries` — which doesn't exist (the data
lives at `core/data/...`). `core/utils/repo.ts`'s `__isCompiledTree` flag evaluates FALSE in the
compiled tree, so `CorePackageAbsolutePath` lands at `core/out` instead of the documented `core/`.
Every v0 arena assertion then ENOENT'd → 0 assertions → the floor silently un-enforced.

- **Safe local unblock applied:** symlink `core/out/data → ../data` (core/out is gitignored build
  output; reversible, no infra change). The v0 parser then loads and the arena produces real numbers.
- **The deeper question — is `__isCompiledTree`'s detection itself off-by-one-`..`?** — is a change to
  load-bearing path infra (AGENTS.md flags it explicitly). That deserves daylight review, not a 4am
  patch. Options: (a) fix the detection to match the documented intent (compiled→`core/`), or (b)
  make the build copy/symlink `core/data`→`core/out/data` as a sanctioned step. Flag for operator +
  DeepSeek. Tracking: fold into #481 (parser hardening) or a new issue.

## Out of scope / parked

- corpus-v0.5.1 **code-point re-align** (#558) — DeepSeek's parallel track.
- A second training run tonight — budget rule.
- Any schema change (#456 unit split), resolver-DB swap, or product ruling — operator's call.
