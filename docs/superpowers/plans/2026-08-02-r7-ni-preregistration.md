# R7 — the Northern Ireland increment

Hierarchy campaign R7, opened 2026-08-02. NI has been the GB side's open gap since R3, deferred
then because "the pair parent needs post towns — an outcode→post-town table is the missing piece."

## The blocker dissolved, and it is worth saying why

The post-town framing came from the GB source: PPD's parent column IS the post town, so an NI
extension seemed to require the same field for NI, which Royal Mail licenses rather than publishes.
But R5 established that the parent side does not have to come from a postal register at all — the US
instance takes WOF localities as parents and passes every bar. Applying that here: WOF's NI
neighbourhoods hang off **Belfast, Newtownabbey, Londonderry, Lisburn** — localities that ARE the
post towns for those addresses. No licensed table needed; the deferral was reasoning from GB's
source shape rather than from what the pair actually requires.

Survey: **84 (child, parent) pairs**, every one a neighbourhood, under 4 parents (Belfast 75,
Newtownabbey 4, Londonderry/Derry 3, Lisburn 2). Fold-collision audit against the shipped GB index:
**0/84 already resolve — all 84 are fresh.**

## Two data-shape findings, handled explicitly rather than absorbed

1. **`"Londonderry / Derry"` is a single WOF surface.** It folds to one key that matches neither
   "Londonderry" nor "Derry", so those 3 pairs would ship dead — present in the artifact, incapable
   of firing. A slash-separated WOF parent is an ALIAS SET, not a name; the extraction emits one
   pair per alternative. This is the dual-naming convention the city carries politically, and the
   index has to accept whichever form the writer used.
2. **`"Lower Shenkill"` is a misspelling of Shankill** (the correctly-spelled "Upper Shankill" sits
   beside it in the same source). Harmless by construction — a wrong surface simply never matches
   real input — so it is recorded, not patched. Never edit a reference source in place; the fix
   belongs upstream.

## Pre-registered bars

- **B-R7.1 (no regression).** Full gauntlet + the GB boards, index rebuilt with the NI pairs. Bar:
  **zero newly-failing gated cases**, and the GB cross-check reproduces at its new expected total.
- **B-R7.2 (venue-confound floor).** A held-out NI confound board built from the **8 law-1
  directional** surfaces (East/North/South Belfast, Upper Malone, Upper/Lower Shankill, Lower
  Springfield, New Barnsley) plus a sample of the rest, each opening a venue name. These are the
  exact class that truncated "3rd Ave NE". Bar: **≤2%** dependent-locality false positives.
- **B-R7.3 (positive side).** The fresh pairs extract as `dependent_locality` in a real NI address
  shape (`<house> <street>, <neighbourhood>, Belfast, BT<n> <n><aa>`). Bar: **≥70% tag-correct** on
  a sampled positive board.
- **D-R7.4 (disclosure).** Report how many of the 84 survive the fold as distinct entries, and name
  any that collapse — an artifact whose count silently differs from its source's is how a fold bug
  hides.

## Ireland stays open, and the reason is not data

The Republic needs a **carrier package** (`en-IE`) before any artifact can reach it — the pair index
is hard-gated on the resolved locale's country, so an IE artifact inside en-GB would never fire.
That is a packaging decision plus the still-open licence survey (Tailte Éireann / logainm), not a
rung that can be executed off the shelf like this one.

## The readings

- **B-R7.1 PASS.** GB index rebuilds to **20,126** distinct pairs (19,209 PPD + 917 secondary = 15
  borough + 815 London + 87 NI), CROSS-CHECK PASS. Full gauntlet green with two new NI gated cases;
  neural + gazetteer-pipeline suites **600/600**.
- **B-R7.2 PASS.** 30-row NI confound board — all 8 law-1 directional surfaces (East/North/South
  Belfast, Upper Malone, Upper/Lower Shankill, Lower Springfield, New Barnsley) plus 22 others, each
  opening a venue name under its true parent: **0/30 dependent-locality false positives**.
- **B-R7.3 PASS.** 40-row positive board: **40/40 emit, 40/40 tag-correct (100%)**.
- **D-R7.4.** All **87/87** pairs survive the fold as distinct entries — the index total moved
  exactly 20,039 → 20,126, so nothing collapsed silently.

**The freshness guard fixed in R5 earned itself on its first real exercise.** Adding
`ni-pairs-v1.jsonl` as a fourth source made the guard report `header source md5s [3 entries] !=
current [4 entries] — rebuilding`. Under the old `sourceMD5s[0]`-only check this increment would
have shipped against a stale artifact, exactly as the London pairs silently did.

**One incident worth recording.** A verification run of `scripts/copy-weights.ts` (checking the
release path builds all three indexes) materialized a release-config `model.onnx` OVER the dev
symlink, and the next gauntlet run failed the #1024 model-card drift guard — materialized md5
`cb0527b5…` against the card's `c968c24a…`. Not an NI failure at all. `copy-weights` writes
RELEASE artifacts into the dev packages; re-run `link-dev-weights` after using it to verify the
release path, or the next gate reads the wrong model.

## Verdict

The NI increment ships. `data/gazetteer/ni-pairs-v1.jsonl` (87 pairs) joins the build as its own
source — `--pairs-jsonl` now takes a comma-separated LIST rather than a single file, so each source
keeps a distinct provenance md5 and the guard can tell which one moved. Ireland stays open on the
`en-IE` carrier package plus the licence survey.
