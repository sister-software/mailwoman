# Mailwoman — The Road to v8

**Status:** living draft · **Opened:** 2026-07-24 · **From:** 7.8.1 / bundle 6.6.3 / model bytes v385
**Last progress update:** 2026-07-24 PM — Tier-1 batch merged ([#1303](https://github.com/sister-software/mailwoman/pull/1303), [#1304](https://github.com/sister-software/mailwoman/pull/1304)); see the progress log at the bottom.
**Perspective:** written at the close of the placetype-pair arc (#1268–#1300), the week the
decode-time evidence layer became the project's capability engine. This doc organizes the open
backlog into a major-release shape; it is a map, not a commitment — items move by pre-registered
gate results, not by enthusiasm. Supersedes nothing; subordinate to
[`docs/articles/plan/SCOPE.mdx`](docs/articles/plan/SCOPE.mdx) (the standing scope declaration).

## §1 What a major means here

Package version, bundle version, and model bytes are three clocks, and v8 is only about the first:

- **Package version** (today 7.8.1) — the code. A major is the vehicle for the **version-gated
  breaking batch**: changes that are correct but break consumers, held until a major so they land
  once, together, loudly. Precedent: v7.0.0 removed the `./sdk/cli` + `./sdk/test` subpath shims.
- **Bundle version** (today 6.6.3) — model + artifact bytes, tracked by the model cards. Moves on
  its own cadence; a package major does not imply a bundle major.
- **Model bytes** (still v385) — the neural net itself. v7's lesson: an entire week of capability
  growth (GB dep-loc live, comma-free recovery, NZ country two, postcode repair) shipped with the
  model untouched. The model is one lever among several, no longer the load-bearing one.

A major that ships only renames is a wasted major; a major that waits for every epic never ships.
v8.0.0 cuts when the breaking batch is staged **and** the sharding skeleton (Track B) is real.
Everything else lands across v8.x minors — new locales and new evidence artifacts are additive by
construction (the en-gb/en-nz overlays proved a whole country ships in a minor).

## §2 The v8 thesis

v7 proved the architecture's center of gravity moved: **calibrated, retrieval-augmented,
decode-time evidence** (pair-index δ, transition-β, probe chains, per-country artifact headers)
out-performed every training-side recipe the arc tried, at zero GPU cost, with byte-stability
proofs training can never offer. v8 formalizes that layer — one sharded artifact family, one
calibration runbook, one composed-config board — and spends the major's disruption budget on the
two things minors can't do: the breaking batch, and the skeleton every future locale hangs on.

## §3 The tracks

### A. The breaking-change batch (the reason the major exists)

Version-gated, mechanical, pre-staged — each item lands behind the v8 branch, none dribbles into
a minor:

- **#875 — the acronym batch.** `isUsStateAbbreviation` → `…US…` (public `@mailwoman/codex` —
  breaking) plus the whole `Json`/`Jsonl` family (~28 identifiers, some public). Per AGENTS.md:
  bundle with the next major, never half-apply — a partial sweep splits callers from their defs.
- **#1096 — `variant-aliases` has zero runtime importers.** Wire it into the pipeline or remove
  the workspace; a major is the only honest time to delete a published package.
- **#1094 — libpostal house/near/category excision revisit.** Check golden-gate traffic; if the
  excised labels stayed silent, drop the compat surface for real.
- **Audit pass before cut:** every workspace's `exports` dev-map vs. published subpaths, any
  deprecated `ParseOpts` fields, `#1108`'s silent legacy-rule fallback (the fallback itself may be
  a breaking removal — decide deliberately, don't let it ride along).

**Gate:** the batch is one PR train with a migration note per item; the publish guard and
tarball verification run unchanged. No behavioral gate — behavior must not move in this track.

### B. Weights sharding — the skeleton (epic #1177)

The en-gb/en-nz overlays are the working prototype: a base model + per-country evidence artifacts
(`pair-index-<cc>.bin`), country-gated at load, versioned in lockstep. v8 formalizes the pattern:

- **base-latn + overlays:** dedupe the per-locale weight packages onto one base Latin model with
  per-country overlay bundles. The overlay mechanism is shipped and battle-tested; the work is
  packaging, card schema, and release-train wiring (the lockstep freshness guards generalize).
- **Script-routed shards:** the non-Latin future (Track C) hangs off this — the shard router
  decides by script, not by locale guess.
- **The calibration runbook, written down.** A new country today needs: pair-index build
  (`gazetteer pair-index`, per-country self-check probes — #1283's lesson), δ-sweep, β decision,
  venue-confound + golden boards, comma-drop metamorphic, invariance vs the shipped baseline,
  card + ledger rows. This exists as tribal knowledge in `task-8-report.md`; v8 makes it a
  first-class doc (CONTRIBUTING_MODEL_WORK is the home) so country N+1 is a recipe, not an arc.

**Gate:** one existing overlay country re-cut onto the sharded layout with byte-identical parse
output on its golden boards; release train publishes the sharded family green.

### C. The non-Latin threshold (epic #1176, #1266)

The biggest capability frontier, deliberately last in the cut criteria — it rides v8.x minors:

- **#1266 — CJK name-fold** for the gazetteer: suffix-stripping + small-edit tolerance. The
  evidence layer's folded-key contract (`normalizeFSTToken`) assumes Latin-ish tokenization; the
  fold is locale-aware or the whole retrieval layer is blind.
- **#1176 — JP/KR first, then CN/TW.** CharCNN path (scaffolding committed, deferred — see
  SCOPE's standing locale rule), not vocab splicing; the #900 codepoint-overlap gate applies to
  any splice.
- **#294/#295/#296/#473 — TW/JP resolution chain** (段/巷/弄/號 coarse resolution, locator[]
  corpus + schema tag, TW postcode→admin table + JP eval gold). JP is already tier-5
  resolver-route; this is the path to a parse claim.
- **The evidence layer is the entry wedge:** a JP pair-index (chōme/block under municipality)
  needs no model change to start producing value — the GB/NZ recipe applies the day the fold
  exists. Sequence: fold → gazetteer artifacts → eval gold → then training exposure.

**Gate (per locale):** the SCOPE tier rules unchanged — a locale is claimed only when a
coordinate-graded eval exists for it.

### D. Evidence-layer consolidation

The arc shipped three mechanisms (δ emission bias, β transition bonus, probe chains) and banked
or deferred four more. v8 is where the layer gets its second index family and its data-derived
hygiene:

- **#1288 — street-pair prior probe** (street, locality) evidence for non-US parse recall. The
  second index family; the design question is what the GB venue-confound arc taught: candidate
  geometry first, calibration second.
- **#1296 — register-derived suppression lists.** `STRUCTURAL_MARKER_WORDS` and
  `TITLE_PREPOSITION_PREDECESSORS` are hand lists with rationale lines; derive both from venue
  registers + street corpora (on disk). This is the standing defense against marker-list
  treadmill — **lands before any third hand list grows.**
- **The measured contingencies, on measured need only:** Q3 per-pair specificity tiers (PIX1
  schemaVersion-2) and the Q4 fail-open child-side street veto. Both pre-designed, both
  deliberately unbuilt — trigger: adversarial dep-loc FP becomes production pain, or a new
  country's FP anatomy demands them.
- **#1267 — learned-embedding retrieval probe** as fuzzy fallback beside FTS trigram. Research
  probe; the bar is beating the trigram index on the same boards.
- **Banked levers (reopen triggers named):** the #1287 venue-probe composition synergy
  (dep-loc venue FP 217→109/6500 composed — precision, not recall; needs multi-index plumbing);
  span-scoped (not just entry-scoped) transition adjustments, if a measured miss class ever
  points there.
- **#1142 — gazetteer importance is ~82% unknown-as-zero; the shipped FST is 6 weeks stale.** The
  evidence layer is only as good as its reference data; freshness belongs in the same track as
  the mechanisms that consume it (#997 provenance, #1010 WOF bundle publish are siblings).

**Gate:** each item carries its own pre-registered board bars, per the arc's discipline. No
mechanism ships on a synthetic win alone (the #1287 lesson: held-out generality or don't build).

### E. Training-side convergence

The training track is not dead — it is unblocked-by-design (no longer on the critical path for
locale capability) and re-scoped to what only training can fix:

- **#1102 — the promote blocker:** fragment/twin training mass erodes US region+locality recall
  ~2.5pp. Any new base model gates on this.
- **#1101 — punctuation-drop augmentation, corpus-wide.** The training-side answer to the
  comma-robustness the pair prior solved decode-side. The arc's data says the two compose (prior
  covers pair-evidenced dep-locs; augmentation covers everything else) — measure the composition,
  don't assume it.
- **#1104 — country recall −6.6pp on fragment-campaign candidates** (shard-v5 corpus, not the
  tokenizer).
- **#1247 / #1248 — corpus-python hygiene:** ~~12 stale STAGE2-era tests; `_merge` strict mode so
  unknown YAML keys fail loudly (a silent-drop config bug is how arcs die).~~ **DONE 2026-07-24
  ([#1303](https://github.com/sister-software/mailwoman/pull/1303))** — suite 12 failed → 0 failed / 611
  passed; `_merge`/`load_config` strict-by-default (dotted path + file in the raise, `strict=False`
  escape hatch, Modal launch path wired); the pre-requisite audit measured **149 configs, zero junk
  keys → no grandfathering**, dated configs untouched.
- **Model-side redesign research** (unhurried, per the arc's close-out): the dead-tag /
  classifier-equilibrium findings (cRT falsified, re-burial = equilibrium not drift) are the
  design inputs; any v8-era base model starts from that report, not from intuition.
- **#486 standing policy, restated for the new layer:** repair passes shrink at each
  consolidation. The calibrated evidence priors are architecture, not scaffolding — but each
  prior carries a re-measurement obligation: when a future base model internalizes what a prior
  provides (e.g. #1101's comma robustness), the prior's δ/β get re-calibrated DOWN, not left
  stacked. Priors compose with the model; they do not accrete over it.

### F. Correctness gates (a major should not ship with these open)

- **#1143 — "the house number is the licence":** bare streets parse as localities. **Re-anchored
  2026-07-25: the 0.925 → 0.215 figure is STALE — current is ~0.605 on shipped v385 (official
  fragment-board), 0.777 on the v3101 candidate; training has been closing it.** The street-name
  pair prior is falsified (#1288, open-vocab wall); the leading-designator suffix prior's target
  class was eaten by training progression and its measured headroom (~0) on v3101 removed the
  case for a decode patch. **DECIDED 2026-07-26: waived-with-owner+board — GitHub #1143 CLOSED as
  not-planned; owner: training (#1102); board: the `bare-street` class of `ban-fragments-fr.jsonl`,
  re-scored per candidate. The 37-row token-grab residual is the #1315 gate's class — live in
  production via #1318 (per-locale FST distribution, default-on).**
- **#1108 — CLI silent fallback to the legacy rule parser when weights are missing** (see Track
  A — removal or loudness, decided deliberately).
- **#1058 — street-tier decoration: city field carries the street's first token.** **DONE 2026-07-24
  ([#1304](https://github.com/sister-software/mailwoman/pull/1304))** — root cause was span-rescore
  injecting the street's first token ('Rue' → commune Rue, Somme) as a speculative locality against
  the register's strictly stronger (street, commune) match; `applyStreetCentroid` now stamps
  `street_locality` and drops contradicting span-rescored nodes.
- **#1041 — photon address_point results decorated as type:city.** **CLOSED 2026-07-24
  ([#1304](https://github.com/sister-software/mailwoman/pull/1304))** — the fix had already shipped in
  385c2fce (#1043); the issue never closed. The `/reverse`-parity checkbox proved structurally moot
  (the `DESCENT_TIERS` ladder caps at microhood — reverse can never return an address point); the one
  real gap, a microhood-deepest result falling through to the `place/yes/other` default, got the
  missing projection row + a contract test pinning every descent tier.
- **#1056 — eval `--gate` shorthand ENOENT.** **DONE 2026-07-24 ([#1304](https://github.com/sister-software/mailwoman/pull/1304))** —
  root cause was the _tarball_, not the resolver: tsc doesn't emit `readFileSync`'d JSON, so gate
  specs never shipped; `files` now covers them, glob-pinned by a regression test. (Moved here from
  the eval-harness bucket — it was a correctness bug in the shipped artifact.)

### G. Surfaces, verticals, and the demo

- **#1214 (OPEN PR) — BDC broadband-plausibility vertical spec.** Design-only, do-not-merge,
  awaiting operator review; eight open questions for operator/counsel. Its doctrine is already
  house style (positive-evidence-only, `coverage_confidence` mandatory — the pair-prior arc's
  rules generalized to a new domain). Review decision is the immediate next action.
- **#1278 — demo repoint + neural-web phase 2.** Phase 1 (browser pair-prior wiring) shipped in
  #1300. Invariant 2 (the demo is the geocoder) makes the repoint a release-train obligation,
  not a decision that keeps deferring — defaultVersion has trailed the shipped bundle since
  6.6.0; it is now three bundles behind. **Proposed: the repoint lands with v8.0.0 at the
  latest, and the release train gains a bundle-vs-demo drift gate so it cannot recur.**
- **#1070 — mailwoman-python** (in-process parse + resolve over the same sealed artifacts).
  The sealed-artifact architecture makes this a port of readers, not a re-train.
- **Record-matching workstream** (#598/#602/#603/#655 epics) — first-class per SCOPE; no v8
  gate, runs its own cadence.
- **osm publish** — still blocked on ODbL counsel sign-off (`osm/README.md`); a v8.x candidate
  the day counsel clears.

## §4 Cut criteria for v8.0.0

Tag when ALL of these hold:

1. **Track A complete** — the breaking batch landed as one documented train, migration notes
   written, `#875` swept whole.
2. **Track B skeleton real** — base + overlay sharding shipped for at least one existing overlay
   country, byte-identical on its golden boards; the country-onboarding runbook committed.
3. **Track F clean** — #1143 waived-with-owner+board (training #1102, `bare-street` class; GitHub #1143
   CLOSED 2026-07-26). #1058/#1041/#1056 all closed 2026-07-24. **SATISFIED.**
4. **FST/comma-free arc delivered (2026-07-25):** #1315 (street-context gate, inert-by-default), #1317
   (trailing-locality prior, **opt-in only** — the comma-free decode path is a dead-end per the #1288
   open-vocab wall; routes to #1102 training), #1318 (per-locale FST distribution, **default-on** with
   a dated bar revision that retires at the next model promotion — tracked via #1320).
5. **The standing gates green** — golden us/fr byte-stable across the train, invariance zero new
   classes, gauntlet, presets; the publish guard + tarball md5 verification unmodified.

Explicitly NOT gating v8.0.0: any Track C locale claim (rides minors), Track D mechanisms beyond
the runbook (each gates itself), Track E base models (gates on #1102 whenever they arrive),
record-matching epics, BDC implementation (spec review gates Phase 2a only).

## §5 Invariants carried into v8

The SCOPE standing invariants hold unchanged; the pair-prior arc adds five, earned with receipts:

6. **Per-country calibration lives in artifact headers, never in code defaults** — δ and β ride
   PIX1; a code-side constant is a smell (the `DEFAULT_DELTA` fallback is defensive-only).
7. **Measure in the shipped configuration.** Two "drift" scares (GB comma-free 50→55, en-nz FP
   0.862%→1.354%) were both measurement-context artifacts. Evals grade the user's path: real
   cache, real country gate, real anchor channel.
8. **Candidate geometry before calibration.** The venue-confound war was won by restricting
   WHERE pairs may fire (segment fusion, anchored adjacency), not by tuning magnitudes. δ moves
   recall and FP together; geometry separates them.
9. **Hand-curated lexical lists carry per-entry rationales and a data-derivation ticket.** Two
   exist (marker words, title prepositions); #1296 is their shared long-term.
10. **A falsified premise closes; side-effects don't rescue it.** The #1287 venue probe's
    composition synergy was real and was banked, not built — the trigger to reopen is named in
    its close-out.

## §6 Open decisions register

| Decision                                 | State                                                                                                                         | Where it lives     |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| BDC spec approval (#1214)                | **awaiting operator review — the immediate action**                                                                           | open PR            |
| Demo repoint / bundle-drift gate (#1278) | proposed for v8.0.0 at latest                                                                                                 | §3-G               |
| `#1108` fallback: remove vs. make loud   | **RESOLVED 2026-07-26: KEEP (loud, not removed)** — npx quick-demos must keep working; #1322 over-removed it and was reverted | parse.tsx          |
| Q3 specificity tiers / Q4 street veto    | contingencies, measured-need triggers named                                                                                   | §3-D               |
| osm npm publish                          | blocked on ODbL counsel                                                                                                       | `osm/README.md`    |
| Model-side base redesign                 | unhurried research; inputs = classifier-equilibrium reports                                                                   | §3-E               |
| KR locale path                           | no adopted open data path                                                                                                     | SCOPE blocked tier |

## Progress log

- **2026-07-24 (PM) — Tier-1 worktree batch merged.** Two parallel worktrees, two draft PRs,
  reviewed and merged same-day: [#1303](https://github.com/sister-software/mailwoman/pull/1303)
  (Track E: #1247 + #1248) and [#1304](https://github.com/sister-software/mailwoman/pull/1304)
  (Track F: #1056 + #1058 + #1041). Process notes: the subagent leg needed one manual takeover
  (decoration trio finished in-session after a stall); the worktree discipline itself — branch per
  batch, `yarn install` per worktree per #1123, draft PR with `Closes #…` refs — held. Next
  candidates from the tier-2 list: #1296 (register-derived suppression lists), #1266 (CJK fold),
  #1288 (street-pair prior).

---

_Maintenance: this doc moves when reality moves (SCOPE's rule applied to itself). Each v8.x
minor updates the track statuses; the cut criteria are revised only in writing, attributed,
operator-approved — same rule as every gate in the project._
